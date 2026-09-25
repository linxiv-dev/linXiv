// Run: node --experimental-transform-types --test src/api/updates.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, compareVersions, RELEASES_PAGE } from "./updates.ts";

test("compareVersions ranks the numeric core, ignoring a leading v", () => {
  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2", "1.2.1"), -1);
  assert.equal(compareVersions("1.2.0", "V1.2"), 0);
});

test("compareVersions: a pre-release ranks below its release, never between peers", () => {
  assert.equal(compareVersions("1.2.0-rc1", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0-beta-2"), 1);
  assert.equal(compareVersions("1.2.0-rc10", "1.2.0-rc9"), 0);
});

test("compareVersions: an unparseable component is never an update", () => {
  assert.equal(compareVersions("1.x.0", "1.0.0"), 0);
  assert.equal(compareVersions("garbage", "1.0.0"), 0);
});

const respond = (r: Response | Error) => {
  globalThis.fetch = (async () => {
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
};

test("checkForUpdates maps each failure to a renderable result", async () => {
  // Outside Tauri the installed version is unknown, so nothing is ever an update.
  const base = { current: null, latest: null, hasUpdate: false, releaseUrl: RELEASES_PAGE };
  respond(new TypeError("offline"));
  assert.match((await checkForUpdates()).error ?? "", /Couldn't reach GitHub/);
  respond(new Response("", { status: 404 }));
  assert.deepEqual(await checkForUpdates(), base);
  respond(new Response("", { status: 403 }));
  assert.equal((await checkForUpdates()).error, "GitHub returned 403. Try again later.");
  respond(new Response("not json"));
  assert.match((await checkForUpdates()).error ?? "", /unexpected response/);
  respond(Response.json({ tag_name: "  " }));
  assert.deepEqual(await checkForUpdates(), base);
});

test("checkForUpdates strips the tag's v and keeps the release url", async () => {
  respond(Response.json({ tag_name: "v0.7.0", html_url: "https://x/r" }));
  assert.deepEqual(await checkForUpdates(), {
    current: null,
    latest: "0.7.0",
    hasUpdate: false,
    releaseUrl: "https://x/r",
  });
});
