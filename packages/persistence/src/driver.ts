/**
 * Minimal surface of the persistence driver: repository code depends only on
 * these three methods (prepare/exec/close). node:sqlite's DatabaseSync
 * satisfies this interface structurally, and the browser WASM driver implements
 * the same shape, so repositories run on both runtimes unchanged.
 *
 * Row objects are always keyed by column name (the node:sqlite default);
 * parameters are always positional.
 */
export interface SqliteStatement {
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteRawDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
  /**
   * Export the bytes of the whole database (download my library, D6). Not yet
   * implemented in the Node driver: the Node side uses the backup service
   * (VACUUM INTO + integrity check); the browser sahpool driver uses the pool's
   * exportFile.
   */
  exportBytes?(): Promise<Uint8Array>;
}
