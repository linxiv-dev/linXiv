// Run: node --experimental-transform-types --test src/api/projects.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { addPapersToProject, createProjectWithPapers } from "./projects.ts";

let posted: { url: string; ids: string[] }[] = [];
let fail: (url: string, ids: string[]) => string[] | null = () => [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const body = JSON.parse(init?.body as string);
  if (url === "/api/projects") return Response.json({ project: { id: 7, name: body.name } });
  posted.push({ url, ids: body.source_ids });
  const failed = fail(url, body.source_ids);
  if (failed === null) return Response.json({ detail: "boom" }, { status: 500 });
  return Response.json({ ok: failed.length === 0, failed });
}) as typeof fetch;

beforeEach(() => {
  posted = [];
  fail = () => [];
});

test("addPapersToProject dedupes and skips the request for an empty list", async () => {
  assert.deepEqual(await addPapersToProject(1, []), { ok: true, failed: [] });
  assert.equal(posted.length, 0);
  await addPapersToProject(1, ["a", "b", "a"]);
  assert.deepEqual(posted, [{ url: "/api/projects/1/papers/bulk", ids: ["a", "b"] }]);
});

test("addPapersToProject chunks at 5000 and merges every chunk's failures", async () => {
  const ids = Array.from({ length: 10_001 }, (_, i) => `p${i}`);
  fail = (_, chunk) => chunk.filter((id) => id === "p0" || id === "p10000");
  assert.deepEqual(await addPapersToProject(1, ids), { ok: false, failed: ["p0", "p10000"] });
  assert.deepEqual(posted.map((p) => p.ids.length), [5000, 5000, 1]);
});

test("createProjectWithPapers resolves with failed ids, or all ids if the add rejects", async () => {
  fail = () => ["b"];
  assert.deepEqual(await createProjectWithPapers({ name: "N", sourceIds: ["a", "b"] }), ["b"]);
  assert.equal(posted[0].url, "/api/projects/7/papers/bulk");
  fail = () => null;
  assert.deepEqual(await createProjectWithPapers({ name: "N", sourceIds: ["a", "b"] }), ["a", "b"]);
});
