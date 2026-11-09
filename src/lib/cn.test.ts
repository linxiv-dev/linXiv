import assert from "node:assert/strict";
import { test } from "node:test";
import { cn } from "./cn.ts";

test("later theme color wins, font size survives", () => {
  assert.equal(cn("text-sm text-muted", "text-danger"), "text-sm text-danger");
  assert.equal(cn("border border-border", "hover:border-danger", "border-accent"), "border hover:border-danger border-accent");
});

test("custom card keys merge with built-ins", () => {
  assert.equal(cn("shadow-card", "shadow-none"), "shadow-none");
  assert.equal(cn("rounded-card", "rounded-md"), "rounded-md");
  assert.equal(cn("shadow-card", "shadow-accent"), "shadow-card shadow-accent");
});
