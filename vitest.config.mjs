import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Engine + adapter tests are co-located with their sources under src/.
    include: ["src/**/*.test.mjs"],
    environment: "node",
  },
});
