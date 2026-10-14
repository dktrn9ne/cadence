// Karla is self-hosted for the @textrp/xrpl-connect wallet modal (weights
// 300/400/600). The modal's CSS used to @import them from fonts.googleapis.com
// at picker mount; the version-checked postinstall script
// (scripts/patch-sdk-fonts.mjs) strips that import. Registration alone does
// not theme the modal — its shadow CSS defaults --xc-font-family to a system
// stack — so CadenceDashboard.jsx injects theme.fontConnector on the
// connector element, which the SDK forwards into its modal portals.
import "@fontsource/karla/300.css";
import "@fontsource/karla/400.css";
import "@fontsource/karla/600.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import React from "react";
import { createRoot } from "react-dom/client";
import CadenceDashboard from "./CadenceDashboard.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CadenceDashboard />
  </React.StrictMode>
);
