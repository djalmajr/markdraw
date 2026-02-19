/* @refresh reload */
import { render } from "solid-js/web";
import { App } from "./components/App.tsx";
import "./styles/index.css";

// Sync dark mode class with system preference
function syncDarkMode() {
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", isDark);
}

syncDarkMode();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncDarkMode);

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
