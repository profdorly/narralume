import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const DATABASE_FILE = "lapis.sqlite";
/** Name used before the product was renamed. Libraries created then keep it. */
export const LEGACY_DATABASE_FILE = "narralume.sqlite";

/**
 * The database file to open (or restore into) inside a data directory.
 * A directory that only holds the pre-rename file keeps using it, so an
 * update never opens an empty library next to the existing one. The file is
 * not renamed: SQLite keeps -wal/-shm files next to it, and another process
 * may still have it open.
 */
export function resolveDatabasePath(dataDirectory: string): string {
  const current = resolve(dataDirectory, DATABASE_FILE);
  const legacy = resolve(dataDirectory, LEGACY_DATABASE_FILE);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
