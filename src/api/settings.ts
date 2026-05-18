import { apiFetch } from "./client";
import type { Settings, Stats } from "../types/api";

export async function getSettings(): Promise<Settings> {
  return apiFetch<Settings>("/api/settings");
}

export async function updateSettings(
  updates: Partial<Settings>
): Promise<{ ok: boolean }> {
  return apiFetch("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ updates }),
  });
}

export async function updateEnv(
  key: string,
  value: string
): Promise<{ ok: boolean }> {
  return apiFetch("/api/env", {
    method: "PATCH",
    body: JSON.stringify({ key, value }),
  });
}

export async function getStats(): Promise<Stats> {
  return apiFetch<Stats>("/api/stats");
}
