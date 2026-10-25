/**
 * Static output arrives from CI as one tarball, and not one byte of it is trusted.
 *
 * The upload is a PUT from GitHub Actions carrying the repo-scoped CI token. It is
 * written to a scratch file while being hashed, then *inspected* — entry count,
 * entry types, entry names, uncompressed size — before anything is extracted. A
 * tarball that fails any check is deleted and the deployment fails with the reason;
 * nothing lands outside `artifacts/<deployment id>/site`.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const ARTIFACT_LIMITS = {
  /** Compressed, on the wire. A static site that needs more is not a static site. */
  bytes: 100 * 1024 * 1024,
  entries: 20_000,
  /** Guard against a decompression bomb: a 100 MB tar.gz can expand enormously. */
  uncompressed: 1024 * 1024 * 1024,
} as const;

export interface ArtifactFailure {
  ok: false;
  code: string;
  message: string;
  status: 400 | 413 | 422;
}

export interface ArtifactSuccess {
  ok: true;
  /** Relative to DATA_DIR, as stored on the deployment row. */
  artifactPath: string;
  artifactBytes: number;
}

export type ArtifactResult = ArtifactSuccess | ArtifactFailure;

const failure = (
  code: string,
  message: string,
  status: ArtifactFailure['status'],
): ArtifactFailure => ({ ok: false, code, message, status });

export interface ArtifactPaths {
  dataDir: string;
  uploadsDir: string;
  artifactsDir: string;
}

/**
 * Streams the body to disk. The cap is enforced while reading, not after: a
 * declared length is a client's claim, and the hash is computed over what arrived.
 */
export async function writeUpload(
  body: ReadableStream<Uint8Array>,
  targetPath: string,
  limit = ARTIFACT_LIMITS.bytes,
): Promise<{ ok: true; bytes: number; sha256: string } | ArtifactFailure> {
  mkdirSync(join(targetPath, '..'), { recursive: true });
  const hash = createHash('sha256');
  const file = createWriteStream(targetPath);
  let bytes = 0;

  const reader = body.getReader();
  try {
    for (;;) {
      // Sequential by construction: a stream is read one chunk at a time.
      // eslint-disable-next-line no-await-in-loop -- a stream has exactly one reader
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        // eslint-disable-next-line no-await-in-loop -- the reader is being closed
        await reader.cancel().catch(() => {});
        file.destroy();
        rmSync(targetPath, { force: true });
        return failure('artifact_too_large', `Artifact exceeds the ${limit} byte limit`, 413);
      }
      hash.update(value);
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve, reject) => {
        file.write(value, (error) => (error ? reject(error) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    file.destroy();
    rmSync(targetPath, { force: true });
    return failure('artifact_write_failed', messageOf(error), 400);
  }

  if (bytes === 0) {
    rmSync(targetPath, { force: true });
    return failure('artifact_empty', 'Artifact is empty', 422);
  }

  return { ok: true, bytes, sha256: hash.digest('hex') };
}

interface Entry {
  name: string;
  size: number;
  /** `-` regular file, `d` directory, `l` symlink, … */
  type: string;
}

/**
 * GNU tar's verbose listing. Anything that does not match is rejected: a format we
 * cannot read is a tarball we do not extract.
 */
const LIST_LINE =
  /^([a-zA-Z-])([rwxst-]{9})\s+(.+?)\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s(.*)$/;

export function parseListing(stdout: string): Entry[] | null {
  const entries: Entry[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = LIST_LINE.exec(line);
    if (!match) return null;
    // 1 type, 2 permissions, 3 owner/group, 4 size, 5 name.
    entries.push({ type: match[1]!, size: Number(match[4]), name: match[5]! });
  }

  return entries;
}

const SAFE_NAME = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/;

/** Every reason a name may not be extracted, cheapest first. */
export function unsafeName(name: string): string | null {
  if (!SAFE_NAME.test(name)) return 'absolute or parent-relative path';
  if (name.includes('\\')) return 'backslash in path';
  if (name.length > 512) return 'path longer than 512 characters';
  return null;
}

export interface ExtractInput extends ArtifactPaths {
  deploymentId: string;
  tarballPath: string;
}

/**
 * Validates, then extracts. Extraction only happens after every entry has been
 * accepted, so a tarball with a hostile entry leaves nothing half-written.
 */
export function extractArtifact(input: ExtractInput): ArtifactResult {
  const listed = spawnSync('tar', ['-tvzf', input.tarballPath, '--numeric-owner'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (listed.status !== 0) {
    return failure(
      'artifact_unreadable',
      `Tar could not read the artifact: ${(listed.stderr || '').trim().slice(0, 200)}`,
      422,
    );
  }

  const entries = parseListing(listed.stdout);
  if (!entries) {
    // Rejected rather than guessed at: an unparsable listing is one we cannot
    // promise anything about.
    return failure('artifact_unreadable', 'Tar listing was not in a format nodock can read', 422);
  }

  if (entries.length === 0) return failure('artifact_empty', 'Artifact contains no files', 422);
  if (entries.length > ARTIFACT_LIMITS.entries) {
    return failure(
      'artifact_too_many_entries',
      `Artifact has ${entries.length} entries, the limit is ${ARTIFACT_LIMITS.entries}`,
      422,
    );
  }

  let uncompressed = 0;
  for (const entry of entries) {
    const unsafe = unsafeName(entry.name);
    if (unsafe) {
      return failure(
        'artifact_unsafe_entry',
        `Refusing ${JSON.stringify(entry.name)}: ${unsafe}`,
        422,
      );
    }
    if (entry.type === 'l' || entry.type === 'h') {
      return failure(
        'artifact_symlink',
        `Refusing ${JSON.stringify(entry.name)}: symlinks and hard links are not allowed`,
        422,
      );
    }
    if (entry.type !== '-' && entry.type !== 'd') {
      return failure(
        'artifact_unsafe_entry',
        `Refusing ${JSON.stringify(entry.name)}: unsupported entry type`,
        422,
      );
    }
    uncompressed += entry.size;
  }

  if (uncompressed > ARTIFACT_LIMITS.uncompressed) {
    return failure(
      'artifact_too_large',
      `Artifact expands to ${Math.round(uncompressed / 1024 / 1024)} MB, the limit is ${
        ARTIFACT_LIMITS.uncompressed / 1024 / 1024
      } MB`,
      413,
    );
  }

  const target = join(input.artifactsDir, input.deploymentId, 'site');
  rmSync(join(input.artifactsDir, input.deploymentId), { recursive: true, force: true });
  mkdirSync(target, { recursive: true, mode: 0o755 });

  const extracted = spawnSync(
    'tar',
    ['-xzf', input.tarballPath, '-C', target, '--no-same-owner', '--no-same-permissions'],
    { encoding: 'utf8' },
  );

  if (extracted.status !== 0) {
    rmSync(join(input.artifactsDir, input.deploymentId), { recursive: true, force: true });
    return failure(
      'artifact_extract_failed',
      `Extracting the artifact failed: ${(extracted.stderr || '').trim().slice(0, 200)}`,
      422,
    );
  }

  return {
    ok: true,
    artifactPath: `artifacts/${input.deploymentId}/site`,
    artifactBytes: uncompressed,
  };
}

/** Files for a deployment that is no longer wanted. The DB cascade cannot do this. */
export function removeArtifact(artifactsDir: string, deploymentId: string): void {
  rmSync(join(artifactsDir, deploymentId), { recursive: true, force: true });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
