// src/brand/tokens.js — single source of truth for brand color + type.
// Values from the Cadence on XRPL brand board (art_ReTIbr2H).
export const palette = {
  midnight: "#0B1026", // Trust, Depth — app background
  violet: "#6C4BFF", // Energy, Motion — primary accent
  aqua: "#21D4C2", // Growth, Clarity — secondary accent, success, live states
  ice: "#EEF4FF", // Clean Focus — raised light surface, embeds
  cloud: "#C8D3E6", // Balance, Structure — muted text, hairline base
  white: "#FFFFFF", // Simplicity — primary text
};

export const theme = {
  // Surfaces — dark theme replaces every light cream surface
  bg: palette.midnight,
  bgRaised: "#131A38", // midnight, +10% lightness — cards, modals, topbars
  bgOverlay: "rgba(11,16,38,0.86)", // modal scrims
  surfaceEmbed: palette.ice, // wallet-connector embed background

  // Text
  textPrimary: palette.white,
  textMuted: palette.cloud,
  textFaint: "rgba(200,211,230,0.55)",

  // Lines and fills
  hairline: "rgba(200,211,230,0.16)",
  fillSoft: "rgba(200,211,230,0.06)", // hover/zebra washes on dark

  // Accents
  accent: palette.violet,
  accentSoft: "rgba(108,75,255,0.18)", // selected rows, focus tints
  accent2: palette.aqua,
  gradient: "linear-gradient(120deg, #6C4BFF 0%, #21D4C2 100%)", // primary buttons, C-mark, meters

  // Status — the board defines no danger token; rose fills the old coral's error role
  success: palette.aqua,
  danger: "#FF5C7A",
  dangerSoft: "rgba(255,92,122,0.14)",

  // Type
  fontHeading: '"Space Grotesk", "Manrope", system-ui, sans-serif',
  fontBody: '"Manrope", system-ui, sans-serif',
  fontData: '"IBM Plex Mono", ui-monospace, monospace',
};
