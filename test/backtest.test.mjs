import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareSymbol, runBacktest } from "../lib/backtest.mjs";
import { WINDOW_MS } from "../lib/features.mjs";

function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A symbol whose behaviour is stationary unless told otherwise. */
function symbolEvents(symbol, nWindows, seed, opts = {}) {
  const { lateBoom = false, hotPersistence = 0.45 } = opts;
  const r = rng(seed);
  const events = [];
  let hot = false;
  for (let i = 0; i < nWindows; i++) {
    const ts = i * WINDOW_MS + 1;
    const late = lateBoom && i > nWindows * 0.75;
    const pBurst = hot ? hotPersistence : late ? 0.5 : 0.06;
    if (r() < pBurst) {
      const n = 5 + Math.floor(r() * 30);
      for (let k = 0; k < n; k++) {
        events.push({ ts: ts + k, symbol, side: r() < 0.75 ? "Buy" : "Sell", usd: (late ? 4000 : 500) + r() * 3000 });
      }
      hot = true;
    } else {
      if (r() < 0.5) events.push({ ts, symbol, side: r() < 0.5 ? "Buy" : "Sell", usd: 10 + r() * 200 });
      hot = false;
    }
  }
  return events;
}

test("the threshold comes from training windows only, never the whole tape", () => {
  // The tape gets far louder in its final quarter. A threshold taken over
  // everything would be dragged up by a period the model is not allowed to
  // have seen.
  const events = symbolEvents("BOOM", 4000, 5, { lateBoom: true });
  const cutoff = 4000 * WINDOW_MS * 0.75;
  const prepared = prepareSymbol(events, cutoff);
  assert.ok(prepared.threshold > 0);

  const all = events.filter(() => true);
  const lateOnly = all.filter((e) => e.ts >= cutoff);
  const lateMean = lateOnly.reduce((s, e) => s + e.usd, 0) / lateOnly.length;
  assert.ok(
    prepared.threshold < lateMean * 30,
    "sanity: the training threshold should not reflect the loud tail"
  );

  // And the decisive check: recomputing with a later cutoff, which legitimately
  // includes the boom, must produce a different and higher threshold.
  const laterCutoff = 4000 * WINDOW_MS * 0.95;
  const withBoom = prepareSymbol(events, laterCutoff);
  assert.ok(
    withBoom.threshold > prepared.threshold,
    `threshold ${withBoom.threshold} should exceed ${prepared.threshold} once the boom is in training`
  );
});

test("every training pair predates the cutoff and every test pair follows it", () => {
  const events = symbolEvents("SPLIT", 3000, 9);
  const cutoff = 3000 * WINDOW_MS * 0.75;
  const p = prepareSymbol(events, cutoff);
  assert.ok(p.trainPairs.length > 0 && p.testPairs.length > 0);
  assert.ok(p.trainPairs.every((x) => x.at < cutoff), "a training pair leaked past the cutoff");
  assert.ok(
    p.testPairs.every((x) => x.at >= cutoff - WINDOW_MS),
    "a test pair reached further back than the one window of state it needs"
  );
});

test("a symbol with too little history is refused by name, not silently dropped", () => {
  const events = symbolEvents("TINY", 40, 3);
  const p = prepareSymbol(events, 40 * WINDOW_MS * 0.75);
  assert.equal(p.symbol, "TINY");
  assert.match(p.skipped, /minimum is 200/);
  assert.equal(p.trainPairs, undefined);
});

test("a symbol that never traded produces no threshold rather than a zero one", () => {
  const events = Array.from({ length: 400 }, (_, i) => ({
    ts: i * WINDOW_MS + 1,
    symbol: "DEAD",
    side: "Buy",
    usd: 0,
  }));
  const p = prepareSymbol(events, 400 * WINDOW_MS * 0.75);
  assert.match(p.skipped, /no threshold exists/);
});

test("pooling many symbols produces real out-of-sample skill", () => {
  const bySymbol = new Map();
  for (let i = 0; i < 12; i++) {
    const sym = `SYM${i}`;
    bySymbol.set(sym, symbolEvents(sym, 1200, 100 + i));
  }
  const r = runBacktest(bySymbol);
  assert.equal(r.symbolsIncluded, 12);
  assert.ok(r.testPairs > 1000, `only ${r.testPairs} test pairs`);
  assert.ok(r.skill > 0.1, `pooled skill was ${r.skill}`);
  assert.ok(r.coverage > 0.9, `coverage was ${r.coverage}`);
  assert.ok(r.reliability < 0.02, `reliability was ${r.reliability}`);
});

test("thin symbols are reported as skipped rather than quietly excluded", () => {
  const bySymbol = new Map();
  bySymbol.set("BIG", symbolEvents("BIG", 1200, 7));
  bySymbol.set("SMALL", symbolEvents("SMALL", 30, 8));
  const r = runBacktest(bySymbol);
  assert.equal(r.symbolsIncluded, 1);
  assert.equal(r.symbolsSkipped, 1);
  assert.equal(r.skippedExamples[0].symbol, "SMALL");
  assert.match(r.skippedExamples[0].reason, /training windows/);
});

test("an empty universe reports an error instead of a score", () => {
  assert.match(runBacktest(new Map()).error, /no events/);
});

test("the report carries the evidence needed to check it", () => {
  const bySymbol = new Map([["A", symbolEvents("A", 1200, 11)], ["B", symbolEvents("B", 1200, 12)]]);
  const r = runBacktest(bySymbol);
  for (const k of ["cutoffTs", "trainPairs", "testPairs", "states", "trainBaseRate", "testBaseRate", "coverage", "reliability", "resolution", "residual"]) {
    assert.ok(r[k] !== undefined, `report is missing ${k}`);
  }
  assert.ok(r.curve.length > 0, "a reliability curve must be included so calibration is checkable");
});

test("skill is reported against the TEST base rate, not the training one", () => {
  const bySymbol = new Map([["A", symbolEvents("A", 1600, 21, { lateBoom: true })]]);
  const r = runBacktest(bySymbol);
  assert.ok(r.trainBaseRate !== null && r.testBaseRate !== null);
  assert.notEqual(r.trainBaseRate, r.testBaseRate);
  assert.ok(Number.isFinite(r.skill), "skill must still be computable when the regime shifts");
});
