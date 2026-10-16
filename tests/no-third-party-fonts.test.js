// Guard for the self-hosted-fonts contract. The wallet SDK
// (@textrp/xrpl-connect) ships a CSS @import that pulls Karla from
// fonts.googleapis.com when the picker mounts; a version-checked postinstall
// script strips it and src/main.jsx registers self-hosted @fontsource/karla
// weights instead. These assertions keep the no-third-party-font guarantee
// from regressing (a fresh install without the patch, or a dep bump, fails here).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { theme } from "../src/brand/tokens.js";

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

  it("injects the self-hosted Karla stack into the connector's shadow DOM", () => {
    // Registration alone is not enough: the connector element's shadow CSS
    // defaults --xc-font-family to a system font stack, so the @font-face
    // declarations never take effect on the picker path. The app must set the
    // custom property on the connector element from light DOM — that value
    // beats the shadow :host default and is what the SDK forwards into its
    // modal portals. This pins the wiring (selector, property, token) so the
    // typography intent cannot silently detach from the font registration.
    const dashboard = readFileSync(join(process.cwd(), "src", "CadenceDashboard.jsx"), "utf8");
    const rule = dashboard.match(/\.xrpl-connector\s*\{[^}]*\}/);
    expect(rule, "the .xrpl-connector rule should exist").not.toBeNull();
    expect(rule[0]).toContain("--xc-font-family: ${theme.fontConnector}");

    // The stack itself stays local and Karla-first.
    expect(theme.fontConnector.startsWith('"Karla"')).toBe(true);
    expect(theme.fontConnector, "the connector stack must stay offline").not.toContain("https://");
    expect(theme.fontConnector).not.toContain("url(");
  });
});
