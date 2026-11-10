import { desktopBackend } from "./desktop.ts";
import { headlessBackend } from "./headless.ts";
import type { Backend, Settings } from "./types.ts";

export const DEFAULT_SETTINGS: Settings = { kind: "desktop", baseUrl: "", token: "" };

export const DEFAULT_URLS: Record<Settings["kind"], string> = {
  desktop: "",
  headless: "http://127.0.0.1:8000",
};

export function createBackend(settings: Settings, openLink: (url: string) => Promise<unknown>): Backend {
  switch (settings.kind) {
    case "headless":
      return headlessBackend(settings.baseUrl, settings.token);
    default:
      return desktopBackend(openLink);
  }
}
