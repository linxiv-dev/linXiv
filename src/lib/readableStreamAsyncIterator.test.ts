// Run: node --experimental-strip-types --test src/lib/readableStreamAsyncIterator.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// Simulate WebKitGTK 2.50: no native async iteration.
delete (ReadableStream.prototype as unknown as Record<symbol, unknown>)[Symbol.asyncIterator];
await import("./readableStreamAsyncIterator.ts");

const stream = (items: number[]) =>
  new ReadableStream<number>({
    start(c) {
      items.forEach((i) => c.enqueue(i));
      c.close();
    },
  });

test("iterates every chunk", async () => {
  const out: number[] = [];
  for await (const v of stream([1, 2, 3]) as unknown as AsyncIterable<number>) out.push(v);
  assert.deepEqual(out, [1, 2, 3]);
});

test("early break releases the reader lock", async () => {
  const s = stream([1, 2]);
  for await (const _ of s as unknown as AsyncIterable<number>) break;
  assert.equal(s.locked, false);
});
