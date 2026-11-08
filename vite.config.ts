import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const here = import.meta.dirname;

// Tauri expects a fixed dev port and does not want the browser auto-opening.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/research/**"] },
  },
  build: {
    target: "chrome105",
    rollupOptions: {
      input: {
        main: resolve(here, "index.html"),
        bar: resolve(here, "bar.html"),
      },
      // Keep `/*! @license */` blocks (the Hex MIT notice in src/bar/dotScope.ts)
      // in the shipped bundle; MIT requires the notice to travel with the code.
      output: { comments: { legal: true, annotation: false, jsdoc: false } },
    },
  },
});
