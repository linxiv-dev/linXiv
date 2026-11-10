// Firefox's default MV3 extension CSP adds upgrade-insecure-requests, which
// rewrites http:// fetches to https:// for every host but loopback. That breaks
// a headless server on a plain-http LAN address, so the manifest sets its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));

test("extension pages CSP keeps script-src 'self' without upgrading http", () => {
  const csp: string | undefined = manifest.content_security_policy?.extension_pages;

  assert.ok(csp, "content_security_policy.extension_pages must be set");
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.doesNotMatch(csp, /unsafe-(eval|inline)/);
});
