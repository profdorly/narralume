/**
 * Browser entry point: must not import any Node built-in module (node:fs,
 * etc.). On the Node side use NodeNarrativeDatabase from the main entry point.
 */
export type { SqliteRawDatabase, SqliteStatement } from "./driver.js";
export {
  createOpfsSahpoolDriver,
  OPFS_DATABASE_FILE,
} from "./browser/wasm-driver.js";
export * from "./database.js";
export * from "./repositories.js";
