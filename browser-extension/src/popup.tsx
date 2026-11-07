import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { originPattern } from "./backends/http.ts";
import { createBackend } from "./backends/index.ts";
import type { SaveResult, Settings } from "./backends/types.ts";
import { extractFromTab } from "./extractors/index.ts";
import { collectPreviews, fillBlanks, identifyPage, lookupFields } from "./extractors/lookup.ts";
import { displayName } from "./extractors/normalize.ts";
import { CHECK_NEEDS_YOU, pdfTabState, savePdfTab, type PageOpener, type PdfTabState } from "./pdfTab.ts";
import { loadSettings } from "./settings.ts";
import type { ClipCandidate, ClipPreview, PageExtraction } from "./types";

import "./popup.css";

const TYPE_LABELS: Record<ClipPreview["type"], string> = {
  article: "Article",
  book: "Book",
  chapter: "Book chapter",
  conference: "Conference paper",
  thesis: "Thesis",
  report: "Report",
  dataset: "Dataset",
  webpage: "Web page",
};

const PAGE_ID = "page";

async function readTab(tab: chrome.tabs.Tab): Promise<PageExtraction> {
  const url = tab.url ?? "";
  let readError = "The page script returned nothing.";

  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id as number },
      // Leading slash: Firefox resolves this against the popup's own folder otherwise.
      files: ["/assets/content.js"],
    });

    if (injected?.result) {
      const extraction = injected.result as PageExtraction;

      // Chrome's PDF viewer: the document holds nothing but the viewer, so read the tab.
      if (extraction.contentType === "application/pdf") {
        return { ...extractFromTab(url, tab.title), contentType: extraction.contentType };
      }

      return extraction;
    }

    // Firefox reports a throw inside the script here instead of rejecting.
    const scriptError = (injected as { error?: { message?: string } } | undefined)?.error;
    if (scriptError) {
      readError = scriptError.message ?? String(scriptError);
    }
  } catch (cause) {
    // The browser refused the script: Firefox's PDF viewer, about: and store pages,
    // and each browser words it its own way. The tab URL and title still give
    // something to save, so this isn't shown as an error.
    console.warn("linXiv: could not read the page:", cause);
    return { ...extractFromTab(url, tab.title), blocked: true };
  }

  console.warn("linXiv: could not read the page:", readError);
  return { ...extractFromTab(url, tab.title), readError };
}

async function enrich(preview: ClipPreview): Promise<ClipPreview> {
  const found = await lookupFields(preview);
  return found ? fillBlanks(preview, found.fields, found.source) : preview;
}

function missingFields(preview: ClipPreview): string[] {
  if (preview.type === "webpage") {
    return [];
  }

  const missing: string[] = [];
  if (preview.authors.length === 0) missing.push("authors");
  if (!preview.date && !preview.year) missing.push("date");
  return missing;
}

function describeResult(result: SaveResult): string {
  const saved = result.ids.length === 1 ? result.ids[0] : `${result.ids.length} items`;
  return `Saved ${saved}. Attach the PDF in linXiv.`;
}

function describePdf(outcome: { id?: string; title?: string }): string {
  return `Saved ${outcome.title ?? "the PDF"} with its PDF${outcome.id ? ` as ${outcome.id}` : ""}.`;
}

/** A background tab, because a new window would take focus and close this popup. */
function backgroundTabOpener(onOpen: () => void): PageOpener {
  return {
    open: async (url) => {
      const tab = await chrome.tabs.create({ url, active: false });
      onOpen();

      return async () => {
        if (tab.id !== undefined) {
          // The user may have closed it already.
          await chrome.tabs.remove(tab.id).catch(() => undefined);
        }
      };
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function describeAccess(url: string): string {
  return `The browser needs your permission to read this PDF from ${new URL(url).hostname}.`;
}

function Popup() {
  const [preview, setPreview] = useState<ClipPreview | null>(null);
  const [candidates, setCandidates] = useState<ClipCandidate[]>([]);
  const [readError, setReadError] = useState<string>();
  const [pdfTabUrl, setPdfTabUrl] = useState<string>();
  const [pdfState, setPdfState] = useState<PdfTabState>("page");
  const [needsAccess, setNeedsAccess] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set([PAGE_ID]));
  const [tabId, setTabId] = useState<number>();
  const [settings, setSettings] = useState<Settings>();
  const [result, setResult] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab?.id) {
          throw new Error("Could not find the active browser tab.");
        }

        setTabId(tab.id);
        setSettings(await loadSettings());
        const extraction = await readTab(tab);
        setReadError(extraction.readError);

        // A full-page PDF, or maybe one: the backend reads the metadata from the file, so no lookup.
        const state = pdfTabState(tab.url ?? "", extraction);
        setPdfState(state);

        if (state !== "page" && tab.url) {
          setPdfTabUrl(tab.url);
          setPreview(extraction.preview);
          return;
        }

        const identified = await identifyPage(extraction.preview, extraction.candidates);
        setCandidates(identified ? [] : extraction.candidates);
        setPreview(identified ?? (await enrich(extraction.preview)));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not read this tab.");
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** `pageOnly` skips reading the file, for a tab Firefox won't let the addon read. */
  async function handleSave(pageOnly = false) {
    if (!preview || !settings || tabId === undefined || selected.size === 0) {
      return;
    }

    setSaving(true);
    setError("");
    setResult("");

    try {
      // Inside the try: a failed lookup must still re-enable the button.
      const previews = await collectPreviews(preview, candidates, selected, PAGE_ID, enrich);

      if (settings.kind !== "desktop") {
        const allowed = await chrome.permissions.contains({ origins: [originPattern(settings.baseUrl)] });
        if (!allowed) {
          throw new Error("The browser hasn't been given access to your server. Use Test connection in Settings.");
        }
      }

      // Firefox won't hand a custom scheme to the OS from the popup itself.
      const backend = createBackend(settings, (url) => chrome.tabs.update(tabId, { url }));

      if (pdfTabUrl) {
        setNeedsAccess(false);

        if (!pageOnly) {
          // Shown at once: clicking in the new tab closes this popup and ends the wait.
          const opener = backgroundTabOpener(() => setNotice(`If a security check appears: ${CHECK_NEEDS_YOU}`));
          const outcome = await savePdfTab(backend, pdfTabUrl, undefined, opener);

          if (outcome.kind === "sent") {
            window.close();
            return;
          }

          if (outcome.kind === "needs-access") {
            // Access already held and still blocked: asking again can't help.
            const held = await chrome.permissions.contains({ origins: [originPattern(pdfTabUrl)] });

            if (!held) {
              setNeedsAccess(true);
              return;
            }
          }

          if (outcome.kind === "saved") {
            setResult(describePdf(outcome));
            return;
          }
        }

        // Not a PDF, or not readable: save it as a page, with what its identifiers give.
        previews[0] = await enrich(preview);
      }

      const saved = await backend.save(previews);

      if (saved.status === "sent") {
        window.close();
        return;
      }

      setResult(describeResult(saved));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNotice("");
      setSaving(false);
    }
  }

  function handleAllow() {
    if (!pdfTabUrl) {
      return;
    }

    // Called straight from the click: Firefox only prompts on a user action.
    void chrome.permissions.request({ origins: [originPattern(pdfTabUrl)] }).then(
      (granted) => {
        if (granted) {
          void handleSave();
        } else {
          setNeedsAccess(false);
          setError(describeAccess(pdfTabUrl));
        }
      },
      // Firefox refuses to grant some hosts at all, such as addons.mozilla.org.
      () => void handleSave(true)
    );
  }

  if (loading) {
    return (
      <main className="popup">
        <p className="muted">Reading page…</p>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="popup">
        <h1>linXiv</h1>
        <p className="error">{error}</p>
      </main>
    );
  }

  const missing = missingFields(preview);

  return (
    <main className="popup">
      <header className="header">
        <span className="brand">linXiv</span>
        <span className="site">{preview.site}</span>
      </header>

      <section>
        {pdfState !== "maybe-pdf" && <p className="type">{pdfState === "pdf" ? "PDF" : TYPE_LABELS[preview.type]}</p>}
        <h1 className="title">{preview.title}</h1>

        {preview.authors.length > 0 && <p className="authors">{preview.authors.map(displayName).join(", ")}</p>}

        <div className="metadata">
          {preview.arxivId && (
            <span>
              arXiv: <strong>{preview.arxivId}</strong>
            </span>
          )}
          {preview.doi && (
            <span>
              DOI: <strong>{preview.doi}</strong>
            </span>
          )}
          {preview.journal && <span>{preview.journal}</span>}
          {(preview.date ?? preview.year) && <span>{preview.date ?? preview.year}</span>}
        </div>

        {preview.abstract && <p className="abstract">{preview.abstract}</p>}
        {missing.length > 0 && <p className="muted">Not found: {missing.join(", ")}</p>}
        {pdfState === "maybe-pdf" ? (
          <p className="muted">linXiv checks whether this is a PDF when you save.</p>
        ) : pdfState === "pdf" ? (
          <p className="muted">
            {settings?.kind === "desktop"
              ? "The desktop app downloads this PDF and reads its metadata. Links that need your login won't work, and arXiv PDFs save metadata only."
              : "linXiv reads the metadata from the file when you save."}
          </p>
        ) : (
          <p className="muted">Title from: {preview.sources.title ?? "unknown"}</p>
        )}
        {readError && <p className="muted">Could not read the page: {readError}</p>}
      </section>

      {candidates.length > 0 && (
        <section className="candidates">
          <p className="muted">Also on this page:</p>
          <label className="candidate">
            <input type="checkbox" checked={selected.has(PAGE_ID)} onChange={() => toggle(PAGE_ID)} />
            <span>This page</span>
          </label>
          {candidates.map((candidate) => (
            <label className="candidate" key={candidate.id}>
              <input type="checkbox" checked={selected.has(candidate.id)} onChange={() => toggle(candidate.id)} />
              <span>{candidate.label}</span>
            </label>
          ))}
        </section>
      )}

      <button
        className="save-button"
        type="button"
        disabled={saving || selected.size === 0}
        onClick={() => void handleSave()}
      >
        {saving ? "Saving…" : "Save to linXiv"}
      </button>

      {needsAccess && pdfTabUrl && (
        <>
          <p className="saved">{describeAccess(pdfTabUrl)}</p>
          <button className="save-button" type="button" onClick={handleAllow}>
            Allow and save
          </button>
        </>
      )}

      {notice && <p className="saved">{notice}</p>}
      {result && <p className="saved ok">{result}</p>}
      {error && <p className="error">{error}</p>}

      <p className="muted">
        Saving to {settings?.kind === "headless" ? "linxiv-headless" : "the desktop app"}.{" "}
        <button className="link-button" type="button" onClick={() => void chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </p>
    </main>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Popup root element was not found.");
}

createRoot(rootElement).render(<Popup />);
