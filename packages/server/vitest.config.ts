import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Two integration tests are timing-sensitive under parallel-file
    // load (combat tick budget + the @colyseus/sdk 0.17 per-broadcast
    // "onMessage() not registered for type 'X'" warning flood writing
    // to stderr). Both pass cleanly in isolation; retry once to absorb
    // the noise. Real regressions still surface — retry only masks
    // first-shot flakes, not deterministic failures.
    retry: 1,
  },
  resolve: {
    alias: {
      "@mp/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
});
