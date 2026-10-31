import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkgSource = (name: string, file = "index.ts") =>
  fileURLToPath(new URL(`./packages/${name}/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@lapis/narrative": pkgSource("narrative"),
      "@lapis/services": pkgSource("services"),
      "@lapis/persistence/node": pkgSource("persistence", "node.ts"),
      "@lapis/persistence/browser": pkgSource("persistence", "browser.ts"),
      "@lapis/persistence": pkgSource("persistence"),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      exclude: ["**/dist/**", "apps/web/**", "**/*.d.ts"],
      thresholds: {
        // 2026-08-19 实测基线 76.82/64.44/77.72/78.67，各留约 1.5 点防回退余量
        statements: 75,
        branches: 63,
        functions: 76,
        lines: 77,
      },
    },
    include: [
      "apps/**/test/**/*.test.{ts,tsx}",
      "packages/**/test/**/*.test.{ts,tsx}",
    ],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
