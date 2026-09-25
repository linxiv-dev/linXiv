// Run: node --experimental-transform-types --test src/lib/theme.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getColors, PRESETS, sanitizeOverrides, upsertByName } from "./theme.ts";

test("getColors applies valid overrides, as rgba below full alpha", () => {
  const c = getColors("Navy", "dark", { bg: "#ff0000", text: "#00ff00", accent: "red" }, { text: 50 });
  assert.equal(c.bg, "#ff0000");
  assert.equal(c.text, "rgba(0,255,0,0.50)");
  assert.equal(c.accent, PRESETS.Navy.dark.accent);
  assert.equal("surface2" in c, false);
});

test("sanitizeOverrides drops bad hex and non-numeric alphas, clamps the rest", () => {
  const out = sanitizeOverrides(
    { bg: "#abcdef", text: "#abc", accent: "" },
    { bg: 150, text: -5, accent: "50" as never }
  );
  assert.deepEqual(out, { overrides: { bg: "#abcdef" }, overrideAlphas: { bg: 100, text: 0 } });
});

test("upsertByName replaces a case-insensitive match in place, else appends", () => {
  const list = [{ name: "Dusk", v: 1 }, { name: "Sea", v: 2 }];
  assert.deepEqual(upsertByName(list, { name: "dusk", v: 3 }), [{ name: "dusk", v: 3 }, { name: "Sea", v: 2 }]);
  assert.deepEqual(upsertByName(list, { name: "Sun", v: 4 }).map((p) => p.name), ["Dusk", "Sea", "Sun"]);
  assert.equal(list[0].v, 1);
});
