import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LiveSession,
  caretAfter,
  rebaseSnapshot,
  offsetToPos,
  posToOffset,
  textDiff,
} from "./liveSync.ts";
import type { LiveSyncBody, LiveSynced } from "../types/generated.ts";

test("textDiff finds the one replaced range", () => {
  assert.deepEqual(textDiff("hello world", "hello brave world"), {
    start: 6,
    end: 6,
    insert: "brave ",
  });
  assert.deepEqual(textDiff("abc", "ac"), { start: 1, end: 2, insert: "" });
  assert.deepEqual(textDiff("aa", "aaa"), { start: 2, end: 2, insert: "a" });
  assert.deepEqual(textDiff("same", "same"), { start: 4, end: 4, insert: "" });
});

test("caretAfter moves the caret only for edits before it", () => {
  // Insert before the caret shifts it; after the caret leaves it.
  assert.equal(caretAfter("hello world", "oh hello world", 5), 8);
  assert.equal(caretAfter("hello world", "hello world!", 5), 5);
  // A peer typing exactly at the caret does not drag it along.
  assert.equal(caretAfter("ab", "aXb", 1), 1);
  // Caret inside a replaced range lands at the end of the replacement.
  assert.equal(caretAfter("one two three", "one 2 three", 6), 5);
  assert.equal(caretAfter("abcdef", "abef", 6), 4);
});

test("positions and offsets round-trip across lines", () => {
  const text = "ab\n\ncde";
  for (let offset = 0; offset <= text.length; offset++)
    assert.equal(posToOffset(text, offsetToPos(text, offset)), offset);
  assert.deepEqual(offsetToPos(text, 4), { row: 2, col: 0 });
  assert.equal(posToOffset(text, { row: 9, col: 9 }), text.length);
});

test("rebaseSnapshot carries a peer's edit into an undo snapshot", () => {
  // Nothing typed since the snapshot: the peer's edit simply applies.
  assert.equal(rebaseSnapshot("ab\ncd", "ab\ncd", "ab\ncd!"), "ab\ncd!");
  // The user typed "XY" on line 1 since; the peer edits line 2, after it.
  assert.equal(rebaseSnapshot("ab\ncd", "abXY\ncd", "abXY\ncd!"), "ab\ncd!");
  // The peer edits before what the user typed.
  assert.equal(rebaseSnapshot("ab\ncd", "ab\ncdXY", ">ab\ncdXY"), ">ab\ncd");
  // The user deleted since the snapshot; the peer edits after the hole.
  assert.equal(rebaseSnapshot("abcdef", "abef", "abef!"), "abcdef!");
  // The peer types inside what the user typed: undo drops the user's text
  // and keeps the peer's, where it stood.
  assert.equal(rebaseSnapshot("ab", "aXYZb", "aX!YZb"), "a!b");
  // The peer deletes part of the user's typing: nothing of theirs to keep.
  assert.equal(rebaseSnapshot("ab", "aXYZb", "aXb"), "ab");
  // The peer replaces from before the user's text into it.
  assert.equal(rebaseSnapshot("abcd", "abXYcd", "a?Ycd"), "a?cd");
  // The peer replaces from inside the user's text past its end.
  assert.equal(rebaseSnapshot("abcd", "abXYcd", "abX?d"), "ab?d");
  // The user replaced a selection; the peer types inside the replacement.
  assert.equal(rebaseSnapshot("a[old]b", "aNEWb", "aN!EWb"), "a[old]!b");
  // A peer typing forward inside the user's word, a character per edit,
  // keeps its order in every snapshot.
  for (const snapshot of ["", "m", "mi", "min"]) {
    let [snap, text] = [snapshot, "mine"];
    for (const [n, ch] of [..."PEER"].entries()) {
      const next = text.slice(0, 2 + n) + ch + text.slice(2 + n);
      snap = rebaseSnapshot(snap, text, next);
      text = next;
    }
    assert.equal(text, "miPEERne");
    assert.equal(snap, snapshot.slice(0, 2) + "PEER" + snapshot.slice(2), snapshot);
  }
});

/** A backend whose replies the test releases one at a time. */
function harness(initial: string) {
  const calls: { body: LiveSyncBody; reply: (r: Partial<LiveSynced>) => void }[] = [];
  const editor = {
    text: "",
    composing: false,
    busy() {
      return this.composing;
    },
    getText() {
      return this.text;
    },
    applyRemote(text: string) {
      this.text = text;
    },
  };
  const session = new LiveSession(
    (body) =>
      new Promise<LiveSynced>((resolve) =>
        calls.push({
          body,
          reply: (r) =>
            resolve({
              ready: true,
              text: "",
              heads: [],
              own: [],
              peers: 0,
              hosted: true,
              cursors: [],
              rev: 0,
              secure: false,
              can_edit: true,
              denied: false,
              ...r,
            }),
        })
      ),
    editor,
    () => {},
    0
  );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const open = async () => {
    session.start();
    await tick();
    calls.shift()!.reply({ text: initial, heads: ["h0"] });
    await tick();
  };
  return { calls, editor, session, tick, open };
}

test("a post's merged reply reaches the editor", async () => {
  const { calls, editor, session, tick, open } = harness("hello");
  await open();
  assert.equal(editor.text, "hello");
  const poll = calls.shift()!;
  assert.deepEqual(poll.body, { base: ["h0"], peers: 0, rev: 0, wait: true });

  editor.text = "hello!";
  void session.push();
  await tick();
  const post = calls.shift()!;
  assert.deepEqual(post.body, { text: "hello!", base: ["h0"], wait: false, peers: 0, rev: 0 });
  // A peer's edit was merged in on the backend.
  post.reply({ text: "hello! world", heads: ["h2"], own: ["h1"] });
  await tick();
  assert.equal(editor.text, "hello! world");
  session.stop();
});

test("typing during a post keeps the keystrokes and rebases on `own`", async () => {
  const { calls, editor, session, tick, open } = harness("hello");
  await open();
  calls.shift(); // the idle poll

  editor.text = "hello!";
  void session.push();
  await tick();
  const first = calls.shift()!;
  editor.text = "hello!?"; // typed while the post is in flight
  void session.push();
  first.reply({ text: "hello! world", heads: ["h2"], own: ["h1"] });
  await tick();
  // The merged reply would have erased the "?": it must not be applied.
  assert.equal(editor.text, "hello!?");
  const second = calls.shift()!;
  assert.deepEqual(second.body, { text: "hello!?", base: ["h1"], wait: false, peers: 0, rev: 0 });
  second.reply({ text: "hello!? world", heads: ["h4"], own: ["h3"] });
  await tick();
  assert.equal(editor.text, "hello!? world");
  session.stop();
});

test("a poll reply never overwrites unposted typing", async () => {
  const { calls, editor, session, tick, open } = harness("hello");
  await open();
  const poll = calls.shift()!;
  editor.text = "hello local"; // change event not delivered yet
  poll.reply({ text: "REMOTE", heads: ["h9"] });
  await tick();
  assert.equal(editor.text, "hello local");
  // The session posts the local text itself, on the old base.
  assert.deepEqual(calls.shift()!.body, {
    text: "hello local",
    base: ["h0"],
    wait: false,
    peers: 0,
    rev: 0,
  });
  session.stop();
});

test("a poll reply older than a finished post is dropped", async () => {
  const { calls, editor, session, tick, open } = harness("hello");
  await open();
  const poll = calls.shift()!;

  editor.text = "hello!";
  void session.push();
  await tick();
  calls.shift()!.reply({ text: "hello!", heads: ["h1"], own: ["h1"] });
  await tick();
  // The poll was answered before the post landed, and arrives after it.
  poll.reply({ text: "hello", heads: ["h0"] });
  await tick();
  assert.equal(editor.text, "hello!");
  assert.deepEqual(calls.shift()!.body, { base: ["h1"], peers: 0, rev: 0, wait: true });
  assert.equal(calls.length, 0);
  session.stop();
});

test("nothing is applied while an IME composition is open", async () => {
  const { calls, editor, session, tick, open } = harness("hello");
  await open();
  const poll = calls.shift()!;
  editor.composing = true;
  poll.reply({ text: "hello world", heads: ["h1"] });
  await tick();
  assert.equal(editor.text, "hello", "poll reply held back");

  // A post made mid-composition keeps the editor's text and rebases on `own`.
  editor.text = "helloに";
  void session.push();
  await tick();
  calls.shift()!.reply({ text: "helloに world", heads: ["h3"], own: ["h2"] });
  await tick();
  assert.equal(editor.text, "helloに");

  // Composition over: the next poll asks from `own` and its merge goes in.
  editor.composing = false;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const next = calls.shift()!;
  assert.deepEqual(next.body.base, ["h2"]);
  next.reply({ text: "helloに world", heads: ["h3"] });
  await tick();
  assert.equal(editor.text, "helloに world");
  session.stop();
});

test("a joined doc stays untouched until its first sync", async () => {
  const { calls, editor, session, tick } = harness("");
  session.start();
  await tick();
  calls.shift()!.reply({ ready: false });
  await tick();
  editor.text = "typed too early";
  await session.push();
  assert.equal(calls.length, 1, "only the poll is outstanding");
  session.stop();
});

test("a viewer's editor never posts", async () => {
  const { calls, editor, session, tick } = harness("");
  session.start();
  await tick();
  calls.shift()!.reply({ text: "members only", heads: ["h0"], secure: true, can_edit: false });
  await tick();
  assert.equal(editor.text, "members only");
  calls.shift(); // the idle poll
  editor.text = "members only, scribbled";
  await session.push();
  assert.equal(calls.length, 0);
  session.stop();
});

test("an editor made a viewer mid-typing takes the doc's text, not a post", async () => {
  const { calls, editor, session, tick, open } = harness("hi");
  await open();
  editor.text = "hi, unposted";
  calls.shift()!.reply({ text: "hi", heads: ["h0"], can_edit: false });
  await tick();
  assert.equal(editor.text, "hi");
  assert.ok(calls.every((call) => call.body.text === undefined));
  session.stop();
});

test("a 404 closes the session", async () => {
  let status: { closed: boolean } = { closed: false };
  const session = new LiveSession(
    () => Promise.reject(Object.assign(new Error("gone"), { status: 404 })),
    { getText: () => "", applyRemote() {} },
    (s) => (status = s),
    0
  );
  session.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(status.closed, true);
});
