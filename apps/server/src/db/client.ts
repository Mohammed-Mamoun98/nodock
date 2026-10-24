import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

export type Db = ReturnType<typeof openDatabase>['db'];

/**
 * PRAGMAs are chosen to *cap* memory: this process runs on a 1 vCPU / 2 GB box
 * next to the apps it manages, so the control plane must not grow with the DB.
 */
export function openDatabase(path: string) {
  const sqlite = new Database(path, { create: true });

  if (path !== ':memory:') {
    sqlite.exec('PRAGMA journal_mode = WAL');
  }
  sqlite.exec('PRAGMA synchronous = NORMAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA cache_size = -2000'); // ~2 MB page cache
  sqlite.exec('PRAGMA journal_size_limit = 67108864'); // 64 MB WAL ceiling
  sqlite.exec('PRAGMA mmap_size = 0'); // no mapped I/O
  sqlite.exec('PRAGMA busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
