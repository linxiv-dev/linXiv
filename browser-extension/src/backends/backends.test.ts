import { test } from "node:test";
import assert from "node:assert/strict";

import { toPreview } from "../extractors/index.ts";
import type { ClipFields } from "../types";
import { textToBase64 } from "./bytes.ts";
import { deepLinkFor, desktopBackend } from "./desktop.ts";
import { headlessBackend } from "./headless.ts";
import { baseOf, originPattern, sendsTokenInClear, type Fetcher } from "./http.ts";
import { pdfTabState, savePdfTab } from "../pdfTab.ts";
import { BackendError } from "./types.ts";

const clip = (fields: ClipFields, url = "https://x.example/a") => toPreview(fields, {}, url, undefined);
const doiClip = () => clip({ type: "article", doi: "10.5555/a/b", title: "T", authors: ["A B"] });
interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
  credentials?: string;
}

function server(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url,
      headers: new Headers(init.headers),
      body: init.body,
      credentials: init.credentials,
    };
    calls.push(call);
    const route = routes[`${call.method} ${new URL(url).pathname}`];
    return route ? route(call) : new Response("{}", { status: 404 });
  }) as unknown as Fetcher;
  return { calls, fetcher };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

test("headless: saves metadata and nothing else", async () => {
  const { calls, fetcher } = server({
    "POST /api/papers/import/bibtex": () => json({ saved_count: 1, source_ids: ["doi:10.5555/a/b"] }),
  });

  const result = await headlessBackend("http://h:8000/", "tok", fetcher).save([doiClip()]);

  assert.deepEqual(result, { status: "saved", ids: ["doi:10.5555/a/b"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get("authorization"), "Bearer tok");
  assert.equal(calls[0].credentials, "omit");
  assert.equal(calls[0].url, "http://h:8000/api/papers/import/bibtex");
  assert.match(decode(JSON.parse(calls[0].body as string).file_b64), /doi = \{10\.5555\/a\/b\}/);
});

test("a PDF tab saves metadata too, with nothing fetched", async () => {
  const { calls, fetcher } = server({ "POST /api/papers/import/bibtex": () => json({ source_ids: ["local:abc"] }) });
  const pdfTab = toPreview({ pdfUrl: "https://x.example/t.pdf" }, {}, "https://x.example/t.pdf", "t.pdf", true);

  assert.deepEqual(await headlessBackend("http://h", "t", fetcher).save([pdfTab]), { status: "saved", ids: ["local:abc"] });
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/api/papers/import/bibtex"]);
  assert.match(deepLinkFor([pdfTab]), /^linxiv-clip:\/\/add\?bibtex=/);
});

test("headless: several items in one request", async () => {
  const { calls, fetcher } = server({ "POST /api/papers/import/bibtex": () => json({ source_ids: ["a", "b"] }) });
  const result = await headlessBackend("http://h", "t", fetcher).save([doiClip(), clip({ title: "Other" })]);

  assert.deepEqual(result, { status: "saved", ids: ["a", "b"] });
  assert.equal(calls.length, 1);
});

test("headless: errors say what to do", async () => {
  const rejected = server({ "POST /api/papers/import/bibtex": () => json({ detail: "no" }, 401) });
  await assert.rejects(headlessBackend("http://h", "bad", rejected.fetcher).save([doiClip()]), /rejected the token/);

  const failing = server({ "POST /api/papers/import/bibtex": () => json({ detail: "Invalid base64" }, 400) });
  await assert.rejects(headlessBackend("http://h", "t", failing.fetcher).save([doiClip()]), /Invalid base64/);

  const down = (async () => {
    throw new TypeError("NetworkError");
  }) as unknown as Fetcher;
  await assert.rejects(headlessBackend("http://h:1", "t", down).save([doiClip()]), (error: Error) => {
    assert.ok(error instanceof BackendError);
    return /Can't reach http:\/\/h:1/.test(error.message);
  });
});

test("headless probe recognizes the server, and other servers", async () => {
  const good = server({ "GET /api/status": () => json({ version: "0.7.1", node_bound: true }) });
  const probe = await headlessBackend("http://h", "t", good.fetcher).probe();
  assert.equal(probe.ok, true);
  assert.equal(probe.version, "0.7.1");

  const other = server({ "GET /api/status": () => json({ status: "ok" }) });
  assert.equal((await headlessBackend("http://h", "t", other.fetcher).probe()).ok, false);

  const html = server({ "GET /api/status": () => new Response("<html>") });
  assert.equal((await headlessBackend("http://h", "t", html.fetcher).probe()).ok, false);

  const denied = server({ "GET /api/status": () => json({}, 401) });
  assert.match((await headlessBackend("http://h", "t", denied.fetcher).probe()).message, /rejected the token/);
});

test("desktop: one bibtex link", async () => {
  const opened: string[] = [];
  const result = await desktopBackend(async (url) => opened.push(url)).save([doiClip()]);

  assert.deepEqual(result, { status: "sent", ids: [] });
  assert.match(opened[0], /^linxiv-clip:\/\/add\?bibtex=/);
});

test("base64 keeps non-ASCII text", () => {
  assert.equal(decode(textToBase64("Schrödinger")), "Schrödinger");
  assert.equal(decode(textToBase64("x".repeat(200_000))).length, 200_000);
});

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 body");
const SIGNED = "https://pdf.example/x/main.pdf?X-Amz-Expires=300&X-Amz-Security-Token=secret";
const answers = (body: Uint8Array | string, status = 200) =>
  (async () => new Response(body as BodyInit, { status })) as unknown as typeof fetch;

test("PDF tab, headless: bytes go to import, and the signed link doesn't", async () => {
  const { calls, fetcher } = server({ "POST /api/papers/import/pdf": () => json({ source_id: "doi:10.1/x", title: "From the file" }) });

  const outcome = await savePdfTab(headlessBackend("http://h", "t", fetcher), SIGNED, answers(PDF_BYTES));

  assert.deepEqual(outcome, { kind: "saved", id: "doi:10.1/x", title: "From the file" });
  const body = JSON.parse(calls[0].body as string);
  assert.equal(decode(body.file_b64), "%PDF-1.4 body");
  assert.equal(body.filename, "main.pdf");
  assert.equal(String(calls[0].body).includes("secret"), false);
});

test("PDF tab, desktop: URL handed over, nothing fetched", async () => {
  const opened: string[] = [];
  const noFetch = (async () => {
    throw new Error("should not fetch");
  }) as unknown as typeof fetch;

  const backend = desktopBackend(async (url) => opened.push(url));

  assert.deepEqual(await savePdfTab(backend, "https://x.example/a.pdf", noFetch), { kind: "sent" });
  assert.equal(opened[0], `linxiv-clip://add?input=${encodeURIComponent("https://x.example/a.pdf")}`);
  assert.deepEqual(await savePdfTab(backend, "https://arxiv.org/pdf/1706.03762", noFetch), { kind: "not-pdf" });

  // A protected link is refused before anything reaches the app.
  const sent = opened.length;
  await assert.rejects(savePdfTab(backend, SIGNED, noFetch), /desktop app can't download this protected link/);
  assert.equal(opened.length, sent);
});

test("PDF tab: a non-PDF falls back, an expired link says so, a blocked fetch asks", async () => {
  const backend = headlessBackend("http://h", "t", server({}).fetcher);

  assert.deepEqual(await savePdfTab(backend, "https://x.example/a.pdf", answers("<html>")), { kind: "not-pdf" });
  await assert.rejects(savePdfTab(backend, SIGNED, answers("<html>")), /web page, not the file/);
  await assert.rejects(savePdfTab(backend, SIGNED, answers("<html><title> Other page </title>")), /titled "Other page"/);

  // A security check saves nothing, signed link or not.
  const check = /pdf\.example's security check blocked the addon.*attach the PDF in linXiv/;
  await assert.rejects(savePdfTab(backend, SIGNED, answers("<html><title>Security verification</title>")), check);
  await assert.rejects(savePdfTab(backend, "https://pdf.example/a.pdf", answers("<title>Just a moment...</title>")), check);
  await assert.rejects(savePdfTab(backend, SIGNED, answers("gone", 403)), /may have expired/);

  const blocked = (async () => {
    throw new TypeError("NetworkError");
  }) as unknown as typeof fetch;
  assert.deepEqual(await savePdfTab(backend, SIGNED, blocked), { kind: "needs-access" });
});

test("PDF tab: a security check gets a page to run in, then the file is read", async () => {
  const CHECK = "<html><title>Security verification</title>";

  function setup(answersInOrder: (Uint8Array | string)[]) {
    const log: string[] = [];
    let call = 0;
    const fetcher = (async () => {
      const body = answersInOrder[Math.min(call, answersInOrder.length - 1)];
      call += 1;
      return new Response(body as BodyInit);
    }) as unknown as typeof fetch;
    const opener = {
      open: async (url: string) => {
        log.push(`open ${url}`);
        return async () => {
          log.push("close");
        };
      },
      wait: async () => undefined,
    };
    return { log, fetcher, opener, calls: () => call };
  }

  const { calls: uploads, fetcher: upload } = server({ "POST /api/papers/import/pdf": () => json({ source_id: "doi:10.1/x", title: "T" }) });
  const backend = headlessBackend("http://h", "t", upload);

  const passes = setup([CHECK, CHECK, PDF_BYTES]);
  assert.deepEqual(await savePdfTab(backend, SIGNED, passes.fetcher, passes.opener), { kind: "saved", id: "doi:10.1/x", title: "T" });
  assert.deepEqual(passes.log, [`open ${SIGNED}`, "close"]);
  assert.equal(passes.calls(), 3);
  assert.equal(uploads.length, 1);

  const stuck = setup([CHECK]);
  // Still unsolved: the tab stays open, because the user may be solving it.
  await assert.rejects(savePdfTab(backend, SIGNED, stuck.fetcher, stuck.opener), /Solve the security check in the new tab/);
  assert.deepEqual(stuck.log, [`open ${SIGNED}`]);
  assert.equal(stuck.calls(), 11);
  assert.equal(uploads.length, 1);

  const open = setup([PDF_BYTES]);
  await savePdfTab(backend, SIGNED, open.fetcher, open.opener);
  assert.deepEqual(open.log, []);
});

test("a signed link never reaches a saved record", async () => {
  const preview = toPreview({}, {}, SIGNED, "Paper", true);
  assert.equal(preview.canonicalUrl, "https://pdf.example/x/main.pdf");

  const { calls, fetcher } = server({ "POST /api/papers/import/bibtex": () => json({ source_ids: ["local:a"] }) });
  await headlessBackend("http://h", "t", fetcher).save([preview]);
  const sent = decode(JSON.parse(calls[0].body as string).file_b64);
  assert.equal(sent.includes("secret"), false);
  assert.equal(sent.includes("X-Amz"), false);

  const fromPage = toPreview({ url: SIGNED }, {}, "https://x.example/a", "Paper");
  assert.equal(fromPage.canonicalUrl, "https://pdf.example/x/main.pdf");

  const ordinary = toPreview({}, {}, "https://x.example/a?id=3&b=4#top", "Paper");
  assert.equal(ordinary.canonicalUrl, "https://x.example/a?id=3&b=4");
});

test("addresses", () => {
  assert.equal(baseOf(" http://h:8000// "), "http://h:8000");
  assert.equal(originPattern("http://127.0.0.1:8100/x"), "http://127.0.0.1/*");
  assert.equal(originPattern("https://a.example/"), "https://a.example/*");
});

test("token sent in clear: http to another machine only", () => {
  assert.equal(sendsTokenInClear("http://192.168.1.20:8100"), true);
  assert.equal(sendsTokenInClear("http://nas.local:8100/"), true);
  assert.equal(sendsTokenInClear("http://127.0.0.1:8100"), false);
  assert.equal(sendsTokenInClear("http://127.4.5.6"), false);
  assert.equal(sendsTokenInClear(" http://localhost:8100 "), false);
  assert.equal(sendsTokenInClear("http://[::1]:8100"), false);
  assert.equal(sendsTokenInClear("https://192.168.1.20"), false);
  assert.equal(sendsTokenInClear("not a url"), false);
  assert.equal(sendsTokenInClear(""), false);
});

test("PDF tab state: Chrome's viewer, Firefox's viewer, and pages that only look blocked", () => {
  assert.equal(pdfTabState("https://x.example/paper", { contentType: "application/pdf" }), "pdf");
  assert.equal(pdfTabState("https://x.example/a.PDF", { blocked: true }), "pdf");
  assert.equal(pdfTabState("https://arxiv.org/pdf/1706.03762", { blocked: true }), "maybe-pdf");
  assert.equal(pdfTabState("https://addons.mozilla.org/en-US/firefox/", { blocked: true }), "maybe-pdf");
  assert.equal(pdfTabState("about:addons", { blocked: true }), "page");
  assert.equal(pdfTabState("chrome://extensions/", { blocked: true }), "page");
  assert.equal(pdfTabState("https://x.example/a.pdf", { contentType: "text/html" }), "page");
  assert.equal(pdfTabState("https://x.example/article", {}), "page");
});

test("PDF tab: a file the server says is too big is refused before download", async () => {
  const backend = headlessBackend("http://h", "t", server({}).fetcher);
  let read = false;
  const huge = (async () => {
    const response = new Response(PDF_BYTES, { headers: { "content-length": String(200 * 1024 * 1024) } });
    response.arrayBuffer = async () => {
      read = true;
      throw new Error("downloaded the body");
    };
    return response;
  }) as unknown as typeof fetch;

  await assert.rejects(savePdfTab(backend, "https://x.example/a.pdf", huge), /over the 100 MB limit/);
  assert.equal(read, false);

  // No length header: the file is read, then measured.
  const { calls, fetcher } = server({ "POST /api/papers/import/pdf": () => json({ source_id: "s" }) });
  const unsized = (async () => new Response(PDF_BYTES)) as unknown as typeof fetch;
  assert.deepEqual(await savePdfTab(headlessBackend("http://h", "t", fetcher), "https://x.example/a.pdf", unsized), {
    kind: "saved",
    id: "s",
    title: undefined,
  });
  assert.equal(calls.length, 1);
});
