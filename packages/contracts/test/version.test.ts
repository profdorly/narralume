import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { LAPIS_VERSION } from "../src/index.js";

describe("LAPIS_VERSION", () => {
  it("matches the root package.json version", () => {
    const root = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(LAPIS_VERSION).toBe(root.version);
  });
});
