import React from "react";
import { createRoot } from "react-dom/client";
import StreamPayDashboard from "./StreamPayDashboard.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <StreamPayDashboard />
  </React.StrictMode>
);
