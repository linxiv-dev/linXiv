import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const firefox = process.env.LINXIV_BROWSER === "firefox";
const outDir = resolve(root, firefox ? "dist-firefox" : "dist");

// Firefox needs a gecko id to sign and install; Chromium warns on the key.
function firefoxManifest(): Plugin {
  return {
    name: "linxiv-firefox-manifest",
    closeBundle() {
      const path = resolve(outDir, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.browser_specific_settings = {
        gecko: {
          id: "web-clipper@linxiv.app",
          strict_min_version: "140.0",
          data_collection_permissions: { required: ["none"] },
        },
      };
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

export default defineConfig({
  root,

  plugins: firefox ? [react(), firefoxManifest()] : [react()],

  publicDir: resolve(root, "public"),

  build: {
    outDir,
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