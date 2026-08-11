/**
 * PR 0 — numbers discipline unit tests (no Worker).
 * Hide tallies pre-freeze; N-first shares; consultative copy.
 */
import assert from "node:assert/strict";
import {
  hideTallies,
  formatShare,
  consultativeLine,
  LABELS,
  OPEN_GOVERNANCE_STATUSES,
} from "../src/config/numbers-discipline.js";

assert.equal(hideTallies("open"), true);
assert.equal(hideTallies(null), true);
assert.equal(hideTallies("collecting"), true);
assert.equal(hideTallies("review"), true);
assert.equal(hideTallies("voting"), true);
assert.equal(hideTallies("frozen"), false);
assert.equal(hideTallies("published"), false);
assert.equal(hideTallies("passed"), false);
assert.equal(hideTallies("decided"), false);

for (const s of OPEN_GOVERNANCE_STATUSES) {
  assert.equal(hideTallies(s), true, s);
}

const share = formatShare({ n: 20, total: 50, label: "Invalidate" });
assert.equal(share.n, 20);
assert.equal(share.total, 50);
assert.equal(share.pct, 40);
assert.match(share.text, /^Invalidate: N = 20 of 50 \(40%\)$/);
assert.ok(share.text.indexOf("N =") < share.text.indexOf("%"));

const empty = formatShare({ n: 0, total: 0, label: "Keep" });
assert.equal(empty.pct, null);
assert.match(empty.text, /N = 0/);

assert.match(consultativeLine(42), /N = 42/);
assert.match(consultativeLine(42), /not yet residency-verified/);
assert.match(LABELS.opinionMapOpen, /frozen deliberation report/);

console.log("numbers-discipline-test: ok");
