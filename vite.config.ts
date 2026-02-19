import path from "path";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import Icons from "unplugin-icons/vite";

export default defineConfig({
  plugins: [
    solidPlugin(),
    Icons({
      compiler: "solid",
      autoInstall: false,
    }),
  ],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
    },
  },
  base: "./",
  build: {
    outDir: "dist",
    target: "esnext",
    rollupOptions: {
      input: {
        newtab: "index.html",
      },
    },
  },
});
