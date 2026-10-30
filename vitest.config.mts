import { defineConfig } from "vitest/config";

// Unit tests import the TypeScript modules directly. The older jsdom suites (tests/jsdom) and the
// real-Chrome suite (tests/chrome) have their own runners: npm test and npm run test:chrome.
export default defineConfig({
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" }
});
