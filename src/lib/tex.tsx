import { useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
// MathJax v4 dropped AllPackages: each TeX extension registers itself on
// import. This is every shipped extension except the ones excluded below —
// html/texhtml emit raw HTML nodes (XSS), require/setoptions can re-enable
// them (\require{html}), newcommand/configmacros/begingroup persist macro
// definitions across renders on the shared mjDoc, and autoload needs require.
import "@mathjax/src/js/input/tex/action/ActionConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/amscd/AmsCdConfiguration.js";
import "@mathjax/src/js/input/tex/bbm/BbmConfiguration.js";
import "@mathjax/src/js/input/tex/bboldx/BboldxConfiguration.js";
import "@mathjax/src/js/input/tex/bbox/BboxConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/braket/BraketConfiguration.js";
import "@mathjax/src/js/input/tex/bussproofs/BussproofsConfiguration.js";
import "@mathjax/src/js/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/js/input/tex/cases/CasesConfiguration.js";
import "@mathjax/src/js/input/tex/centernot/CenternotConfiguration.js";
import "@mathjax/src/js/input/tex/color/ColorConfiguration.js";
import "@mathjax/src/js/input/tex/colortbl/ColortblConfiguration.js";
import "@mathjax/src/js/input/tex/colorv2/ColorV2Configuration.js";
import "@mathjax/src/js/input/tex/dsfont/DsfontConfiguration.js";
import "@mathjax/src/js/input/tex/empheq/EmpheqConfiguration.js";
import "@mathjax/src/js/input/tex/enclose/EncloseConfiguration.js";
import "@mathjax/src/js/input/tex/extpfeil/ExtpfeilConfiguration.js";
import "@mathjax/src/js/input/tex/fontsizev3/FontSizeV3Configuration.js";
import "@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js";
import "@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js";
import "@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js";
import "@mathjax/src/js/input/tex/noerrors/NoErrorsConfiguration.js";
import "@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import "@mathjax/src/js/input/tex/physics/PhysicsConfiguration.js";
import "@mathjax/src/js/input/tex/tagformat/TagFormatConfiguration.js";
import "@mathjax/src/js/input/tex/textcomp/TextcompConfiguration.js";
import "@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js";
import "@mathjax/src/js/input/tex/unicode/UnicodeConfiguration.js";
import "@mathjax/src/js/input/tex/units/UnitsConfiguration.js";
import "@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js";
import "@mathjax/src/js/input/tex/verb/VerbConfiguration.js";
import { getSettings } from "../api/settings";
import type { Settings } from "../types/api";

const mathPackages = [
  "base",
  "action",
  "ams",
  "amscd",
  "bbm",
  "bboldx",
  "bbox",
  "boldsymbol",
  "braket",
  "bussproofs",
  "cancel",
  "cases",
  "centernot",
  "color",
  "colortbl",
  "colorv2",
  "dsfont",
  "empheq",
  "enclose",
  "extpfeil",
  "fontsizev3",
  "gensymb",
  "mathtools",
  "mhchem",
  "noerrors",
  "noundefined",
  "physics",
  "tagformat",
  "textcomp",
  "textmacros",
  "unicode",
  "units",
  "upgreek",
  "verb",
];

// v4's default font (newcm) ships rarely-used glyph ranges (\mathcal,
// \mathfrak, arrows, …) as separate files loaded on demand via
// mathjax.asyncLoad. Map its bare specifiers onto lazy Vite chunks so they
// stay out of the main bundle (~10MB total).
const dynamicFontFiles = import.meta.glob(
  "/node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/*.js",
);
mathjax.asyncLoad = (name: string) => {
  const path = name.replace(
    /^@mathjax\/mathjax-newcm-font\/js\//,
    "/node_modules/@mathjax/mathjax-newcm-font/mjs/",
  );
  const load = dynamicFontFiles[path];
  return load ? load() : Promise.reject(new Error(`Can't load '${name}'`));
};

// A convert() that hits an unloaded glyph range throws with a `retry` promise
// (raw TeX is shown for that render); when the font chunk arrives, bump the
// epoch so subscribed MathText components re-render and convert succeeds.
let fontEpoch = 0;
const fontListeners = new Set<() => void>();
const subscribeFonts = (fn: () => void) => {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
};
function notifyFontLoaded() {
  fontEpoch++;
  for (const fn of fontListeners) fn();
}

// MathJax SVG pipeline, set up once. liteAdaptor renders to an HTML string we
// inject; fontCache "none" inlines glyph paths per container.
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const svgOutput = new SVG({ fontCache: "none" });
const mjDoc = mathjax.document("", {
  InputJax: new TeX({ packages: mathPackages }),
  OutputJax: svgOutput,
});

// MathJax's container stylesheet (display/overflow/direction rules) is added to
// the document once; the SVG glyphs themselves use fill=currentColor.
if (typeof document !== "undefined" && !document.head.querySelector("[data-mathjax]")) {
  const css = adaptor.textContent(
    svgOutput.styleSheet(mjDoc) as Parameters<typeof adaptor.textContent>[0],
  );
  if (css) {
    const style = document.createElement("style");
    style.setAttribute("data-mathjax", "");
    style.textContent = css;
    document.head.appendChild(style);
  }
}

const selectTexEnabled = (s: Settings) => s.tex_rendering_enabled !== false;

export function useTexEnabled(): boolean {
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    select: selectTexEnabled,
  });
  return data ?? true;
}

// $$...$$ (display) or $...$ (inline). Inline requires a non-space just inside
// each delimiter: (?!\s) guards the open $ and the trailing [^$\s] guards the
// close $. An unpaired opener like the first $ in "$5 and $6" matches nothing;
// a paired "$5$" still renders as math. Inline is kept to a single line ([^$\n])
// so two stray `$` on consecutive lines (currency, $VAR) don't merge into math;
// display $$…$$ may still span lines.
const MATH_RE = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]*?[^$\s])\$/g;

function mathHtml(tex: string, display: boolean): string | null {
  if (!tex.trim()) return null;
  try {
    return adaptor.outerHTML(mjDoc.convert(tex, { display }));
  } catch (err) {
    const retry = (err as { retry?: Promise<unknown> } | null)?.retry;
    if (retry instanceof Promise) retry.then(notifyFontLoaded, () => {});
    return null;
  } finally {
    mjDoc.clear(); // drop the stored node so mjDoc.math doesn't grow per render
  }
}

function toNodes(text: string, forceInline: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(MATH_RE)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const isDisplay = m[1] !== undefined;
    const display = isDisplay && !forceInline;
    const tex = (isDisplay ? m[1] : m[2]) as string;
    const html = mathHtml(tex, display);
    if (html === null) {
      nodes.push(m[0]); // empty or unrenderable — keep the raw delimited source
    } else {
      nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Render a string, turning $…$ / $$…$$ spans into MathJax SVG. When TeX is
// disabled or the string has no `$`, the raw text is returned unchanged.
// forceInline renders display math inline so callers inside line-clamp spans
// don't get a display:block container promoted out of the inline box.
export function MathText({
  children,
  forceInline = false,
}: {
  children: string | null | undefined;
  forceInline?: boolean;
}) {
  const enabled = useTexEnabled();
  useSyncExternalStore(subscribeFonts, () => fontEpoch);
  const text = children ?? "";
  if (!enabled || !text.includes("$")) return <>{text}</>;
  return <>{toNodes(text, forceInline)}</>;
}
