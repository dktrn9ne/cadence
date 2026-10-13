import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Narrow replacement for the previous patch-package dependency. Version
// changes fail closed and require a review of the wallet SDK's font sources.
export function patchSdkFonts(directory) {
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (metadata.version !== "0.6.0") throw new Error("Review the XRPL Connect font patch before upgrading its version.");
  const remoteImport = "  @import url('https://fonts.googleapis.com/css2?family=Karla:wght@300;400;600&display=swap');";
  for (const name of readdirSync(directory).filter((name) => /\.(?:mjs|cjs|js)$/.test(name))) {
    const file = join(directory, name);
    const original = readFileSync(file, "utf8");
    const patched = original.replaceAll(remoteImport, "");
    if (/fonts\.(?:googleapis|gstatic)\.com/.test(patched)) {
      throw new Error(`Unexpected remote-font reference in ${name}; review the patch.`);
    }
    if (patched !== original) writeFileSync(file, patched);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchSdkFonts(join(process.cwd(), "node_modules", "@textrp", "xrpl-connect"));
}
