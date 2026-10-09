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
