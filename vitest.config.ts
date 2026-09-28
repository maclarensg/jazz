import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Scaffold phase: suite is empty until Task 1 lands its first red test.
    passWithNoTests: true,
    include: ["test/**/*.test.ts"],
  },
})
