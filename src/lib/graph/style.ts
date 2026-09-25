// The cytoscape stylesheet, resolved from the same live `ThemeColors` every
// other surface is painted from.

import type { StylesheetJson } from "cytoscape";
import type { ThemeColors } from "../theme.ts";

/** Authors get no theme colour: `ThemeColors` has no fourth semantic token.
 *  Type is also carried by shape (paper ellipse, author diamond, tag
 *  round-rectangle), so this fixed hue only has to read as "not the accent". */
export const AUTHOR_COLOR = "#e8a838";

/** The app's own stack from globals.css; cytoscape wants it bare, unquoted. */
export const LABEL_FONT_FAMILY = "Inter";
export const LABEL_FONT = `${LABEL_FONT_FAMILY}, system-ui, sans-serif`;
/** Longest a stalled webfont request may hold up the first render. */
export const FONT_LOAD_TIMEOUT_MS = 3000;

export const DIM_OPACITY = 0.08; // filter dim (isolate / non-matching)
export const SEL_DIM_OPACITY = 0.28; // softer dim for non-selected nodes
export const FULL_OPACITY = 1;

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 10;

/** Label caps (px) and sizes for the two ellipsized node types. */
export const PAPER_LABEL = { size: 13, maxWidth: 180 };
export const AUTHOR_LABEL = { size: 12, maxWidth: 140 };

/**
 * Cut `text` to fit `maxWidth`, ending in "…". Done once per payload in place
 * of cytoscape's `text-wrap: ellipsis`, which re-measures the label a character
 * at a time on every position change: on a real 1.3k-node graph that was most
 * of each layout tick.
 */
export function ellipsize(text: string, maxWidth: number, width: (s: string) => number): string {
  if (width(text) < maxWidth) return text;
  // Longest prefix whose ellipsized width still fits.
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(text.slice(0, mid) + "…") <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** Label width in px as cytoscape measures it: same font string, rounded up. */
export function labelWidth(size: number): (s: string) => number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `normal 600 ${size}px ${LABEL_FONT}`;
  return (s) => Math.ceil(ctx.measureText(s).width);
}

export function paperColor(t: ThemeColors): string {
  return t.accent;
}
export function tagColor(t: ThemeColors): string {
  return t.success;
}
export function highlightColor(t: ThemeColors): string {
  return t.danger;
}

export function graphStylesheet(t: ThemeColors): StylesheetJson {
  return [
    {
      selector: 'node[type = "paper"]',
      style: {
        shape: "ellipse",
        width: 20,
        height: 20,
        "background-color": paperColor(t),
        label: "data(display)",
        "font-size": 13,
        "font-weight": 600,
        // Theme text with a background-coloured halo over edges/nodes.
        color: t.text,
        "text-outline-color": t.bg,
        "text-outline-width": 2.5,
        "text-outline-opacity": 1,
        // Stop rendering labels below ~7px on-screen.
        "min-zoomed-font-size": 7,
        "font-family": LABEL_FONT,
        "text-valign": "center",
        "text-halign": "right",
        "text-margin-x": 8,
        "border-width": 1.5,
        "border-color": t.bg,
      },
    },
    {
      selector: 'node[type = "author"]',
      style: {
        shape: "diamond",
        width: 14,
        height: 14,
        "background-color": AUTHOR_COLOR,
        label: "data(display)",
        "font-size": 12,
        "font-weight": 600,
        color: t.text,
        "text-outline-color": t.bg,
        "text-outline-width": 2.5,
        "text-outline-opacity": 1,
        "min-zoomed-font-size": 7,
        "font-family": LABEL_FONT,
        "text-valign": "center",
        "text-halign": "right",
        "text-margin-x": 7,
      },
    },
    {
      selector: 'node[type = "tag"]',
      style: {
        shape: "round-rectangle",
        width: "label",
        height: 20,
        // One length, NOT the CSS `0 7px` shorthand this was ported as:
        // cytoscape's `padding` is a single `sizeMaybePercent`, so a two-token
        // string misses its unit regex, silently parseFloats to 0, and — with
        // `width: "label"` — draws each chip hard against its text. The explicit
        // height above stops this from padding vertically too.
        padding: "7px",
        "background-color": tagColor(t),
        label: "data(label)",
        "font-size": 12,
        "font-weight": 600,
        // Label sits inside the chip: white on a neutral scrim, readable
        // whatever hue `t.success` is.
        color: "#ffffff",
        "text-outline-color": "rgba(0,0,0,0.55)",
        "text-outline-width": 1.5,
        "text-outline-opacity": 1,
        "min-zoomed-font-size": 7,
        "font-family": LABEL_FONT,
        "text-valign": "center",
        "text-halign": "center",
        "border-width": 0,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": t.border,
        "curve-style": "haystack",
      },
    },
  ] as StylesheetJson;
}

/**
 * Cytoscape caches label measurements on the RENDERER, keyed by text plus font
 * style and not by whether the family had arrived. Inter is a self-hosted
 * webfont, so on a cold load every label can be measured in the fallback face
 * and keep that width all session: tag chips (`width: 'label'`) size wrong and
 * `ellipsize` cuts labels at the wrong point. Reinstalling the stylesheet
 * later does NOT help — have the face in hand before the first render.
 */
export function whenLabelFontReady(): Promise<void> {
  const fonts = typeof document === "undefined" ? null : document.fonts;
  if (!fonts?.load) return Promise.resolve();
  // Past the timeout, draw in the fallback face rather than not at all.
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    fonts.load(`600 13px ${LABEL_FONT_FAMILY}`).then(done, done);
  });
}

/** The opacity one element is painted at: filtered out → the filter dim (0
 *  under isolate); selected → full; visible but unselected while something IS
 *  selected → a softer dim; otherwise full. */
export function opacityFor(
  filterVisible: boolean,
  selected: boolean,
  anySelected: boolean,
  isolate: boolean
): number {
  if (!filterVisible) return isolate ? 0 : DIM_OPACITY;
  if (selected) return FULL_OPACITY;
  return anySelected ? SEL_DIM_OPACITY : FULL_OPACITY;
}

/**
 * Cytoscape hit-tests from `events` / `visibility` / `display`, never opacity,
 * so an element the isolate filter took to opacity 0 stays fully clickable:
 * taps on apparently blank canvas navigated to papers the user couldn't see,
 * dragged them, and ate the background tap that clears the selection. So gate
 * `events` on opacity here.
 */
export function eventsFor(opacity: number): "yes" | "no" {
  return opacity === 0 ? "no" : "yes";
}
