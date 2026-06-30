import React from "react";
import { createRoot } from "react-dom/client";
import CadenceDashboard from "./StreamPayDashboard.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CadenceDashboard />
  </React.StrictMode>
);
