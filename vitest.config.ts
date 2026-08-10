import { defineConfig } from "vitest/config";
import path from "path";
import os from "os";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@contracts": path.resolve(templateRoot, "contracts"),
      "@db": path.resolve(templateRoot, "db"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["api/**/*.test.ts", "api/**/*.spec.ts", "tests/**/*.test.ts"],
    // D7.3: coverage gate (v8 provider). Thresholds are set ~5 points below
    // the suite's measured baseline (run `npm run test:coverage`):
    //   lines 26.23 / statements 24.35 / branches 16.75 / functions 10.46
    // Raise the thresholds as coverage improves; CI enforces them.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // The dev sandbox repo sits on a FUSE mount where the coverage .tmp
      // dir hits transient read-after-write ENOENTs; keep raw coverage files
      // on a real local FS outside CI. CI gets the standard ./coverage path.
      // Override with COVERAGE_DIR if needed.
      reportsDirectory:
        process.env.COVERAGE_DIR ??
        (process.env.CI ? "coverage" : path.join(os.tmpdir(), "enertrek-vitest-coverage")),
      thresholds: {
        lines: 21,
        statements: 19,
        branches: 11,
        functions: 5,
      },
    },
  },
});
