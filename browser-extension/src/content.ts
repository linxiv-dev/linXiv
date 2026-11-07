import { extractPage } from "./extractors/index.ts";

declare global {
  var __linxivExtract: (() => ReturnType<typeof extractPage>) | undefined;
}

// The footer in vite.content.config.ts calls this as the script's last
// expression, which is what executeScript hands back to the popup.
globalThis.__linxivExtract = () => ({
  ...extractPage(document, window.location.href),
  contentType: document.contentType,
});
