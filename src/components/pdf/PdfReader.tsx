import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs, type DocumentProps } from "react-pdf";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogoMark } from "../ui/logo-mark";
import {
  getAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
} from "../../api/annotations";
import {
  HIGHLIGHT_COLORS,
  parseAnchor,
  selectionToAnchor,
  type Anchor,
} from "../../lib/pdfAnchor";
import { ColorSwatches } from "./ColorSwatches";
import { HighlightLayer, type PageHighlight } from "./HighlightLayer";
import { PagePill } from "./PagePill";
import { submitOnCtrlEnter } from "../../lib/submitShortcut";
import { invalidateAnnotationQueries } from "../../lib/paperMutations";
import {
  readPdfPosition,
  writePdfPosition,
  type PdfPosition,
} from "../../lib/pdfPosition";
import { pdfCanvasDpr } from "../../lib/zoom";
import {
  PDF_FIND_EVENT,
  buildPageIndex,
  escapeHtml,
  findMatches,
  highlightHtml,
  rangesForItem,
  type HighlightRange,
  type PageIndex,
} from "../../lib/pdfFind";
import { pdfDocumentOptions, PAGE_INSET, estPageHeight } from "../../lib/pdfOptions";
import { useUiStore } from "../../stores/ui";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfReaderProps {
  /** Fetchable PDF URL: custom scheme in the app, proxied path in dev. */
  file: string;
  sourceId: string;
  /** Paper version the rendered PDF belongs to; anchors are scoped to it. */
  version: number;
  /** Scopes created highlights to this project so they export/share with it;
   *  null/undefined creates library-scoped ones. */
  projectId?: number | null;
  /** Fallback link shown if the PDF fails to load. */
  errorUrl?: string | null;
}

// Pages this far from the current one render; the rest are spacers. The margin
// covers scroll momentum before onScroll re-centers the window.
const PAGE_WINDOW = 4;

// Quiet time after the last ResizeObserver tick before the live scaleX preview
// is committed as a real react-pdf re-render.
const RESIZE_SETTLE_MS = 120;

// localStorage is synchronous, so throttle writes while scrolling; closing the
// reader still flushes the final position.
const POSITION_SAVE_INTERVAL_MS = 200;


type LoadedPdf = Parameters<NonNullable<DocumentProps["onLoadSuccess"]>>[0];

interface SelToolbar {
  top: number;
  left: number;
  /** Captured at mouseup — the live selection may collapse before the click. */
  anchor: Anchor;
}
interface ActivePopup {
  id: number;
  top: number;
  left: number;
  anchor: Anchor;
  // Server comment/color as of popup open, the baseline drafts diff against.
  comment: string;
  color: string;
}

// Saved-PDF reader with Zotero-style text highlights. Each is an ANNOTATION
// row with an `anchor` (lib/pdfAnchor) plus an optional comment, drawn as a
// per-page overlay and round-tripped through the annotations API.
export function PdfReader({ file, sourceId, version, projectId, errorUrl }: PdfReaderProps) {
  const qc = useQueryClient();
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [selBar, setSelBar] = useState<SelToolbar | null>(null);
  const [popup, setPopup] = useState<ActivePopup | null>(null);
  const [draft, setDraft] = useState("");
  const [draftColor, setDraftColor] = useState<string>(HIGHLIGHT_COLORS[0]);
  const [selError, setSelError] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCur, setFindCur] = useState(0);
  // One PageIndex per page, extracted lazily the first time the bar opens.
  const [pageIndexes, setPageIndexes] = useState<PageIndex[] | null>(null);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pagesWrapRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const restoreRafRef = useRef<number | null>(null);
  const obsRef = useRef<ResizeObserver | null>(null);
  // Last width committed to react-pdf (vs. the live ResizeObserver reading), so
  // mid-drag ticks can be scaled instead of reflowed.
  const committedWidthRef = useRef(0);
  const resizeTimerRef = useRef<number | null>(null);
  const positionTimerRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<PdfPosition | null>(null);
  const positionReadyRef = useRef(false);
  const pdfDocRef = useRef<LoadedPdf | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  // Armed on a find jump; the target page's text-layer render completes it.
  const findScrollPendingRef = useRef(false);

  const capturePosition = useCallback(
    (scroller: HTMLDivElement): PdfPosition | null => {
      const pages = scroller.querySelectorAll<HTMLElement>(".pdf-page-slot");
      if (pages.length === 0) return null;

      // The page under the viewport's top edge, with a dimensionless offset so
      // restoring survives a pane/window resize.
      let current = pages[0];
      let currentIndex = 0;
      pages.forEach((candidate, index) => {
        if (candidate.offsetTop <= scroller.scrollTop + 1) {
          current = candidate;
          currentIndex = index;
        }
      });
      const height = Math.max(1, current.offsetHeight);
      return {
        page: currentIndex + 1,
        offset: Math.min(
          1,
          Math.max(0, (scroller.scrollTop - current.offsetTop) / height),
        ),
      };
    },
    [],
  );

  const savePosition = useCallback(
    (scroller: HTMLDivElement | null) => {
      if (!scroller || !positionReadyRef.current) return;
      const position = capturePosition(scroller);
      if (position) writePdfPosition(sourceId, version, position);
    },
    [capturePosition, sourceId, version],
  );

  const schedulePositionSave = useCallback(
    (scroller: HTMLDivElement) => {
      if (!positionReadyRef.current || positionTimerRef.current !== null) return;
      positionTimerRef.current = window.setTimeout(() => {
        positionTimerRef.current = null;
        savePosition(scroller);
      }, POSITION_SAVE_INTERVAL_MS);
    },
    [savePosition],
  );

  // Key must match PaperDetailPage's annotations query so the overlay and the
  // Annotations tab share one cache entry.
  const zoom = useUiStore((s) => s.zoom);

  const { data: annData } = useQuery({
    queryKey: ["annotations", sourceId, { allProjects: true }],
    queryFn: () => getAnnotations(sourceId, undefined, true),
    enabled: !!sourceId,
  });

  const byPage = useMemo(() => {
    const byPage = new Map<number, PageHighlight[]>();
    for (const a of annData?.annotations ?? []) {
      const anchor = parseAnchor(a.anchor);
      // Only this version's anchors: page layout (and thus coords) differ per version.
      if (!anchor || anchor.version !== version) continue;
      const list = byPage.get(anchor.page) ?? [];
      list.push({ id: a.id, anchor });
      byPage.set(anchor.page, list);
    }
    return byPage;
  }, [annData, version]);

  // id → server comment/color, for populating the popup and staleness checks.
  const metaById = useMemo(() => {
    const m = new Map<number, { comment: string; color: string | null }>();
    for (const a of annData?.annotations ?? [])
      m.set(a.id, { comment: a.comment, color: parseAnchor(a.anchor)?.color ?? null });
    return m;
  }, [annData]);

  const createMut = useMutation({
    mutationFn: (v: { anchor: Anchor; top: number; left: number }) =>
      createAnnotation({
        source_id: sourceId,
        anchor: JSON.stringify(v.anchor),
        project_id: projectId ?? null,
      }),
    onSuccess: (data, v) => {
      invalidateAnnotationQueries(qc);
      // Popup opens on it: comment and color tweaks are one gesture, but the
      // highlight already exists, so dismissing keeps it.
      const pos = clampToViewport(v.left, v.top, 280, 240);
      setDraft("");
      setDraftColor(v.anchor.color);
      updateMut.reset();
      deleteMut.reset();
      setPopup({
        id: data.id,
        top: pos.top,
        left: pos.left,
        anchor: v.anchor,
        comment: "",
        color: v.anchor.color,
      });
    },
  });
  const updateMut = useMutation({
    mutationFn: (v: { id: number; comment: string; anchor?: string }) =>
      updateAnnotation(v.id, v.comment, v.anchor),
    onSuccess: (_data, v) => {
      invalidateAnnotationQueries(qc);
      // close only the popup we edited, never one reopened mid-flight
      setPopup((p) => (p?.id === v.id ? null : p));
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => deleteAnnotation(id),
    onSuccess: (_data, id) => {
      invalidateAnnotationQueries(qc);
      setPopup((p) => (p?.id === id ? null : p));
    },
  });

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (restoreRafRef.current !== null) cancelAnimationFrame(restoreRafRef.current);
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current);
        pagesWrapRef.current?.style.removeProperty("transform");
        pagesWrapRef.current?.style.removeProperty("will-change");
      }
      if (positionTimerRef.current !== null) clearTimeout(positionTimerRef.current);
      obsRef.current?.disconnect();
    },
    [],
  );

  useEffect(() => {
    const saved = readPdfPosition(sourceId, version);
    pendingPositionRef.current = saved;
    positionReadyRef.current = !saved;
    setPage(saved?.page ?? 1);
    setNumPages(0);

    const flushPosition = () => savePosition(scrollerRef.current);
    window.addEventListener("pagehide", flushPosition);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (restoreRafRef.current !== null) cancelAnimationFrame(restoreRafRef.current);
      if (positionTimerRef.current !== null) {
        clearTimeout(positionTimerRef.current);
        positionTimerRef.current = null;
      }
      flushPosition();
      window.removeEventListener("pagehide", flushPosition);
    };
  }, [file, savePosition, sourceId, version]);

  // Dismiss the toolbar/popup on a mousedown outside the reader scroller.
  useEffect(() => {
    if (!selBar && !popup) return;
    const onDocDown = (e: MouseEvent) => {
      if (scrollerRef.current?.contains(e.target as Node)) return;
      setSelBar(null);
      setPopup(null);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [selBar, popup]);

  // Stable so React doesn't detach/reattach the ref (rebuilding the observer)
  // on every render, e.g. each setPage during a scroll.
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    obsRef.current?.disconnect();
    if (resizeTimerRef.current !== null) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
      pagesWrapRef.current?.style.removeProperty("transform");
      pagesWrapRef.current?.style.removeProperty("will-change");
    }
    scrollerRef.current = el;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const newWidth = entries[0].contentRect.width;
      // First measurement (mount): commit immediately, nothing to scale from yet.
      if (committedWidthRef.current === 0) {
        committedWidthRef.current = newWidth;
        setWidth(newWidth);
        return;
      }
      // Mid-drag ticks: scale the rendered pages via CSS instead of reflowing
      // react-pdf; commit the real width once resizing settles. Pages render at
      // width-PAGE_INSET, so scale by the inset width, not the outer one;
      // "top center" keeps mx-auto-centered pages from sliding sideways.
      const wrap = pagesWrapRef.current;
      const prevInset = committedWidthRef.current - PAGE_INSET;
      if (wrap && prevInset > 0) {
        wrap.style.willChange = "transform";
        wrap.style.transform = `scaleX(${(newWidth - PAGE_INSET) / prevInset})`;
        wrap.style.transformOrigin = "top center";
      }
      if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        if (wrap) {
          wrap.style.transform = "";
          wrap.style.removeProperty("will-change");
        }
        committedWidthRef.current = newWidth;
        setWidth(newWidth);
      }, RESIZE_SETTLE_MS);
    });
    obs.observe(el);
    obsRef.current = obs;
  }, []);

  function goToPage(target: number) {
    if (numPages <= 0) return;
    const next = Math.min(Math.max(target, 1), numPages);
    setPage(next);
    const scroller = scrollerRef.current;
    const pageEl =
      scroller?.querySelectorAll<HTMLElement>(".pdf-page-slot")[next - 1];
    if (scroller && pageEl) scroller.scrollTop = pageEl.offsetTop;
  }

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const scroller = e.currentTarget;
    schedulePositionSave(scroller);
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (!scroller.isConnected) return;
      const pages = scroller.querySelectorAll<HTMLElement>(".pdf-page-slot");
      if (pages.length === 0) return;
      let nearest = 1;
      let best = Infinity;
      pages.forEach((el, i) => {
        const dist = Math.abs(el.offsetTop - scroller.scrollTop);
        if (dist < best) {
          best = dist;
          nearest = i + 1;
        }
      });
      setPage(nearest);
    });
    if (selBar) setSelBar(null);
    if (popup) setPopup(null);
  }

  function onDocumentLoad(pdf: LoadedPdf) {
    const loadedPages = pdf.numPages;
    pdfDocRef.current = pdf;
    setPageIndexes(null);
    setNumPages(loadedPages);
    const pending = pendingPositionRef.current;
    if (!pending) {
      positionReadyRef.current = true;
      return;
    }
    const targetPage = Math.min(Math.max(pending.page, 1), loadedPages);
    pendingPositionRef.current = { ...pending, page: targetPage };
    setPage(targetPage);
  }

  function restorePosition(renderedPage: number) {
    const pending = pendingPositionRef.current;
    if (!pending || pending.page !== renderedPage || width <= 0) return;
    if (restoreRafRef.current !== null) cancelAnimationFrame(restoreRafRef.current);
    restoreRafRef.current = requestAnimationFrame(() => {
      restoreRafRef.current = null;
      const scroller = scrollerRef.current;
      const pageEl =
        scroller?.querySelectorAll<HTMLElement>(".pdf-page-slot")[renderedPage - 1];
      if (!scroller || !pageEl) return;
      scroller.scrollTop = pageEl.offsetTop + pending.offset * pageEl.offsetHeight;
      pendingPositionRef.current = null;
      positionReadyRef.current = true;
    });
  }

  // Stable per-page Page callbacks: react-pdf's text layer wipes and rebuilds
  // its DOM (destroying any live text selection) whenever these props change
  // identity, so inline arrows here would rebuild every page on every render.
  const latestPageCbs = useRef({ restorePosition, onTextLayerRendered });
  latestPageCbs.current = { restorePosition, onTextLayerRendered };
  const pageCbsRef = useRef(
    new Map<number, { render: () => void; text: () => void }>(),
  );
  function pageCbs(pn: number) {
    let c = pageCbsRef.current.get(pn);
    if (!c) {
      c = {
        render: () => latestPageCbs.current.restorePosition(pn),
        text: () => latestPageCbs.current.onTextLayerRendered(pn),
      };
      pageCbsRef.current.set(pn, c);
    }
    return c;
  }

  // --- In-PDF find -----------------------------------------------------

  const matches = useMemo(
    () => (findOpen && pageIndexes ? findMatches(findQuery, pageIndexes) : []),
    [findOpen, findQuery, pageIndexes],
  );
  // Clamped: a query edit can shrink the match list under findCur.
  const cur = Math.min(findCur, Math.max(matches.length - 1, 0));

  // Shortcut-driven open (lib/shortcuts.ts dispatches PDF_FIND_EVENT). Focus
  // and select so a repeat Ctrl-F restarts the query.
  useEffect(() => {
    const onFind = () => {
      setFindOpen(true);
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    };
    window.addEventListener(PDF_FIND_EVENT, onFind);
    return () => window.removeEventListener(PDF_FIND_EVENT, onFind);
  }, []);

  // Extract every page's text once per document, on first open. Item order
  // matches customTextRenderer's items (both come from getTextContent()).
  useEffect(() => {
    const pdf = pdfDocRef.current;
    if (!findOpen || pageIndexes || !pdf) return;
    let cancelled = false;
    (async () => {
      const idx: PageIndex[] = [];
      try {
        for (let i = 1; i <= pdf.numPages; i++) {
          const content = await (await pdf.getPage(i)).getTextContent();
          idx.push(
            buildPageIndex(content.items.map((it) => ("str" in it ? it.str : ""))),
          );
        }
      } catch {
        // keep the partial index; find covers the pages that extracted
      }
      if (!cancelled && pdfDocRef.current === pdf) setPageIndexes(idx);
    })();
    return () => {
      cancelled = true;
    };
  }, [findOpen, pageIndexes, numPages]);

  const scrollToCurrentMark = useCallback(() => {
    const el = scrollerRef.current?.querySelector(".pdf-find-current");
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    findScrollPendingRef.current = false;
    return true;
  }, []);

  // A match jump only mounts the right page and arms the pending flag; the
  // mark exists once that page's text layer re-renders, so
  // onTextLayerRendered finishes the scroll.
  useEffect(() => {
    if (!findOpen || matches.length === 0) return;
    findScrollPendingRef.current = true;
    const m = matches[cur];
    const slot =
      scrollerRef.current?.querySelectorAll<HTMLElement>(".pdf-page-slot")[m.page - 1];
    if (!slot?.querySelector(".react-pdf__Page")) goToPage(m.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, matches, cur]);

  function onTextLayerRendered(pn: number) {
    if (!findScrollPendingRef.current) return;
    if (matches[cur]?.page === pn) scrollToCurrentMark();
  }

  function gotoMatch(i: number) {
    if (matches.length === 0) return;
    const next = ((i % matches.length) + matches.length) % matches.length;
    if (next === cur) {
      // wrapped onto itself (single match): still jump back to it
      findScrollPendingRef.current = true;
      if (!scrollToCurrentMark()) goToPage(matches[cur].page);
      return;
    }
    setFindCur(next);
  }

  // Per-page match ranges with the current-match flag baked in.
  const findRangesByPage = useMemo(() => {
    const byPage = new Map<number, HighlightRange[]>();
    matches.forEach((m, i) => {
      const list = byPage.get(m.page) ?? [];
      list.push({ start: m.start, end: m.end, current: i === cur });
      byPage.set(m.page, list);
    });
    return byPage;
  }, [matches, cur]);

  // Wraps each text item's matched slices in <mark> (react-pdf sanitizes the
  // returned HTML); undefined when idle so the text layer renders plainly.
  const findTextRenderer = useMemo(() => {
    if (!findOpen || !pageIndexes || findRangesByPage.size === 0) return undefined;
    return ({
      pageNumber,
      itemIndex,
      str,
    }: {
      pageNumber: number;
      itemIndex: number;
      str: string;
    }) => {
      const ranges = findRangesByPage.get(pageNumber);
      const start = pageIndexes[pageNumber - 1]?.starts[itemIndex];
      if (!ranges || start === undefined) return escapeHtml(str);
      return highlightHtml(str, rangesForItem(start, str.length, ranges));
    };
  }, [findOpen, pageIndexes, findRangesByPage]);

  // Right-drag = highlight gesture: the browser only drag-selects with the
  // left button, so we build the selection ourselves from caret positions and
  // commit it (default color) on release. Start caret captured at mousedown.
  const rightDragRef = useRef<{ node: Node; offset: number } | null>(null);

  function onRightDragMove(e: React.MouseEvent<HTMLDivElement>) {
    const start = rightDragRef.current;
    if (!start || !(e.buttons & 2)) return;
    const focus = caretAt(e.clientX, e.clientY);
    if (!focus) return;
    window.getSelection()?.setBaseAndExtent(
      start.node,
      start.offset,
      focus.node,
      focus.offset,
    );
  }

  function commitRightDrag(e: React.MouseEvent<HTMLDivElement>) {
    if (!rightDragRef.current) return;
    rightDragRef.current = null;
    const sel = window.getSelection();
    // No drag happened (plain right-click): nothing to commit.
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const anchor = selectionToAnchor(version, HIGHLIGHT_COLORS[0]);
    sel.removeAllRanges();
    if (!anchor) {
      setSelError(true);
      return;
    }
    setSelError(false);
    createMut.mutate({
      anchor,
      ...clampToViewport(e.clientX, e.clientY + 6, 280, 240),
    });
  }

  // On a real text selection inside a page, put the Highlight button at the
  // selection's end so one click commits the highlight (default color).
  function onMouseUp(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button === 2) {
      commitRightDrag(e);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    if (!sel.toString().trim()) return;
    const range = sel.getRangeAt(0);
    const startNode = range.startContainer;
    const startEl =
      startNode.nodeType === Node.ELEMENT_NODE
        ? (startNode as Element)
        : startNode.parentElement;
    if (!startEl?.closest(".react-pdf__Page")) return;
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    if (!last) return;
    // Capture NOW: the webview can collapse the selection before the button
    // click (observed on WebKitGTK), so the click commits this snapshot.
    const anchor = selectionToAnchor(version, HIGHLIGHT_COLORS[0]);
    if (!anchor) {
      console.error("[linxiv] selection capture failed", {
        page,
        quote: sel.toString().trim().slice(0, 80),
      });
      setSelError(true);
      return;
    }
    setSelError(false);
    setSelBar({ ...clampToViewport(last.left, last.bottom + 6, 120, 40), anchor });
  }

  // Creates immediately with the default color; the popup that opens after is
  // where the color/comment can be changed, so the happy path is one click.
  function commitHighlight() {
    const bar = selBar;
    if (!bar) return;
    setSelBar(null);
    window.getSelection()?.removeAllRanges();
    createMut.mutate({
      anchor: bar.anchor,
      top: bar.top,
      left: bar.left,
    });
  }

  // A click (not a drag-select) is hit-tested against the clicked page's
  // highlight rects; a hit opens the comment popup. Geometric because the
  // overlay is pointer-events:none, which keeps the text selectable.
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // was a selection
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const pageEl = target?.closest<HTMLElement>(".react-pdf__Page");
    if (!pageEl) return;
    const pageNum = Number(pageEl.getAttribute("data-page-number"));
    const list = byPage.get(pageNum);
    if (!list || list.length === 0) return;
    const box = pageEl.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const nx = (e.clientX - box.left) / box.width;
    const ny = (e.clientY - box.top) / box.height;
    const hit = list.find(({ anchor }) =>
      anchor.rects.some(
        (r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h,
      ),
    );
    if (!hit) return;
    const pos = clampToViewport(e.clientX, e.clientY + 6, 280, 240);
    const comment = metaById.get(hit.id)?.comment ?? "";
    setDraft(comment);
    setDraftColor(hit.anchor.color);
    updateMut.reset();
    deleteMut.reset();
    setPopup({
      id: hit.id,
      top: pos.top,
      left: pos.left,
      anchor: hit.anchor,
      comment,
      color: hit.anchor.color,
    });
  }

  // The annotation was deleted, or its server comment/color moved off the
  // popup's open-time baseline while the popup was open.
  const popupMeta = popup ? metaById.get(popup.id) : undefined;
  const popupStale = popup
    ? !popupMeta || popupMeta.comment !== popup.comment || popupMeta.color !== popup.color
    : false;
  const canSave = popup
    ? !updateMut.isPending &&
      !popupStale &&
      (draft !== popup.comment || draftColor !== popup.color)
    : false;

  function savePopup() {
    if (!popup || !canSave) return;
    updateMut.mutate({
      id: popup.id,
      comment: draft,
      // Only ship a new anchor when the color actually changed.
      anchor:
        draftColor !== popup.color
          ? JSON.stringify({ ...popup.anchor, color: draftColor })
          : undefined,
    });
  }

  return (
    <div className="relative w-full h-full min-h-0 flex flex-col">
      <div
        ref={attachScroller}
        onScroll={onScroll}
        onMouseDown={(e) => {
          // starting a new gesture dismisses any open chrome
          if (selBar) setSelBar(null);
          if (popup) setPopup(null);
          if (selError) setSelError(false);
          if (
            e.button === 2 &&
            (e.target as Element).closest?.(".react-pdf__Page")
          ) {
            rightDragRef.current = caretAt(e.clientX, e.clientY);
          }
        }}
        onMouseMove={onRightDragMove}
        onMouseUp={onMouseUp}
        onClick={onClick}
        // Right button is the highlight gesture inside the reader.
        onContextMenu={(e) => e.preventDefault()}
        className="w-full h-full overflow-y-auto bg-[#525659]"
      >
        <Document
          file={file}
          options={pdfDocumentOptions}
          onLoadSuccess={onDocumentLoad}
          loading={
            <div role="status" className="flex flex-col items-center justify-center gap-3 py-16 text-white/60 text-sm">
              <LogoMark size={48} className="animate-pulse" />
              Loading PDF…
            </div>
          }
          error={
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm">
              <span className="text-danger">Failed to load PDF.</span>
              {errorUrl && (
                <a
                  href={errorUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  Open in browser
                </a>
              )}
            </div>
          }
        >
          {/* Only pages within PAGE_WINDOW mount a canvas; the rest are
              fixed-height spacers that keep scroll offsets correct. The wrapper
              lets a mid-drag resize scaleX the whole group (see attachScroller)
              instead of reflowing every page. will-change-transform goes on the
              canvas slots only — promoting spacers too would make hundreds of
              pointless layers on a long PDF. */}
          <div ref={pagesWrapRef}>
            {Array.from({ length: numPages }, (_, i) => {
              const pn = i + 1;
              const pageWidth = width ? width - PAGE_INSET : undefined;
              if (Math.abs(pn - page) > PAGE_WINDOW) {
                return (
                  <div
                    key={pn}
                    className="pdf-page-slot mx-auto my-2"
                    style={{ width: pageWidth, height: estPageHeight(width) }}
                  />
                );
              }
              return (
                <div key={pn} className="pdf-page-slot mx-auto my-2 will-change-transform">
                  <Page
                    pageNumber={pn}
                    width={pageWidth}
                    devicePixelRatio={pdfCanvasDpr(zoom)}
                    onRenderSuccess={pageCbs(pn).render}
                    onRenderTextLayerSuccess={pageCbs(pn).text}
                    customTextRenderer={findTextRenderer}
                    loading={
                      <div
                        className="bg-white"
                        style={{ width: pageWidth, height: estPageHeight(width) }}
                      />
                    }
                    className="shadow-md"
                    renderTextLayer
                    renderAnnotationLayer
                  >
                    <HighlightLayer highlights={byPage.get(pn) ?? []} />
                  </Page>
                </div>
              );
            })}
          </div>
        </Document>
      </div>

      <PagePill page={page} total={numPages} onGo={goToPage} />

      {findOpen && (
        <div
          className="absolute top-3 right-5 z-30 flex items-center gap-1.5 rounded-md bg-panel border border-border shadow-card px-2 py-1.5"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setFindOpen(false);
            } else if (e.key === "Enter") {
              e.preventDefault();
              gotoMatch(cur + (e.shiftKey ? -1 : 1));
            }
          }}
        >
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              setFindCur(0);
            }}
            placeholder="Find in PDF"
            autoFocus
            className="w-44 bg-transparent text-xs text-text placeholder:text-muted focus:outline-none"
          />
          <span className="font-mono text-xs text-muted tabular-nums whitespace-nowrap">
            {findQuery === ""
              ? ""
              : pageIndexes === null
                ? "…"
                : `${matches.length === 0 ? 0 : cur + 1}/${matches.length}`}
          </span>
          <button
            aria-label="Previous match"
            disabled={matches.length === 0}
            onClick={() => gotoMatch(cur - 1)}
            className="text-muted hover:text-text disabled:opacity-40 disabled:pointer-events-none p-0.5"
          >
            <ChevronUp size={14} />
          </button>
          <button
            aria-label="Next match"
            disabled={matches.length === 0}
            onClick={() => gotoMatch(cur + 1)}
            className="text-muted hover:text-text disabled:opacity-40 disabled:pointer-events-none p-0.5"
          >
            <ChevronDown size={14} />
          </button>
          <button
            aria-label="Close find bar"
            onClick={() => setFindOpen(false)}
            className="text-muted hover:text-text p-0.5"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {selBar && (
        <div
          className="fixed z-30 flex items-center gap-1.5 rounded-full bg-panel border border-border shadow-card px-2 py-1.5"
          style={{ top: selBar.top, left: selBar.left }}
          // preventDefault keeps the selection alive for commitHighlight;
          // stopPropagation keeps the container's mousedown/up from clearing or
          // re-opening this toolbar mid-click, cancelling the swatch click.
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseUp={(e) => e.stopPropagation()}
        >
          <button
            onClick={commitHighlight}
            className="flex items-center gap-1.5 text-xs font-medium text-text hover:text-accent"
          >
            <span
              className="w-3 h-3 rounded-full border border-black/20"
              style={{ backgroundColor: HIGHLIGHT_COLORS[0] }}
              aria-hidden
            />
            Highlight
          </button>
        </div>
      )}

      {popup && (
        <div
          className="fixed z-30 w-[280px] rounded-md bg-panel border border-border shadow-card p-2.5 flex flex-col gap-2"
          style={{ top: popup.top, left: popup.left }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onKeyDown={submitOnCtrlEnter(savePopup)}
        >
          {popup.anchor.quote && (
            <p className="text-xs text-muted line-clamp-3 italic">
              “{popup.anchor.quote}”
            </p>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment…"
            rows={3}
            autoFocus
            className="w-full resize-none rounded border border-border bg-surface2 px-2 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
          />
          <div className="flex items-center justify-between">
            <ColorSwatches value={draftColor} onChange={setDraftColor} />
            <div className="flex items-center gap-3">
              <button
                disabled={deleteMut.isPending || updateMut.isPending}
                onClick={() => deleteMut.mutate(popup.id)}
                className="text-xs font-medium text-[var(--color-danger)] hover:underline disabled:opacity-50"
              >
                {deleteMut.isPending ? "Deleting…" : "Delete"}
              </button>
              <button
                disabled={!canSave}
                onClick={savePopup}
                className="text-xs font-medium text-accent hover:underline disabled:opacity-40"
              >
                {updateMut.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
          {popupStale && (
            <p className="text-xs" style={{ color: "var(--color-danger)" }}>
              Annotation was updated elsewhere. Reopen it before saving.
            </p>
          )}
        </div>
      )}

      {(createMut.isError || updateMut.isError || deleteMut.isError || selError) && (
        <div
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-30 rounded-md bg-panel border border-border shadow-card px-3 py-1.5 text-xs"
          style={{ color: "var(--color-danger)" }}
        >
          {selError
            ? "Couldn't capture that selection. Try selecting the text again."
            : createMut.isError
              ? "Couldn't save highlight. Try again."
              : updateMut.isError
                ? "Couldn't save annotation. Try again."
                : "Couldn't delete highlight. Try again."}
        </div>
      )}
    </div>
  );
}

// Caret (text position) under a viewport point. WebKit/Chromium expose
// caretRangeFromPoint; Firefox only caretPositionFromPoint.
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  const p = doc.caretPositionFromPoint?.(x, y);
  return p ? { node: p.offsetNode, offset: p.offset } : null;
}

// Keep a fixed floater (toolbar/popup) on-screen near the right/bottom edges;
// w/h are its approximate size.
function clampToViewport(left: number, top: number, w: number, h: number) {
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - w)),
    top: Math.max(8, Math.min(top, window.innerHeight - h)),
  };
}
