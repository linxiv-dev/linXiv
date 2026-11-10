import { buildBibtex } from "../bibtex.ts";
import { bytesToBase64, textToBase64 } from "./bytes.ts";
import { baseOf, detail, request, type Fetcher } from "./http.ts";
import { BackendError, type Backend, type ProbeResult } from "./types.ts";

export function headlessBackend(baseUrl: string, token: string, fetcher: Fetcher = fetch): Backend {
  const base = baseOf(baseUrl);

  async function call(path: string, init?: RequestInit): Promise<Response> {
    const response = await request(fetcher, `${base}${path}`, token, init);

    if (response.status === 401) {
      throw new BackendError("The server rejected the token. Check it in Settings.");
    }

    return response;
  }

  return {
    pdfTransport: "bytes",

    probe: async (): Promise<ProbeResult> => {
      try {
        const response = await call("/api/status");

        if (!response.ok) {
          return { ok: false, message: `That address answered HTTP ${response.status}.` };
        }

        const body = (await response.json().catch(() => null)) as { version?: unknown; node_bound?: unknown } | null;

        // Nothing here proves it's linXiv, but these two fields make it likely.
        if (typeof body?.version !== "string" || !body || !("node_bound" in body)) {
          return { ok: false, message: "That address answered, but doesn't look like linxiv-headless." };
        }

        return { ok: true, version: body.version, message: `linxiv-headless ${body.version} accepted the token.` };
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    save: async (clips) => {
      const response = await call("/api/papers/import/bibtex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_b64: textToBase64(clips.map(buildBibtex).join("\n")) }),
      });

      if (!response.ok) {
        throw new BackendError(`linxiv-headless: ${await detail(response)}`);
      }

      const imported = (await response.json()) as { source_ids?: string[] };

      if (!imported.source_ids?.length) {
        throw new BackendError("linxiv-headless accepted the request but saved nothing.");
      }

      return { status: "saved", ids: imported.source_ids };
    },

    savePdf: async (pdf) => {
      const response = await call("/api/papers/import/pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_b64: bytesToBase64(pdf.bytes ?? new Uint8Array()), filename: pdf.filename }),
      });

      if (!response.ok) {
        throw new BackendError(`linxiv-headless: ${await detail(response)}`);
      }

      const imported = (await response.json()) as { source_id?: string; title?: string };
      return { status: "saved", id: imported.source_id, title: imported.title };
    },
  };
}
