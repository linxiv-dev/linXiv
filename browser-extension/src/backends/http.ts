import { BackendError } from "./types.ts";

export type Fetcher = typeof fetch;

export function baseOf(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Match pattern for a permission request. Patterns can't name a port. */
export function originPattern(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.hostname}/*`;
}

/** True when the token would cross the network in plain text: http to anything but this computer. */
export function sendsTokenInClear(baseUrl: string): boolean {
  let url: URL;

  try {
    url = new URL(baseUrl.trim());
  } catch {
    return false;
  }

  const host = url.hostname;
  const loopback = host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
  return url.protocol === "http:" && !loopback;
}

export async function request(
  fetcher: Fetcher,
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  try {
    // No cookies: the token is the credential, and it goes only to the server's address.
    return await fetcher(url, { ...init, headers, credentials: "omit" });
  } catch (cause) {
    throw new BackendError(`Can't reach ${new URL(url).origin}. Is the server running? (${String(cause)})`);
  }
}

export async function detail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");

  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string") {
      return body.detail;
    }
  } catch {
    // Not JSON, use the text.
  }

  return text.slice(0, 200) || `HTTP ${response.status}`;
}
