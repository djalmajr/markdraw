import path from "path";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "solid",
    }),
    solidPlugin(),
  ],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@asciimark/core": path.resolve(__dirname, "../../packages/core/src"),
      "@asciimark/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
});
