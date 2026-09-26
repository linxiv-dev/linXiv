import { extractClipPreview } from "./extractors";
import type { GetClipPreviewMessage } from "./types";

chrome.runtime.onMessage.addListener(
  (
    message: GetClipPreviewMessage,
    _sender,
    sendResponse
  ) => {
    if (message.type !== "LINXIV_GET_CLIP_PREVIEW") {
      return;
    }

    const preview = extractClipPreview(document, window.location.href);

    sendResponse(preview);
  }
);