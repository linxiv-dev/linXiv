import { apiFetch } from "./client";
import { queryClient } from "../lib/queryClient";
import type { Settings, Stats } from "../types/api";

export async function getSettings(): Promise<Settings> {
  return apiFetch<Settings>("/api/settings");
}

// Invalidating here (rather than at each call site) keeps the ["settings"]
// React Query cache in lockstep with the backend. Forgetting an invalidation
// at a call site caused the bug where toggles didn't reflect saved state
// until a page reload.
export async function updateSettings(
  updates: Partial<Settings>
): Promise<{ ok: boolean }> {
  const result = await apiFetch<{ ok: boolean }>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ updates }),
  });
  await queryClient.invalidateQueries({ queryKey: ["settings"] });
  return result;
}

export async function updateEnv(
  key: string,
  value: string
): Promise<{ ok: boolean }> {
  const result = await apiFetch<{ ok: boolean }>("/api/env", {
    method: "PATCH",
    body: JSON.stringify({ key, value }),
  });
  await queryClient.invalidateQueries({ queryKey: ["settings"] });
  return result;
}

export async function getStats(): Promise<Stats> {
  return apiFetch<Stats>("/api/stats");
}
