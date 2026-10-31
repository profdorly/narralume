import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeNarrativeDatabase } from "@lapis/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

/* M4 optional static hosting: a single NARRATIVE_STATIC_DIR switch. Static
 * assets + SPA fallback to index.html; unknown /api paths are still a JSON 404.
 */

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (apps.length > 0) await (await apps.pop())?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "narrative-static-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>灯</title>");
  writeFileSync(join(dir, "spike.html"), "<!doctype html><title>spike</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')");
  return dir;
}

const baseConfig = (staticDirectory?: string): ServerConfig => ({
  dataDirectory: ".",
  databasePath: ":memory:",
  ...(staticDirectory ? { staticDirectory } : {}),
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
});

describe("optional static hosting (NARRATIVE_STATIC_DIR)", () => {
  it("static files, assets and the SPA fallback to index.html are all reachable", async () => {
    const app = await buildApp({
      config: baseConfig(makeStaticDir()),
      database: new NodeNarrativeDatabase(),
      enableRunWorker: false,
      logger: false,
    });
    apps.push(app);
    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("灯");
    expect(index.headers["content-security-policy"]).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );
    expect(index.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");
    // SPA deep links fall back to index.html (frontend routes /shelf,
    // /projects/x/overview).
    const deep = await app.inject({ method: "GET", url: "/shelf" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("灯");
  });

  it("unknown /api paths still return a JSON 404 and do not fall back to index.html", async () => {
    const app = await buildApp({
      config: baseConfig(makeStaticDir()),
      database: new NodeNarrativeDatabase(),
      enableRunWorker: false,
      logger: false,
    });
    apps.push(app);
    const api = await app.inject({
      method: "GET",
      url: "/api/definitely-missing",
    });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: { code: "route.not_found" } });
    expect(api.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
  });

  it("without the switch the behavior is unchanged: unknown paths get a JSON 404", async () => {
    const app = await buildApp({
      config: baseConfig(),
      database: new NodeNarrativeDatabase(),
      enableRunWorker: false,
      logger: false,
    });
    apps.push(app);
    const missing = await app.inject({ method: "GET", url: "/shelf" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "route.not_found" },
    });
  });
});
