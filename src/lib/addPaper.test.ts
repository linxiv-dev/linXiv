// Run: node --experimental-transform-types --test src/lib/addPaper.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { addPaper, UNRECOGNIZED_REFERENCE, type AddPaperApi } from "./addPaper.ts";
import type { RecognizedInput } from "../types/api";

function fakeApi(rec: RecognizedInput) {
  const calls: string[] = [];
  const api: AddPaperApi = {
    recognize: async (raw) => {
      calls.push(`recognize:${raw}`);
      return rec;
    },
    fetchArxiv: async (id, save) => {
      calls.push(`arxiv:${id}:${save}`);
      return { paper: { title: "Mamba" } };
    },
    importPdfUrl: async (url) => {
      calls.push(`pdf:${url}`);
      return { title: "A PDF" };
    },
  };
  return { api, calls };
}

test("a DOI hands off to the preview flow without saving", async () => {
  const { api, calls } = fakeApi({ kind: "doi", value: "10.1/x" });
  assert.deepEqual(await addPaper("doi.org/10.1/x", api), { doi: "10.1/x" });
  assert.deepEqual(calls, ["recognize:doi.org/10.1/x"]);
});

test("a publisher URL hands off its DOI and PDF link without saving", async () => {
  const { api, calls } = fakeApi({
    kind: "doi_with_pdf",
    value: { doi: "10.1/x", pdf_url: "https://pub/x.pdf" },
  });
  assert.deepEqual(await addPaper("raw", api), { doi: "10.1/x", pdfUrl: "https://pub/x.pdf" });
  assert.deepEqual(calls, ["recognize:raw"]);
});

test("an arXiv id is fetched with save=true and reports the saved title", async () => {
  const { api, calls } = fakeApi({ kind: "arxiv_id", value: "2312.00752" });
  assert.deepEqual(await addPaper("raw", api), { savedTitle: "Mamba" });
  assert.deepEqual(calls, ["recognize:raw", "arxiv:2312.00752:true"]);
});

test("a direct PDF URL is imported and reports the saved title", async () => {
  const { api, calls } = fakeApi({ kind: "direct_pdf_url", value: "https://x/a.pdf" });
  assert.deepEqual(await addPaper("raw", api), { savedTitle: "A PDF" });
  assert.deepEqual(calls, ["recognize:raw", "pdf:https://x/a.pdf"]);
});

test("an unrecognized input rejects with the user-facing hint", async () => {
  const { api, calls } = fakeApi({ kind: "unrecognized" });
  await assert.rejects(addPaper("hello", api), { message: UNRECOGNIZED_REFERENCE });
  assert.deepEqual(calls, ["recognize:hello"]);
});

test("a failing save propagates its error", async () => {
  const { api } = fakeApi({ kind: "arxiv_id", value: "1" });
  api.fetchArxiv = async () => {
    throw new Error("arXiv down");
  };
  await assert.rejects(addPaper("1", api), { message: "arXiv down" });
});
