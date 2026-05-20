/**
 * Base HTTP client. In Tauri the backend runs at http://127.0.0.1:8000;
 * in browser dev Vite proxies /api → http://127.0.0.1:8000, so we use
 * an empty base URL and let the proxy handle it.
 */
const BASE_URL =
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined
    ? "http://127.0.0.1:8000"
    : "";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // ignore parse errors
    }
    throw new ApiError(response.status, detail);
  }

  // 204 No Content or empty body
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
