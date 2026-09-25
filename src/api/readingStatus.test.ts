// Run: node --experimental-transform-types --test src/api/readingStatus.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
});
const { fetchReadingStatuses } = await import("./readingStatus.ts");

const KEY = "linxiv-reading-status";
let puts: string[] = [];
let putStatus: Record<string, number> = {};
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (init?.method === "PUT") {
    puts.push(`${url} ${init.body}`);
    const status = putStatus[url] ?? 200;
    return Response.json(status === 200 ? { applied: 1 } : { detail: "x" }, { status });
  }
  return Response.json({ statuses: { "arxiv:9": "read" } });
}) as typeof fetch;

const legacy = (statuses: Record<string, string>) =>
  storage.set(KEY, JSON.stringify({ state: { statuses }, version: 0 }));

beforeEach(() => {
  storage.clear();
  puts = [];
  putStatus = {};
});

test("without a legacy blob it only fetches the map", async () => {
  assert.deepEqual(await fetchReadingStatuses(), { "arxiv:9": "read" });
  assert.deepEqual(puts, []);
});

test("the legacy blob is pushed once, then retired; a 404 paper is skipped", async () => {
  legacy({ "a/1": "read", b: "reading" });
  putStatus["/api/reading-status/b"] = 404;
  await fetchReadingStatuses();
  assert.deepEqual(puts, [
    '/api/reading-status/a%2F1 {"status":"read"}',
    '/api/reading-status/b {"status":"reading"}',
  ]);
  assert.equal(storage.has(KEY), false);
});

test("any other failure keeps the blob so the next fetch retries", async () => {
  legacy({ a: "read" });
  putStatus["/api/reading-status/a"] = 500;
  assert.deepEqual(await fetchReadingStatuses(), { "arxiv:9": "read" });
  assert.equal(storage.has(KEY), true);
});
