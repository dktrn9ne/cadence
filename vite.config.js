import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Package families for build.rollupOptions.output.manualChunks below. Splitting
// vendors out of the app chunk keeps every static chunk under the 500 kB warning
// threshold and lets app deploys reuse cached vendor bytes. The two wallet SDKs
// are dynamically imported (they only load when the wallet picker opens) and
// must keep Rollup's natural chunks: naming them here makes Rollup merge the
// two dynamic entries into one oversized chunk. @textrp/xrpl-connect ships a
// single prebundled ESM module, so its chunk cannot be split further either.
const REACT_FAMILY = new Set(["react", "react-dom", "scheduler"]);
const DYNAMIC_WALLET_SDKS = new Set(["@textrp/xrpl-connect"]);
const DYNAMIC_WALLET_SDKS_PREFIXES = ["@crossmarkio/"];
const XRPL_CORE = new Set(["xrpl", "fast-json-stable-stringify"]);
const XRPL_CORE_PREFIXES = ["@xrplf/"];
const XRPL_CODEC = new Set([
  "bignumber.js",
  "base-x",
  "base64-js",
  "big-integer",
  "bip32"
]);
const XRPL_CODEC_PREFIXES = ["@scure/", "@noble/", "@transia/", "@exodus/", "ripple-"];
const CHARTS_FAMILY = new Set([
  "recharts",
  "victory-vendor",
  "react-smooth",
  "react-transition-group",
  "internmap",
  "@reduxjs/toolkit",
  "react-redux",
  "immer",
  "reselect",
  "es-toolkit",
  "clsx",
  "decimal.js-light",
  "tiny-invariant",
  "use-sync-external-store"
]);
const CHARTS_FAMILY_PREFIXES = ["d3-"];

function packageName(id) {
  const tail = id.split("node_modules/").pop();
  return tail.startsWith("@") ? tail.split("/").slice(0, 2).join("/") : tail.split("/")[0];
}

function matchesFamily(name, exact, prefixes) {
  return exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

function vendorChunk(name) {
  if (matchesFamily(name, DYNAMIC_WALLET_SDKS, DYNAMIC_WALLET_SDKS_PREFIXES)) {
    return undefined; // wallet SDKs load on demand; keep their natural dynamic chunks
  }
  if (REACT_FAMILY.has(name)) return "react-vendor";
  if (matchesFamily(name, CHARTS_FAMILY, CHARTS_FAMILY_PREFIXES)) return "charts";
  if (matchesFamily(name, XRPL_CODEC, XRPL_CODEC_PREFIXES)) return "xrpl-codec";
  if (matchesFamily(name, XRPL_CORE, XRPL_CORE_PREFIXES)) return "xrpl";
  return "vendor";
}

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined; // app source stays in the index chunk
          }
          return vendorChunk(packageName(id));
        }
      }
    }
  }
});
