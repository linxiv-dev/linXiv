// Run: node --experimental-transform-types --test src/api/notes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getNotes } from "./notes.ts";
import { getAnnotations } from "./annotations.ts";

const urls: string[] = [];
globalThis.fetch = (async (url: string) => {
  urls.push(url);
  return Response.json({});
}) as typeof fetch;

// all_projects with project_id is a 422 on the backend, so exactly one is sent.
test("note and annotation lists send all_projects or project_id, never both", async () => {
  for (const [get, path] of [[getNotes, "notes"], [getAnnotations, "annotations"]] as const) {
    urls.length = 0;
    await get("arxiv:1 2");
    await get("a", 0);
    await get("a", null);
    await get("a", 3, true);
    assert.deepEqual(urls, [
      `/api/${path}?source_id=arxiv%3A1+2`,
      `/api/${path}?source_id=a&project_id=0`,
      `/api/${path}?source_id=a`,
      `/api/${path}?source_id=a&all_projects=true`,
    ]);
  }
});
