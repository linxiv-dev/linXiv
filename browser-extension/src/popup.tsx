import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { ClipPreview, GetClipPreviewMessage } from "./types";

import "./popup.css";

function Popup() {
  const [preview, setPreview] = useState<ClipPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadPreview() {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });

        if (!tab?.id) {
          throw new Error("Could not find the active browser tab.");
        }

        const message: GetClipPreviewMessage = {
          type: "LINXIV_GET_CLIP_PREVIEW",
        };

        const result = await chrome.tabs.sendMessage<
          GetClipPreviewMessage,
          ClipPreview | null
        >(tab.id, message);

        if (!result) {
          throw new Error("This page is not supported yet.");
        }

        setPreview(result);
      } catch {
        setError(
          "Open an arXiv paper page, then try the linXiv clipper again."
        );
      } finally {
        setLoading(false);
      }
    }

    void loadPreview();
  }, []);

  function handleSave() {
    if (!preview) {
      return;
    }

    const deepLink =
      `linxiv-clip://add?input=${encodeURIComponent(preview.target.value)}`;

    window.location.href = deepLink;
  }

  if (loading) {
    return (
      <main className="popup">
        <p className="muted">Reading paper…</p>
      </main>
    );
  }

  if (error || !preview) {
    return (
      <main className="popup">
        <h1>linXiv</h1>
        <p className="error">{error}</p>
      </main>
    );
  }

  return (
    <main className="popup">
      <header className="header">
        <span className="brand">linXiv</span>
        <span className="site">arXiv</span>
      </header>

      <section>
        <h1 className="title">{preview.title}</h1>

        {preview.authors.length > 0 && (
          <p className="authors">{preview.authors.join(", ")}</p>
        )}

        <div className="metadata">
          <span>
            arXiv: <strong>{preview.target.value}</strong>
          </span>

          {preview.doi && (
            <span>
              DOI: <strong>{preview.doi}</strong>
            </span>
          )}
        </div>

        {preview.abstract && (
          <p className="abstract">{preview.abstract}</p>
        )}
      </section>

      <button
        className="save-button"
        type="button"
        onClick={handleSave}
      >
        Save to linXiv
      </button>
    </main>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Popup root element was not found.");
}

createRoot(rootElement).render(<Popup />);