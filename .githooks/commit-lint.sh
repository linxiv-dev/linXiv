#!/bin/sh
# Commit-message rules for this repo, shared by every gate that checks them.
#
# A commit message is an index, not an essay. The subject says what changed;
# an optional short body says why, when the diff doesn't make it obvious.
# Anything longer is documentation: put it in docs or the PR description,
# where readers who aren't running `git log` will find it.
#
# Usage: commit-lint.sh <message-file>
# Prints problems ("  - ") and advisories ("  ~ ") to stdout and exits 1 if
# there are problems. POSIX sh + awk only, so it needs nothing beyond git.

[ -r "${1:-}" ] || { echo "usage: commit-lint.sh <message-file>" >&2; exit 2; }

# C locale: awk works on bytes, and ulen() counts UTF-8 characters itself.
LC_ALL=C exec awk '
function trim(s) { sub(/^[ \t\r\f\v]+/, "", s); sub(/[ \t\r\f\v]+$/, "", s); return s }
function ulen(s) { gsub(/[\200-\277]/, "", s); return length(s) }
function err(s) { errs[++ne] = s }
function note(s) { notes[++nn] = s }

BEGIN {
  types = "feat|fix|refactor|perf|docs|test|chore|build|ci|style|revert"
  subject_re = "^(" types ")(\\([^)]+\\))?!?: [^ \t\r\f\v].*$"
  # Metadata, not reasoning, so exempt from the body budget. Matched lowercased.
  trailer_re = "^(co-authored-by|signed-off-by|assisted-by|reviewed-by|closes|refs|fixes|see-also|breaking[ -]change):"
  n = split("added adds adding fixed fixes fixing updated updates updating " \
            "removed removes removing changed changes changing created creates " \
            "creating implemented implements refactored refactors made makes " \
            "moved moves deleted deletes", v, " ")
  for (i = 1; i <= n; i++) non_imperative[v[i]] = 1
  MAX_SUBJECT = 72; SOFT_SUBJECT = 50; MAX_LINE = 72
  MAX_BODY_LINES = 5; MAX_BODY_CHARS = 150
  n = 0
}

# git comments, and everything past the --verbose scissors line.
/^# ------------------------ >8/ { scissors = 1 }
scissors || /^#/ { next }
{ sub(/\r$/, ""); raw[++n] = $0 }

END {
  first = 1; while (first <= n && raw[first] == "") first++
  last = n;  while (last >= first && trim(raw[last]) == "") last--
  if (last < first) { print "  - message is empty"; exit 1 }
  sub(/[ \t\r\f\v]+$/, "", raw[last])
  m = 0; for (i = first; i <= last; i++) L[++m] = raw[i]

  # subject
  subject = L[1]; sub(/[ \t\r\f\v]+$/, "", subject)
  if (subject !~ subject_re) {
    t = types; gsub(/\|/, ", ", t)
    err("subject is not Conventional Commits: \047" subject "\047\n" \
        "    want: <type>(<scope>): <imperative summary>\n    types: " t)
  } else {
    w = subject; sub(/^[^:]+:[ \t]*/, "", w); split(w, words, " ")
    w = tolower(words[1]); gsub(/[^a-z]/, "", w)
    if (w in non_imperative)
      err("subject verb \047" w "\047 is not imperative: write \"add\"/\"fix\"/\"remove\", not \"added\"/\"fixes\"/\"removing\"")
  }
  sl = ulen(subject)
  if (sl > MAX_SUBJECT) err("subject is " sl " chars, hard cap is " MAX_SUBJECT)
  else if (sl > SOFT_SUBJECT)
    note("subject is " sl " chars; " SOFT_SUBJECT " reads better in `git log --oneline` (not blocking)")
  if (subject ~ /\.$/) err("subject ends with a period, drop it")

  # body
  if (m > 1) {
    blank = (trim(L[2]) == "")
    if (!blank) err("no blank line between subject and body")
    start = blank ? 3 : 2

    # A squashed commit carries further "type(scope): ..." subjects in its
    # body; each part gets its own reason budget.
    u = 1; lines[u] = 0; chars[u] = 0
    for (b = start; b <= m; b++) {
      t = trim(L[b])
      if (t ~ subject_re) { u++; lines[u] = 0; chars[u] = 0; continue }
      if (t != "" && tolower(t) !~ trailer_re) { lines[u]++; chars[u] += ulen(t) }
    }
    for (k = 1; k <= u; k++) {
      c = chars[k] + (lines[k] > 0 ? lines[k] - 1 : 0)
      if (lines[k] <= MAX_BODY_LINES && c <= MAX_BODY_CHARS) continue
      where = u > 1 ? "body of squashed part " k : "body"
      if (lines[k] > MAX_BODY_LINES) { got = lines[k] " lines"; cap = MAX_BODY_LINES " lines" }
      else { got = c " characters"; cap = MAX_BODY_CHARS " characters" }
      err(where " is " got ", max is " cap ".\n" \
          "    A commit body is one or two sentences of why, plus a BREAKING\n" \
          "    CHANGE line if a consumer has to act. Move the rest into docs\n" \
          "    or the PR description.")
    }

    for (b = start; b <= m; b++) {
      len = ulen(L[b]); t = L[b]; sub(/^[ \t\r\f\v]+/, "", t)
      if (len > MAX_LINE && t !~ /^(http|```)/)
        err("line " (b - start + 3) " is " len " chars, wrap body at " MAX_LINE)
    }
  }

  # banned content
  for (i = 1; i <= m; i++) {
    lo = tolower(L[i])
    if (lo ~ /generated with .*claude/) ban[1] = 1
    if (lo ~ /co-authored-by:[ \t]*claude/) ban[2] = 1
    if (lo ~ /^[ \t]*claude-session:/) ban[3] = 1
    if (index(L[i], "🤖")) ban[4] = 1
    if (lo ~ /^[ \t]*this commit([^a-z0-9_]|$)/) ban[5] = 1
    if (lo ~ /as requested by/) ban[6] = 1
  }
  why[1] = "AI attribution line"
  why[2] = "AI attribution trailer"
  why[3] = "AI session link (Claude-Session trailer)"
  why[4] = "emoji attribution"
  why[5] = "\"This commit does X\": the diff already says what"
  why[6] = "\"As requested by\": use a Co-authored-by trailer"
  for (i = 1; i <= 6; i++) if (ban[i]) err("contains " why[i])

  for (i = 1; i <= ne; i++) print "  - " errs[i]
  for (i = 1; i <= nn; i++) print "  ~ " notes[i]
  exit ne > 0
}
' "$1"
