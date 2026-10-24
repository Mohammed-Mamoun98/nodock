#!/usr/bin/env bun
/**
 * nodock doctor — preconditions for a first deploy, without a browser.
 *
 *   bun run doctor
 *
 * Inside the container:
 *   docker compose exec nodock bun apps/server/src/doctor.ts
 */
import { createCaddyAdmin } from '../apps/server/src/caddy/admin';
import { loadConfig } from '../apps/server/src/config';
import { openDatabase } from '../apps/server/src/db/client';
import { createDockerCli } from '../apps/server/src/docker/adapter';
import { formatReport, runDoctor } from '../apps/server/src/doctor';

const config = loadConfig();
const { db } = openDatabase(config.paths.dbFile);

const report = await runDoctor({
  config,
  db,
  docker: createDockerCli(),
  admin: config.caddy.adminUrl ? createCaddyAdmin(config.caddy.adminUrl) : null,
});

console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
