import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { patchSdkFonts } from "../scripts/patch-sdk-fonts.mjs";

describe("version-checked wallet SDK font patch", () => {
  it("strips only the known import, is idempotent, and rejects unexpected sources", () => {
    const directory = mkdtempSync(join(tmpdir(), "cadence-fonts-"));
    try {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.6.0" }));
      const file = join(directory, "fixture.mjs");
      writeFileSync(file, "const css = `\n  @import url('https://fonts.googleapis.com/css2?family=Karla:wght@300;400;600&display=swap');\nbody {color:red}\n`;\n");
      patchSdkFonts(directory);
      const patched = readFileSync(file, "utf8");
      expect(patched).not.toContain("googleapis");
      expect(patched).toContain("body {color:red}");
      patchSdkFonts(directory);
      expect(readFileSync(file, "utf8")).toBe(patched);
      writeFileSync(file, "fonts.gstatic.com/new-resource");
      expect(() => patchSdkFonts(directory)).toThrow("Unexpected remote-font");
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.7.0" }));
      expect(() => patchSdkFonts(directory)).toThrow("before upgrading");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
