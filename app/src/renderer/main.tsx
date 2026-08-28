import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DevConsole } from "./DevConsole";
import "./styles.css";
import { initTheme } from "./themeManager";

// Apply saved theme before first paint to avoid flash of default.
// initTheme reads localStorage synchronously for builtin, then reconciles
// with settings.json asynchronously for custom themes.
const themeReady = initTheme();

// The developer console window loads the same bundle with a #console hash and
// renders the log view instead of the main UI.
const rootEl = document.getElementById("root")!;

if (location.hash === "#console") {
  // Console window does not need theme persistence; still apply for consistency
  themeReady.catch(() => {}).finally(() => {
    const root = createRoot(rootEl);
    root.render(<React.StrictMode><DevConsole /></React.StrictMode>);
  });
} else {
  themeReady.catch(() => {}).finally(() => {
    const root = createRoot(rootEl);
    root.render(<React.StrictMode><App /></React.StrictMode>);
  });
}
