// Pins the brand token contract. src/brand is consumed as-is (never
// re-extracted), so these values are the drift guard for rebrand work.
// Values verified against src/brand/tokens.js and the Cadence on XRPL brand
// board (art_ReTIbr2H).
import { describe, expect, it } from "vitest";
import { palette, theme } from "../src/brand/tokens.js";

describe("brand tokens", () => {
  it("pins the palette hex values", () => {
    expect(palette).toEqual({
      midnight: "#0B1026",
      violet: "#6C4BFF",
      aqua: "#21D4C2",
      ice: "#EEF4FF",
      cloud: "#C8D3E6",
      white: "#FFFFFF",
    });
  });

  it("pins the theme surfaces, text, and hairlines", () => {
    expect(theme.bg).toBe(palette.midnight);
    expect(theme.bgRaised).toBe("#131A38");
    expect(theme.bgOverlay).toBe("rgba(11,16,38,0.86)");
    expect(theme.surfaceEmbed).toBe(palette.ice);
    expect(theme.textPrimary).toBe(palette.white);
    expect(theme.textMuted).toBe(palette.cloud);
    expect(theme.textFaint).toBe("rgba(200,211,230,0.55)");
    expect(theme.hairline).toBe("rgba(200,211,230,0.16)");
    expect(theme.fillSoft).toBe("rgba(200,211,230,0.06)");
  });

  it("pins the accent, status, and type tokens", () => {
    expect(theme.accent).toBe(palette.violet);
    expect(theme.accentSoft).toBe("rgba(108,75,255,0.18)");
    expect(theme.accent2).toBe(palette.aqua);
    expect(theme.gradient).toBe("linear-gradient(120deg, #6C4BFF 0%, #21D4C2 100%)");
    expect(theme.success).toBe(palette.aqua);
    expect(theme.danger).toBe("#FF5C7A");
    expect(theme.dangerSoft).toBe("rgba(255,92,122,0.14)");
    expect(theme.fontHeading).toBe('"Space Grotesk", "Manrope", system-ui, sans-serif');
    expect(theme.fontBody).toBe('"Manrope", system-ui, sans-serif');
    expect(theme.fontData).toBe('"IBM Plex Mono", ui-monospace, monospace');
  });
});
