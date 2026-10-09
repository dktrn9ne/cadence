// Karla is self-hosted for the @textrp/xrpl-connect wallet modal (weights
// 300/400/600). The modal's CSS used to @import them from fonts.googleapis.com
// at picker mount; a postinstall patch strips that import — see patches/.
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
