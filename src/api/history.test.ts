// Run: node --experimental-transform-types --test src/api/history.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getChangeDiff, getTimeline, restoreTo } from "./history.ts";

const calls: { url: string; init?: RequestInit }[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  return Response.json({});
}) as typeof fetch;

test("each history scope addresses its own route, share ids encoded", async () => {
  await getTimeline({ kind: "library" });
  await getTimeline({ kind: "project", id: 4 });
  await getChangeDiff({ kind: "share", shareId: "a/b" }, "h#1");
  await restoreTo({ kind: "project", id: 4 }, "h1");
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "/api/history/library",
      "/api/history/project/4",
      "/api/history/share/a%2Fb/diff?at=h%231",
      "/api/history/project/4/restore",
    ]
  );
  assert.equal(calls[3].init?.method, "POST");
  assert.deepEqual(JSON.parse(calls[3].init?.body as string), { to: "h1" });
});
