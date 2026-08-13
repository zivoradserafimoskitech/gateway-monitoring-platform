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
    // D7.3: coverage gate (v8 provider). Thresholds are set ~2 points below
    // the suite's measured baseline (run `npm run test:coverage`):
    //   lines 41.63 / statements 39.90 / branches 30.70 / functions 24.54
    // (v10/P1-9: EMS controller + decide, C12 control interlock, org-scope
    // tests raised this from lines 26.23 / stmts 24.35 / branch 16.75 / fn 10.46)
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
        lines: 39,
        statements: 37,
        branches: 28,
        functions: 22,
      },
    },
  },
});
