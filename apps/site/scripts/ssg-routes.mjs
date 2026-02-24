/**
 * Post-build script: copies index.html as flat HTML files for each SPA route
 * so GitHub Pages serves them with HTTP 200 instead of 404.
 *
 * GitHub Pages resolves: /privacy → /privacy.html (status 200)
 */
import { cpSync } from "fs";
import { resolve } from "path";

const dist = resolve(import.meta.dirname, "../dist");
const src = resolve(dist, "index.html");

const routes = ["privacy", "guide"];

for (const route of routes) {
  cpSync(src, resolve(dist, `${route}.html`));
  console.log(`  Created ${route}.html`);
}

// Also keep 404.html as fallback for unknown routes
cpSync(src, resolve(dist, "404.html"));
console.log("  Created 404.html (fallback)");
