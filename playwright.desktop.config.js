import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.desktop.pw.js",
  workers: 1,
  timeout: 30000,
});
