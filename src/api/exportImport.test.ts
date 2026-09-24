// Run: node --experimental-transform-types --test src/api/exportImport.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  commitImport,
  exportBibtex,
  exportProject,
  importBibtex,
  importPdf,
  importPdfUrl,
  previewImport,
  recognizePaperInput,
} from "./exportImport.ts";

// Node has no window, so these run the browser-dev `fetch` path.
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let respond: () => Response = () => Response.json({});

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({
    url,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
  });
  return respond();
}) as typeof fetch;

// Captures what triggerDownload hands the browser.
let downloads: { href: string; download: string }[] = [];
Object.assign(globalThis, {
  document: {
    createElement: () => ({ click() {} }),
    body: {
      appendChild: (a: { href: string; download: string }) => downloads.push(a),
      removeChild() {},
    },
  },
});
URL.createObjectURL = () => "blob:x";
URL.revokeObjectURL = () => {};

beforeEach(() => {
  calls = [];
  downloads = [];
  respond = () => Response.json({});
});

const file = (text: string, name = "f.bin") => new File([text], name);

test("recognizePaperInput posts the raw input", async () => {
  respond = () => Response.json({ kind: "doi", value: "10.1/x" });
  assert.deepEqual(await recognizePaperInput(" 10.1/x "), { kind: "doi", value: "10.1/x" });
  assert.deepEqual(calls, [
    { url: "/api/papers/import/recognize", method: "POST", body: { input: " 10.1/x " } },
  ]);
});

test("importPdfUrl only sends project_id when given", async () => {
  await importPdfUrl("https://x/a.pdf");
  await importPdfUrl("https://x/a.pdf", 7);
  assert.deepEqual(
    calls.map((c) => c.body),
    [{ url: "https://x/a.pdf" }, { url: "https://x/a.pdf", project_id: 7 }]
  );
  assert.ok(calls.every((c) => c.url === "/api/papers/import/pdf-url"));
});

test("importBibtex base64-encodes the file and scopes to a project", async () => {
  await importBibtex(file("@article{a}"), 3);
  assert.deepEqual(calls[0], {
    url: "/api/papers/import/bibtex",
    method: "POST",
    body: { file_b64: btoa("@article{a}"), project_id: 3 },
  });
});

test("importPdf puts the project in the query string, not the body", async () => {
  await importPdf(file("%PDF", "paper.pdf"));
  await importPdf(file("%PDF", "paper.pdf"), 9);
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/papers/import/pdf", "/api/papers/import/pdf?project_id=9"]
  );
  assert.deepEqual(calls[1].body, { file_b64: btoa("%PDF"), filename: "paper.pdf" });
});

test("previewImport and commitImport send the archive; commit defaults to merge", async () => {
  await previewImport(file("zip"));
  await commitImport(file("zip"));
  await commitImport(file("zip"), "overwrite");
  assert.deepEqual(
    calls.map((c) => [c.url, c.body]),
    [
      ["/api/projects/import/preview", { file_b64: btoa("zip") }],
      ["/api/projects/import/commit", { file_b64: btoa("zip"), on_conflict: "merge" }],
      ["/api/projects/import/commit", { file_b64: btoa("zip"), on_conflict: "overwrite" }],
    ]
  );
});

test("an error envelope surfaces its detail as ApiError", async () => {
  respond = () => Response.json({ detail: "not a pdf" }, { status: 422 });
  await assert.rejects(importPdfUrl("x"), { name: "ApiError", status: 422, message: "not a pdf" });
});

test("exportProject downloads under the server's Content-Disposition filename", async () => {
  respond = () =>
    new Response("zip", {
      headers: { "Content-Disposition": 'attachment; filename="server.lxproj"' },
    });
  await exportProject(4, true, "My Project");
  assert.deepEqual(calls, [
    { url: "/api/projects/4/export", method: "POST", body: { include_pdfs: true } },
  ]);
  assert.equal(downloads[0].download, "server.lxproj");
});

test("exportProject falls back to a slug of the project name", async () => {
  respond = () => new Response("zip");
  await exportProject(4, false, 'My: "Big" Project');
  assert.equal(downloads[0].download, "my_big_project.lxproj");
});

test("exportBibtex slugs by id when the name is missing or all-invalid", async () => {
  respond = () => new Response("@a{}");
  await exportBibtex(5);
  await exportBibtex(6, ":/*");
  assert.deepEqual(
    downloads.map((d) => d.download),
    ["project-5.bib", "project-6.bib"]
  );
  assert.equal(calls[0].url, "/api/projects/5/export/bibtex");
});

test("a failed export throws the server detail, or the status without one", async () => {
  respond = () => Response.json({ detail: "no such project" }, { status: 404 });
  await assert.rejects(exportBibtex(1), { message: "no such project" });
  respond = () => new Response("oops", { status: 500 });
  await assert.rejects(exportBibtex(1), { message: "Request failed (500)" });
  assert.equal(downloads.length, 0);
});
