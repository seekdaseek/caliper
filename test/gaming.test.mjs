import { test } from "node:test";
import assert from "node:assert/strict";
import { agreement, consensus, contribution, auditMiner, rank } from "../lib/gaming.mjs";
import { skillScore, DECLINED } from "../lib/scoring.mjs";

function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Two independent signals; a miner may see one, the other, or both. */
function world(n = 3000, seed = 13) {
  const r = rng(seed);
  const a = [];
  const b = [];
  const truth = [];
  const outcomes = [];
  for (let i = 0; i < n; i++) {
    const sa = r();
    const sb = r();
    a.push(sa);
    b.push(sb);
    // Wide spread on purpose: a world with almost no signal in it cannot
    // tell a good miner from a bad one, and would make these thresholds
    // meaningless rather than strict.
    const p = Math.min(0.95, Math.max(0.02, 1.8 * sa * sb));
    truth.push(p);
    outcomes.push(r() < p ? 1 : 0);
  }
  return { a, b, truth, outcomes };
}

const noisy = (src, sd, seed) => {
  const r = rng(seed);
  return src.map((p) => Math.min(0.99, Math.max(0.01, p + (r() - 0.5) * sd)));
};

test("agreement reports its overlap, so a match on three questions cannot pass", () => {
  const a = [0.1, 0.2, DECLINED, 0.4];
  const b = [0.1, 0.2, 0.3, DECLINED];
  const r = agreement(a, b);
  assert.equal(r.overlap, 2);
  assert.equal(r.similarity, 1);
  assert.equal(agreement([DECLINED], [DECLINED]).similarity, null);
});

test("consensus is a median, so one extremist cannot drag it", () => {
  const miners = [
    [0.4, 0.4],
    [0.5, 0.5],
    [0.6, 0.6],
    [1.0, 0.0],
  ];
  const c = consensus(miners);
  assert.equal(c[0], 0.55);
  assert.equal(c[1], 0.45);
});

test("consensus skips a question nobody answered rather than inventing one", () => {
  const c = consensus([[DECLINED, 0.3], [DECLINED, 0.5]]);
  assert.equal(c[0], null);
  assert.equal(c[1], 0.4);
});

test("ATTACK 3 copying: the copier scores well and contributes nothing", () => {
  const { truth, outcomes } = world();
  const leader = noisy(truth, 0.06, 1);
  const copier = noisy(leader, 0.01, 2); // watches the leader, adds a whisker of noise
  // Comparable quality to the leader, independent noise. A worse miner would
  // legitimately degrade the consensus, which would prove nothing about copying.
  const independent = noisy(truth, 0.06, 3);
  const miners = [leader, copier, independent];

  // On its own scorecard the copier looks like a strong miner.
  assert.ok(skillScore(copier, outcomes) > 0.2, "the copier posts real-looking skill");
  assert.ok(
    Math.abs(skillScore(copier, outcomes) - skillScore(leader, outcomes)) < 0.05,
    "and sits right next to the miner it is copying"
  );

  // The claim that actually matters: removing the copier costs the consensus
  // nothing. Comparing the SIGN of two tiny contributions would be measuring
  // noise, so the assertion is on the magnitude, which is what the mechanism
  // guarantees.
  const cCopier = contribution(1, miners, outcomes);
  assert.ok(Math.abs(cCopier) < 1e-4, `copier moved the consensus by ${cCopier}`);

  const audit = auditMiner(1, miners, outcomes);
  assert.equal(audit.flagged, true);
  assert.match(audit.reason, /mirrors a peer/);

  // And a miner of the same quality that arrived at its answers independently
  // is not flagged, which is the property that makes this usable at all.
  assert.equal(auditMiner(2, miners, outcomes).flagged, false);
});

test("two miners that legitimately agree are NOT flagged as copies", () => {
  const { truth, outcomes } = world();
  // Both see the same public signal, independently. They will look similar.
  const one = noisy(truth, 0.08, 10);
  const two = noisy(truth, 0.08, 20);
  const other = noisy(truth, 0.25, 30);
  const audit = auditMiner(0, [one, two, other], outcomes);
  assert.equal(audit.flagged, false, "agreement alone must never be the verdict");
});

test("a duplicate that still improves the consensus is spared", () => {
  const { truth, outcomes } = world();
  // a and b are identical wherever both answer, but b declines half the
  // questions, so a is the only voice on those. Removing a costs the
  // consensus real coverage, and the flag requires BOTH conditions.
  const a = noisy(truth, 0.05, 40);
  const b = a.map((p, i) => (i % 2 === 0 ? p : DECLINED));
  const c = noisy(truth, 0.30, 42);
  const d = noisy(truth, 0.28, 43);
  const audit = auditMiner(0, [a, b, c, d], outcomes);
  assert.equal(audit.flagged, false);
});

test("ranking orders by skill and withholds a rank from a flagged miner", () => {
  const { truth, outcomes } = world();
  const good = noisy(truth, 0.05, 50);
  const copier = noisy(good, 0.008, 51);
  const weak = noisy(truth, 0.35, 52);
  const mid = noisy(truth, 0.15, 53);
  const table = rank([good, copier, weak, mid], outcomes);

  assert.equal(table.questions, outcomes.length);
  const byIndex = Object.fromEntries(table.miners.map((m) => [m.index, m]));
  assert.equal(byIndex[1].flagged, true);
  assert.equal(byIndex[1].rank, null);
  assert.ok(byIndex[0].rank < byIndex[2].rank, "the better miner must rank ahead of the weak one");
});

test("a flagged miner keeps its score visible instead of vanishing", () => {
  const { truth, outcomes } = world();
  const good = noisy(truth, 0.05, 60);
  const copier = noisy(good, 0.005, 61);
  const other = noisy(truth, 0.09, 62);
  const another = noisy(truth, 0.12, 63);
  const table = rank([good, copier, other, another], outcomes);
  const flagged = table.miners.find((m) => m.flagged);
  assert.ok(flagged, "expected one flagged miner");
  assert.ok(typeof flagged.skill === "number", "its skill must still be reported");
  assert.ok(flagged.nearestPeer.overlap > 0, "and the evidence for the flag must be attached");
});

test("contribution is null rather than zero when there is nothing to measure", () => {
  assert.equal(contribution(0, [[DECLINED]], []), null);
});
