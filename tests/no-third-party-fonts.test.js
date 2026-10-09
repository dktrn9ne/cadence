// Guard for the self-hosted-fonts contract. The wallet SDK
// (@textrp/xrpl-connect) ships a CSS @import that pulls Karla from
// fonts.googleapis.com when the picker mounts; a postinstall patch-package
// patch strips it and src/main.jsx registers self-hosted @fontsource/karla
// weights instead. These assertions keep the no-third-party-font guarantee
// from regressing (a fresh install without the patch, or a dep bump, fails here).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// `npm test` runs from the repo root (matching CI), so node_modules is a
// well-known path. The lib's exports map hides package.json, so scan the
// package directory directly instead of resolving through it.
const libDir = join(process.cwd(), "node_modules", "@textrp", "xrpl-connect");
const karlaDir = join(process.cwd(), "node_modules", "@fontsource", "karla");

const libSources = readdirSync(libDir)
  .filter((name) => /\.(mjs|cjs|js)$/i.test(name))
  .map((name) => ({ name, content: readFileSync(join(libDir, name), "utf8") }));

describe("self-hosted fonts (wallet-picker path)", () => {
  it("keeps @textrp/xrpl-connect sources free of remote font hosts", () => {
    expect(libSources.length).toBeGreaterThan(0);
    for (const { name, content } of libSources) {
      expect(content, `${name} must not reference fonts.googleapis.com`).not.toContain(
        "fonts.googleapis.com"
      );
      expect(content, `${name} must not reference fonts.gstatic.com`).not.toContain(
        "fonts.gstatic.com"
      );
    }
  });

  it("ships local Karla 300/400/600 for the wallet modal", () => {
    // Exactly the weights the removed Google import used to serve.
    for (const weight of [300, 400, 600]) {
      const cssPath = join(karlaDir, `${weight}.css`);
      expect(existsSync(cssPath), `${cssPath} should exist`).toBe(true);
      const css = readFileSync(cssPath, "utf8");
      expect(css).toContain("Karla");
      expect(css, `@fontsource/karla ${weight}.css must reference local files only`).not.toContain(
        "https://"
      );
      // The referenced woff2 must ship with the package, not come from the network.
      const url = css.match(/url\(['"]?([^'")]+)/);
      expect(url, "fontsource css must reference a font file").not.toBeNull();
      expect(
        existsSync(join(dirname(cssPath), url[1])),
        `${url[1]} should exist locally`
      ).toBe(true);
    }
  });
});
