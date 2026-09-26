import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,

  plugins: [react()],

  publicDir: resolve(root, "public"),

  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,

    rollupOptions: {
      input: {
        popup: resolve(root, "popup/popup.html"),
        content: resolve(root, "src/content.ts"),
      },

      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});