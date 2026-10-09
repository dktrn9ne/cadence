import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test-only config: the app build keeps using vite.config.js.
// The ledger client is always injected in tests, so no test opens a socket.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.js"],
  },
});
