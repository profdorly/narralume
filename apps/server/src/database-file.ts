import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const DATABASE_FILE = "lapis.sqlite";
/** Filename used before the product was named Lapis. */
const LEGACY_DATABASE_FILE = "narralume.sqlite";

/**
 * The database file to open (or restore into) inside a data directory.
 * When the directory still has only the pre-rename file, that file and its
 * SQLite sidecars are renamed to lapis.sqlite before anything opens them, so
 * an update does not create an empty library beside the existing one.
 */
export function resolveDatabasePath(dataDirectory: string): string {
  const current = resolve(dataDirectory, DATABASE_FILE);
  if (!existsSync(current)) {
    const legacy = resolve(dataDirectory, LEGACY_DATABASE_FILE);
    if (existsSync(legacy)) {
      renameSync(legacy, current);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const sidecar = `${legacy}${suffix}`;
        if (existsSync(sidecar)) renameSync(sidecar, `${current}${suffix}`);
      }
    }
  }
  return current;
}
