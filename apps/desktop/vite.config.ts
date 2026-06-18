import path from "path";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    solidPlugin(),
    tailwindcss(),
    Icons({
      compiler: "solid",
      autoInstall: false,
    }),
  ],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@markdraw/ai": path.resolve(__dirname, "../../packages/ai/src"),
      "@markdraw/core": path.resolve(__dirname, "../../packages/core/src"),
      "@markdraw/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  clearScreen: false,
  optimizeDeps: {
    // The dep optimizer crawls every `**/*.html` under the project root as a scan
    // entry by default. `src-tauri/target/doc/` holds 24k+ rustdoc HTML files
    // (`cargo doc` output), so on Windows the scan never finishes — the optimizer
    // hangs, `.vite/deps` stays empty, the dev server can't serve, and the WebView2
    // window is left stuck at about:blank. Pin the crawl to the real app entry.
    entries: ["index.html"],
  },
  server: {
    port: 2444,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 2445 } : undefined,
    watch: {
      // Don't let the dev server full-reload the webview when a document opened
      // from inside the repo changes. `e2e/fixtures/**` holds sample workspaces
      // (guide.adoc, notes.md, …) opened by the app at runtime via Rust file
      // reads — they're data, not frontend modules, so watching them only causes
      // spurious reloads-to-home when you edit a doc there. (Prefer opening docs
      // OUTSIDE the repo in dev.) `target/` is build output.
      // `paraglide/` is GENERATED i18n output, rewritten in bulk by the
      // lefthook typecheck (git commits) while dev runs. The triggered page
      // reload races the write and the module graph caches a half-written
      // runtime.js ("does not provide an export named 'baseLocale'") that only
      // a dev-server restart evicts — so don't watch it; after regenerating
      // i18n on purpose, reload the app manually (Ctrl+R).
      ignored: ["**/src-tauri/**", "**/e2e/**", "**/target/**", "**/src/paraglide/**"],
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
});
