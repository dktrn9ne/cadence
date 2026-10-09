import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test-only config — `vite build` never reads this file, so the production
// build is untouched. The react plugin lets tests import `.jsx` app files.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
  },
});
