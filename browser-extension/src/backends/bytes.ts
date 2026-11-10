export const MAX_PDF_BYTES = 100 * 1024 * 1024;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  // In chunks: spreading a large array into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function isPdf(bytes: Uint8Array): boolean {
  return String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}
