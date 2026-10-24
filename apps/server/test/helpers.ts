import { join } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { openDatabase } from '../src/db/client';

/** Fresh in-memory DB with the real migrations applied — no Docker, no network. */
export function testDb() {
  const { db, sqlite } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: join(import.meta.dir, '../drizzle') });
  return { db, sqlite };
}
