import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDatabasePath } from "../src/database-file.js";

describe("resolveDatabasePath", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories)
      rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  function tempDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "lapis-db-"));
    directories.push(directory);
    return directory;
  }

  it("points at lapis.sqlite when the directory has no library yet", () => {
    const directory = tempDirectory();
    expect(resolveDatabasePath(directory)).toBe(
      join(directory, "lapis.sqlite"),
    );
  });

  it("renames a library created before the product was named Lapis, including its sidecars", () => {
    const directory = tempDirectory();
    const legacy = join(directory, "narralume.sqlite");
    writeFileSync(legacy, "db");
    writeFileSync(`${legacy}-wal`, "wal");
    writeFileSync(`${legacy}-shm`, "shm");

    const current = resolveDatabasePath(directory);

    expect(current).toBe(join(directory, "lapis.sqlite"));
    expect(readFileSync(current, "utf8")).toBe("db");
    expect(readFileSync(`${current}-wal`, "utf8")).toBe("wal");
    expect(readFileSync(`${current}-shm`, "utf8")).toBe("shm");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}-wal`)).toBe(false);
    expect(existsSync(`${legacy}-shm`)).toBe(false);
  });

  it("leaves an existing lapis.sqlite in place when the old filename is also present", () => {
    const directory = tempDirectory();
    writeFileSync(join(directory, "lapis.sqlite"), "current");
    writeFileSync(join(directory, "narralume.sqlite"), "old");

    expect(readFileSync(resolveDatabasePath(directory), "utf8")).toBe(
      "current",
    );
    expect(existsSync(join(directory, "narralume.sqlite"))).toBe(true);
  });
});
