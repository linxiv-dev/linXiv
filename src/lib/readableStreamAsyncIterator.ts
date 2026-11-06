// pdf.js 6 getTextContent does `for await` over a ReadableStream; the
// WebKitGTK 2.50 bundled in the AppImage lacks that, so text layers crash.
const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
proto[Symbol.asyncIterator] ??= async function* <T>(this: ReadableStream<T>) {
  const reader = this.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
};
