// Run: node --experimental-transform-types --test src/api/integrations.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { installMcp, isCliInstalled, listMcpClients } from "./integrations.ts";

test("outside Tauri reads fall back and writes refuse", async () => {
  assert.equal(await isCliInstalled(), false);
  assert.deepEqual(await listMcpClients(), []);
  await assert.rejects(installMcp("claude"), { message: "Not running in Tauri" });
});
