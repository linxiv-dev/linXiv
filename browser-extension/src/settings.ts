import { DEFAULT_SETTINGS, DEFAULT_URLS } from "./backends/index.ts";
import type { Settings } from "./backends/types.ts";

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings> | undefined) };
  // Drop a backend kind this build doesn't ship.
  return settings.kind in DEFAULT_URLS ? settings : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
