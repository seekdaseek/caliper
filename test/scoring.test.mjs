import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brier,
  logScore,
  meanBrier,
  baseRate,
  referenceBrier,
  coverageAdjustedBrier,
  skillScore,
  coverage,
  murphy,
  sharpness,
  isForecast,
  DECLINED,
} from "../lib/scoring.mjs";

/** Deterministic PRNG so every run scores identically. */
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A question set with a real signal in it. `truth` is the generating
 * probability; a miner that knows it is the best possible forecaster.
 */
function questions(n = 4000, seed = 7) {
  const r = rng(seed);
  const truth = [];
  const outcomes = [];
  for (let i = 0; i < n; i++) {
    // Rare events with an occasional elevated regime, which is the shape of
    // the real question: liquidation cascades are mostly absent.
    const p = 0.02 + 0.78 * r() ** 4;
    truth.push(p);
    outcomes.push(r() < p ? 1 : 0);
  }
  return { truth, outcomes };
}

/** The naive metric most script authors will write. */
function accuracy(forecasts, outcomes) {
  let hits = 0;
  let n = 0;
  for (let i = 0; i < forecasts.length; i++) {
    if (!isForecast(forecasts[i])) continue;
    hits += (forecasts[i] >= 0.5 ? 1 : 0) === outcomes[i] ? 1 : 0;
    n++;
  }
  return n === 0 ? 0 : hits / n;
}

test("brier and log score reward being right and punish being confidently wrong", () => {
  assert.equal(brier(1, 1), 0);
  assert.equal(brier(0, 1), 1);
  assert.equal(brier(0.5, 1), 0.25);
  assert.ok(logScore(0.01, 1) > logScore(0.4, 1));
  assert.ok(Number.isFinite(logScore(0, 1)), "log score must be clipped, not infinite");
});

test("a forecast outside 0..1 is refused rather than clamped silently", () => {
  assert.throws(() => brier(1.5, 1), TypeError);
  assert.throws(() => brier(0.5, 2), TypeError);
  assert.equal(isForecast(null), false);
  assert.equal(isForecast(NaN), false);
});

test("the honest forecaster beats everything, which is what properness means", () => {
  const { truth, outcomes } = questions();
  const honest = truth;
  const shaded = truth.map((p) => Math.min(1, p * 1.3)); // reports more than it believes
  const damped = truth.map((p) => p * 0.7); // reports less than it believes
  const bsHonest = meanBrier(honest, outcomes);
  assert.ok(bsHonest < meanBrier(shaded, outcomes), "overstating must lose");
  assert.ok(bsHonest < meanBrier(damped, outcomes), "understating must lose");
});

test("ATTACK 1 base-rate camping: beats accuracy, gains nothing on caliper", () => {
  const { truth, outcomes } = questions();
  const c = baseRate(outcomes);
  const camper = outcomes.map(() => c);
  const honest = truth;

  // This is the hole. On a rare-event question set, accuracy makes a
  // forecaster that never looked at the data look almost as good as one that
  // knows the generating process. The camper spent nothing and lands within a
  // few points, on a number that reads as excellent.
  const accGap = accuracy(honest, outcomes) - accuracy(camper, outcomes);
  assert.ok(accuracy(camper, outcomes) > 0.8, "the camper posts a flattering accuracy");
  assert.ok(accGap < 0.05, `accuracy separated them by only ${accGap}`);

  // caliper separates them completely on the same data.
  const skillGap = skillScore(honest, outcomes) - skillScore(camper, outcomes);
  assert.ok(skillGap > 0.2, `skill separated them by ${skillGap}`);

  // caliper: skill against climatology is exactly zero for a camper.
  assert.ok(Math.abs(skillScore(camper, outcomes)) < 1e-9, "camper must score zero skill");
  assert.ok(skillScore(honest, outcomes) > 0.1, "the honest forecaster must show real skill");

  // And the resolution term is exactly zero, which is the mathematical
  // statement of why constant forecasting is not knowledge.
  assert.ok(murphy(camper, outcomes).resolution < 1e-12);
  assert.ok(murphy(honest, outcomes).resolution > 0.01);
});

test("ATTACK 2 cherry-picking: answering only the easy questions earns nothing", () => {
  const { truth, outcomes } = questions();
  // Answers only where it is already nearly certain, declines everything else.
  const picker = truth.map((p) => (p < 0.04 || p > 0.65 ? p : DECLINED));

  // On the answered subset it looks superb.
  assert.ok(meanBrier(picker, outcomes) < meanBrier(truth, outcomes));
  assert.ok(coverage(picker) < 0.55, "it is only answering a minority of questions");

  // Coverage-adjusted, it cannot beat the forecaster that answers everything.
  const pickerSkill = skillScore(picker, outcomes);
  const honestSkill = skillScore(truth, outcomes);
  assert.ok(
    pickerSkill < honestSkill,
    `cherry-picking scored ${pickerSkill} vs honest ${honestSkill}`
  );
  assert.ok(pickerSkill > 0, "but honest partial coverage is still worth more than nothing");
});

test("declining is charged climatology exactly, so silence is neither free nor punished", () => {
  const { outcomes } = questions();
  const allDeclined = outcomes.map(() => DECLINED);
  assert.equal(coverage(allDeclined), 0);
  assert.ok(Math.abs(skillScore(allDeclined, outcomes)) < 1e-9, "total silence scores zero skill");
  assert.equal(meanBrier(allDeclined, outcomes), null, "and reports no mean over an empty set");
});

test("a miner that declines the hard half is not better than one that tries", () => {
  const { truth, outcomes } = questions();
  const r = rng(99);
  // Honest on easy, and genuinely informative but noisy on hard.
  const tries = truth.map((p) => Math.min(0.99, Math.max(0.01, p + (r() - 0.5) * 0.25)));
  const quits = truth.map((p, i) => (p < 0.12 || p > 0.85 ? tries[i] : DECLINED));
  assert.ok(
    skillScore(tries, outcomes) > skillScore(quits, outcomes),
    "a noisy but informative answer must beat a decline"
  );
});

test("ATTACK 4 confidence inflation: wins on accuracy, loses on a proper score", () => {
  const { truth, outcomes } = questions();
  const bluffer = truth.map((p) => (p >= 0.5 ? 0.99 : 0.01));
  assert.ok(
    accuracy(bluffer, outcomes) >= accuracy(truth, outcomes) - 1e-9,
    "the bluffer matches or beats accuracy"
  );
  assert.ok(
    meanBrier(bluffer, outcomes) > meanBrier(truth, outcomes),
    "but a proper score punishes it without any special rule"
  );
  // And its calibration error is visibly worse.
  assert.ok(murphy(bluffer, outcomes).reliability > murphy(truth, outcomes).reliability);
});

test("the Murphy decomposition closes exactly once its residual is included", () => {
  const { truth, outcomes } = questions();
  const m = murphy(truth, outcomes, 20);
  const rebuilt = m.reliability - m.resolution + m.uncertainty + m.residual;
  assert.ok(
    Math.abs(rebuilt - meanBrier(truth, outcomes)) < 1e-12,
    `decomposition ${rebuilt} did not match Brier ${meanBrier(truth, outcomes)}`
  );
});

test("the residual is the cost of binning, and it shrinks as bins get finer", () => {
  const { truth, outcomes } = questions(8000, 11);
  const coarse = Math.abs(murphy(truth, outcomes, 4).residual);
  const fine = Math.abs(murphy(truth, outcomes, 50).residual);
  assert.ok(fine < coarse, `fine ${fine} was not smaller than coarse ${coarse}`);
});

test("for discrete forecasts the decomposition closes with no residual at all", () => {
  const r = rng(5);
  const levels = [0.05, 0.25, 0.45, 0.65, 0.85];
  const forecasts = [];
  const outcomes = [];
  for (let i = 0; i < 6000; i++) {
    const p = levels[Math.floor(r() * levels.length)];
    forecasts.push(p);
    outcomes.push(r() < p ? 1 : 0);
  }
  const m = murphy(forecasts, outcomes, 5);
  assert.ok(Math.abs(m.residual) < 1e-12, `residual was ${m.residual}`);
});

test("a perfectly calibrated forecaster has near-zero reliability error", () => {
  const { truth, outcomes } = questions(20000, 3);
  const m = murphy(truth, outcomes, 10);
  assert.ok(m.reliability < 0.002, `reliability was ${m.reliability}`);
});

test("sharpness separates a bluffer from a knower only when paired with reliability", () => {
  const { truth, outcomes } = questions();
  const bluffer = truth.map((p) => (p >= 0.5 ? 0.99 : 0.01));
  assert.ok(sharpness(bluffer, outcomes) > sharpness(truth, outcomes), "the bluffer looks sharper");
  assert.ok(
    murphy(bluffer, outcomes).reliability > murphy(truth, outcomes).reliability,
    "and reliability is what exposes it"
  );
});

test("skill is undefined rather than invented when every outcome is identical", () => {
  const outcomes = new Array(50).fill(1);
  assert.equal(referenceBrier(outcomes), 0);
  assert.equal(skillScore(new Array(50).fill(0.9), outcomes), null);
});

test("an empty question set produces nulls, never zeros", () => {
  assert.equal(baseRate([]), null);
  assert.equal(referenceBrier([]), null);
  assert.equal(coverageAdjustedBrier([], []), null);
  assert.equal(murphy([], []), null);
});

test("a paired bootstrap finds a real difference and reports a tight interval", async () => {
  const { pairedBootstrap } = await import("../lib/scoring.mjs");
  const r = rng(31);
  // A genuine but small edge, hidden inside far larger per-question noise.
  // At 0.0005 this same test sat right on the 95% boundary, which is a useful
  // reminder in itself: an effect under two standard errors is not a finding,
  // however much you want it to be.
  const diffs = Array.from({ length: 50000 }, () => 0.0015 + (r() - 0.5) * 0.2);
  const b = pairedBootstrap(diffs);
  assert.ok(b.observed > 0);
  assert.equal(b.crossesZero, false, `interval ${b.lo} to ${b.hi} should exclude zero`);
});

test("a paired bootstrap refuses to call noise a difference", async () => {
  const { pairedBootstrap } = await import("../lib/scoring.mjs");
  const r = rng(32);
  const diffs = Array.from({ length: 50000 }, () => (r() - 0.5) * 0.2);
  const b = pairedBootstrap(diffs);
  assert.equal(b.crossesZero, true, "an interval over pure noise must contain zero");
});

test("the bootstrap is deterministic, because a shifting p-value is not evidence", async () => {
  const { pairedBootstrap } = await import("../lib/scoring.mjs");
  const r = rng(33);
  const diffs = Array.from({ length: 5000 }, () => 0.001 + (r() - 0.5) * 0.1);
  const a = pairedBootstrap(diffs);
  const b = pairedBootstrap(diffs);
  assert.deepEqual([a.lo, a.hi, a.observed], [b.lo, b.hi, b.observed]);
});

test("per-observation Brier charges a decline the reference score", async () => {
  const { perObservationBrier } = await import("../lib/scoring.mjs");
  const outcomes = [1, 0, 1, 0];
  const per = perObservationBrier([0.9, 0.1, DECLINED, 0.2], outcomes);
  assert.equal(per.length, 4);
  assert.ok(Math.abs(per[0] - 0.01) < 1e-12);
  assert.ok(Math.abs(per[2] - (0.5 - 1) ** 2) < 1e-12, "the decline was not charged climatology");
});

test("a bootstrap over nothing returns null rather than a number", async () => {
  const { pairedBootstrap } = await import("../lib/scoring.mjs");
  assert.equal(pairedBootstrap([]), null);
});
