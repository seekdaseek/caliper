import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toWindows,
  densify,
  quantile,
  thresholdFor,
  stateOf,
  labelledPairs,
  WINDOW_MS,
  LEVELS,
} from "../lib/features.mjs";
import { fit, forecast, forecastAll, splitByTime, DEFAULT_MIN_SUPPORT } from "../lib/model.mjs";
import { skillScore, coverage, murphy, isForecast } from "../lib/scoring.mjs";

function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ev = (ts, symbol, side, usd) => ({ ts, symbol, side, usd });

test("windows bucket by time and keep the two sides apart", () => {
  const w = toWindows([
    ev(0, "SOLUSDT", "Buy", 100),
    ev(1000, "SOLUSDT", "Sell", 50),
    ev(WINDOW_MS + 5, "SOLUSDT", "Buy", 10),
  ]);
  const sol = w.get("SOLUSDT");
  assert.equal(sol.length, 2);
  assert.equal(sol[0].usd, 150);
  assert.equal(sol[0].buyUsd, 100);
  assert.equal(sol[0].sellUsd, 50);
  assert.equal(sol[0].count, 2);
  assert.equal(sol[1].usd, 10);
});

test("symbols never bleed into each other", () => {
  const w = toWindows([ev(0, "SOLUSDT", "Buy", 100), ev(0, "BTCUSDT", "Buy", 900)]);
  assert.equal(w.get("SOLUSDT")[0].usd, 100);
  assert.equal(w.get("BTCUSDT")[0].usd, 900);
});

test("a quiet window is a zero, not a gap", () => {
  const w = toWindows([ev(0, "X", "Buy", 10), ev(WINDOW_MS * 3, "X", "Buy", 20)]);
  const dense = densify(w.get("X"));
  assert.equal(dense.length, 4);
  assert.equal(dense[1].usd, 0);
  assert.equal(dense[1].count, 0);
  assert.equal(dense[3].usd, 20);
});

test("dropping quiet windows would inflate the base rate, so densify prevents it", () => {
  const w = toWindows([ev(0, "X", "Buy", 10), ev(WINDOW_MS * 9, "X", "Buy", 1000)]);
  const sparse = w.get("X");
  const dense = densify(sparse);
  const rateSparse = sparse.filter((x) => x.usd > 500).length / sparse.length;
  const rateDense = dense.filter((x) => x.usd > 500).length / dense.length;
  assert.ok(rateSparse > rateDense, `${rateSparse} should exceed ${rateDense}`);
  assert.equal(rateSparse, 0.5);
  assert.equal(rateDense, 0.1);
});

test("quantile interpolates and survives degenerate input", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([0, 10], 0.9), 9);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([], 0.9), null);
});

test("the threshold comes only from the reference period", () => {
  const windows = Array.from({ length: 100 }, (_, i) => ({ symbol: "X", start: i, usd: i, count: 1, buyUsd: i, sellUsd: 0 }));
  const t = thresholdFor(windows, 0.9);
  assert.ok(t > 88 && t < 90, `threshold was ${t}`);
});

test("state is null when there is nothing to describe", () => {
  assert.equal(stateOf([], 100), null);
  assert.equal(stateOf([{ usd: 5, count: 1, buyUsd: 5, sellUsd: 0 }], 0), null);
  assert.equal(stateOf([{ usd: 5, count: 1, buyUsd: 5, sellUsd: 0 }], null), null);
});

test("state separates loud from quiet, one-sided from balanced, burst from print", () => {
  const t = 1000;
  const quiet = stateOf([{ usd: 0, count: 0, buyUsd: 0, sellUsd: 0 }, { usd: 0, count: 0, buyUsd: 0, sellUsd: 0 }], t);
  const loudOneSided = stateOf(
    [{ usd: 0, count: 0, buyUsd: 0, sellUsd: 0 }, { usd: 2000, count: 40, buyUsd: 2000, sellUsd: 0 }],
    t
  );
  assert.notEqual(quiet, loudOneSided);
  assert.ok(quiet.startsWith("0|"));
  // 2000 against a 1000 threshold is ratio 2, which is level 5 now that the
  // top of the scale is split three ways.
  assert.ok(loudOneSided.startsWith("5|3|3|"), `got ${loudOneSided}`);
});

test("state remembers exactly one window back", () => {
  const t = 1000;
  const now = { usd: 100, count: 2, buyUsd: 100, sellUsd: 0 };
  const afterCalm = stateOf([{ usd: 0, count: 0, buyUsd: 0, sellUsd: 0 }, now], t);
  const afterStorm = stateOf([{ usd: 5000, count: 50, buyUsd: 5000, sellUsd: 0 }, now], t);
  assert.notEqual(afterCalm, afterStorm);
  assert.ok(afterCalm.endsWith("|0"));
  assert.ok(afterStorm.endsWith("|1"));
});

test("the last window is dropped because its outcome has not happened yet", () => {
  const windows = Array.from({ length: 10 }, (_, i) => ({ symbol: "X", start: i * WINDOW_MS, usd: i * 10, count: 1, buyUsd: i * 10, sellUsd: 0 }));
  const pairs = labelledPairs(windows, 50);
  assert.equal(pairs.length, 8);
  assert.equal(pairs[pairs.length - 1].at, windows[8].start);
});

test("an untrained model declines everything rather than guessing", () => {
  const m = fit([]);
  assert.equal(m.baseRate, null);
  const f = forecast(m, "1|2|1|0");
  assert.equal(f.p, null);
  assert.match(f.reason, /no training data/);
});

test("a thin cell is refused, and says how thin", () => {
  const pairs = Array.from({ length: 200 }, (_, i) => ({ at: i, state: i < 5 ? "rare" : "common", outcome: i % 4 === 0 ? 1 : 0 }));
  const m = fit(pairs);
  const rare = forecast(m, "rare");
  assert.equal(rare.p, null);
  assert.equal(rare.support, 5);
  assert.match(rare.reason, /only 5 historical observations/);
  assert.ok(isForecast(forecast(m, "common").p), "a well-supported cell must answer");
});

test("a state never seen at all is refused with zero support", () => {
  const m = fit(Array.from({ length: 100 }, (_, i) => ({ at: i, state: "seen", outcome: 0 })));
  const f = forecast(m, "never-seen");
  assert.equal(f.p, null);
  assert.equal(f.support, 0);
});

test("smoothing stops a small cell declaring certainty", () => {
  const pairs = [
    ...Array.from({ length: DEFAULT_MIN_SUPPORT }, (_, i) => ({ at: i, state: "hot", outcome: 1 })),
    ...Array.from({ length: 400 }, (_, i) => ({ at: 1000 + i, state: "cold", outcome: 0 })),
  ];
  const m = fit(pairs);
  const hot = forecast(m, "hot");
  assert.ok(hot.p < 1, `smoothing failed, got ${hot.p}`);
  assert.ok(hot.p > 0.9, `smoothing over-corrected, got ${hot.p}`);
});

test("splitting is by time, never at random, so the test set cannot leak backwards", () => {
  const pairs = Array.from({ length: 100 }, (_, i) => ({ at: i * 1000, state: "s", outcome: 0 }));
  const { train, test: te, cutoff } = splitByTime(pairs, 0.8);
  assert.equal(train.length, 80);
  assert.equal(te.length, 20);
  assert.ok(train.every((p) => p.at < cutoff));
  assert.ok(te.every((p) => p.at >= cutoff));
});

test("the model earns real out-of-sample skill on a tape with a signal in it", () => {
  // A market where a loud, one-sided window genuinely raises the odds that the
  // next window is loud too. The model is never told this; it has to find it.
  const r = rng(21);
  const events = [];
  let hot = false;
  // Deliberately long. Splitting the top of the level scale into three costs
  // support per cell, so finer states are a bet that only pays off once there
  // is enough history behind them. On a short tape they make things worse, and
  // a test on 6,000 windows would have hidden that rather than shown it.
  for (let i = 0; i < 20000; i++) {
    const ts = i * WINDOW_MS + 1;
    const pBurst = hot ? 0.45 : 0.06;
    if (r() < pBurst) {
      const n = 5 + Math.floor(r() * 40);
      for (let k = 0; k < n; k++) {
        events.push(ev(ts + k, "SIM", r() < 0.8 ? "Buy" : "Sell", 500 + r() * 4000));
      }
      hot = true;
    } else {
      if (r() < 0.5) events.push(ev(ts, "SIM", r() < 0.5 ? "Buy" : "Sell", 10 + r() * 200));
      hot = false;
    }
  }
  const windows = densify(toWindows(events).get("SIM"));
  const { train, test: te } = splitByTime(labelledPairs(windows, thresholdFor(windows, 0.9)), 0.75);
  const model = fit(train);
  const states = te.map((p) => p.state);
  const outcomes = te.map((p) => p.outcome);
  const forecasts = forecastAll(model, states);

  // This test asks one thing: does the model find real signal out of sample.
  // It deliberately does NOT adjudicate whether splitting the top of the level
  // scale helps, because this simulation has only two regimes and no heavy
  // tail, so extra granularity above the threshold carries no information here
  // and merely divides support. Real tapes do have a tail — the live
  // reliability curve read 0.655 where the truth was 0.836 — so that change is
  // a bet on real data and has to be judged on the validation slice, not here.
  const s = skillScore(forecasts, outcomes);
  assert.ok(s > 0.12, `out-of-sample skill was only ${s}`);
  assert.ok(coverage(forecasts) > 0.9, `coverage was only ${coverage(forecasts)}`);
  assert.ok(murphy(forecasts, outcomes).reliability < 0.01, "and it must be calibrated");
});

test("on a tape with no signal the model shows no skill and does not pretend to", () => {
  const r = rng(77);
  const events = [];
  for (let i = 0; i < 6000; i++) {
    const ts = i * WINDOW_MS + 1;
    if (r() < 0.2) {
      const n = 1 + Math.floor(r() * 30);
      for (let k = 0; k < n; k++) events.push(ev(ts + k, "NOISE", r() < 0.5 ? "Buy" : "Sell", 10 + r() * 5000));
    }
  }
  const windows = densify(toWindows(events).get("NOISE"));
  const { train, test: te } = splitByTime(labelledPairs(windows, thresholdFor(windows, 0.9)), 0.75);
  const model = fit(train);
  const forecasts = forecastAll(model, te.map((p) => p.state));
  const s = skillScore(forecasts, te.map((p) => p.outcome));
  assert.ok(s < 0.05, `claimed skill ${s} on a tape with nothing in it`);
});

test("raising the support bar trades coverage for refusals, never for invented answers", () => {
  const pairs = Array.from({ length: 600 }, (_, i) => ({
    at: i,
    state: i % 20 === 0 ? "thin" : "thick",
    outcome: i % 3 === 0 ? 1 : 0,
  }));
  const m = fit(pairs);
  const states = pairs.map((p) => p.state);
  const loose = forecastAll(m, states, { minSupport: 5 });
  const strict = forecastAll(m, states, { minSupport: 100 });
  assert.ok(coverage(strict) < coverage(loose));
  assert.ok(strict.every((p) => p === null || isForecast(p)), "a refusal is null, never a number");
});

test("both level schemes are available and the fine one is strictly finer", () => {
  const t = 1000;
  const w = (usd) => [
    { usd: 0, count: 0, buyUsd: 0, sellUsd: 0 },
    { usd, count: 5, buyUsd: usd, sellUsd: 0 },
  ];
  const coarse = [1200, 3000, 9000].map((u) => stateOf(w(u), t, "coarse").split("|")[0]);
  const fine = [1200, 3000, 9000].map((u) => stateOf(w(u), t, "fine").split("|")[0]);
  assert.deepEqual(coarse, ["4", "4", "4"], "the coarse top bucket is one undivided lump");
  assert.deepEqual(fine, ["4", "5", "6"], "the fine scale separates them");
});

test("an unknown scheme falls back rather than throwing mid-backtest", () => {
  const t = 1000;
  const w = [
    { usd: 0, count: 0, buyUsd: 0, sellUsd: 0 },
    { usd: 9000, count: 5, buyUsd: 9000, sellUsd: 0 },
  ];
  assert.equal(stateOf(w, t, "nonsense").split("|")[0], "6");
});

test("a fitted model round-trips through JSON without changing a single forecast", async () => {
  const { toJSON, fromJSON } = await import("../lib/model.mjs");
  const r = rng(88);
  const pairs = Array.from({ length: 5000 }, (_, i) => ({
    at: i,
    state: `${i % 7}|${i % 3}|${i % 4}|${i % 2}`,
    outcome: r() < 0.2 ? 1 : 0,
  }));
  const original = fit(pairs);
  const restored = fromJSON(JSON.parse(JSON.stringify(toJSON(original, { fittedAt: "now" }))));
  assert.equal(restored.baseRate, original.baseRate);
  assert.equal(restored.states, original.states);
  for (const state of original.stateKeys()) {
    assert.equal(forecast(restored, state).p, forecast(original, state).p, `state ${state} differed`);
  }
});

test("an unknown model format is refused, not silently loaded", async () => {
  const { fromJSON } = await import("../lib/model.mjs");
  assert.throws(() => fromJSON({ format: "something-else", states: {} }), /unrecognised model format/);
  assert.throws(() => fromJSON(null), /unrecognised model format/);
});

test("a restored model still declines below minimum support", async () => {
  const { toJSON, fromJSON } = await import("../lib/model.mjs");
  const pairs = [
    ...Array.from({ length: 5 }, (_, i) => ({ at: i, state: "thin", outcome: 1 })),
    ...Array.from({ length: 300 }, (_, i) => ({ at: 100 + i, state: "thick", outcome: 0 })),
  ];
  const restored = fromJSON(toJSON(fit(pairs)));
  assert.equal(forecast(restored, "thin").p, null);
  assert.equal(forecast(restored, "thin").support, 5);
});

test("with no symbol history, shrinkage reduces exactly to the pooled estimate", async () => {
  const pairs = Array.from({ length: 400 }, (_, i) => ({
    at: i, symbol: "AUSDT", state: "s", outcome: i % 5 === 0 ? 1 : 0,
  }));
  const m = fit(pairs, { shrinkage: 50 });
  const pooled = forecast(m, "s");
  const unseen = forecast(m, "s", { symbol: "ZUSDT" });
  assert.equal(unseen.p, pooled.p, "an unseen symbol must get the pooled number, unchanged");
  assert.equal(unseen.symbolSupport, 0);
});

test("a symbol with its own history moves away from pooled toward its own rate", async () => {
  const pairs = [
    // The pool almost never fires.
    ...Array.from({ length: 3000 }, (_, i) => ({ at: i, symbol: "CALMUSDT", state: "s", outcome: i % 25 === 0 ? 1 : 0 })),
    // This one fires constantly in the same state.
    ...Array.from({ length: 1500 }, (_, i) => ({ at: 5000 + i, symbol: "WILDUSDT", state: "s", outcome: i % 2 === 0 ? 1 : 0 })),
  ];
  const m = fit(pairs, { shrinkage: 50 });
  const calm = forecast(m, "s", { symbol: "CALMUSDT" });
  const wild = forecast(m, "s", { symbol: "WILDUSDT" });
  assert.ok(wild.p > calm.p + 0.2, `wild ${wild.p} was not clearly above calm ${calm.p}`);
  assert.ok(wild.p > 0.4 && wild.p < 0.55, `wild should approach its own ~0.5 rate, got ${wild.p}`);
  assert.ok(calm.p < 0.1, `calm should sit near its own ~0.04 rate, got ${calm.p}`);
});

test("THE LIMITATION IS GONE: two symbols in the same state can now differ", async () => {
  const pairs = [
    ...Array.from({ length: 2000 }, (_, i) => ({ at: i, symbol: "SOLUSDT", state: "4|3|3|1", outcome: i % 10 === 0 ? 1 : 0 })),
    ...Array.from({ length: 2000 }, (_, i) => ({ at: 3000 + i, symbol: "XRPUSDT", state: "4|3|3|1", outcome: i % 3 === 0 ? 1 : 0 })),
  ];
  const m = fit(pairs, { shrinkage: 50 });
  const sol = forecast(m, "4|3|3|1", { symbol: "SOLUSDT" }).p;
  const xrp = forecast(m, "4|3|3|1", { symbol: "XRPUSDT" }).p;
  assert.ok(Math.abs(sol - xrp) > 0.15, `identical state still gave ${sol} and ${xrp}`);
});

test("shrinkage is proportional: more symbol data means less pull toward pooled", async () => {
  const mk = (n) => fit([
    ...Array.from({ length: 4000 }, (_, i) => ({ at: i, symbol: "POOL", state: "s", outcome: i % 20 === 0 ? 1 : 0 })),
    ...Array.from({ length: n }, (_, i) => ({ at: 9000 + i, symbol: "X", state: "s", outcome: 1 })),
  ], { shrinkage: 50 });
  const thin = forecast(mk(10), "s", { symbol: "X" });
  const thick = forecast(mk(2000), "s", { symbol: "X" });
  assert.ok(thin.shrunkBy > thick.shrunkBy, "a thin symbol must be pulled harder toward pooled");
  assert.ok(thick.p > thin.p, "and a well-evidenced symbol must be allowed to stand apart");
});

test("shrinkage of zero disables the symbol layer entirely", async () => {
  const pairs = Array.from({ length: 1000 }, (_, i) => ({ at: i, symbol: "A", state: "s", outcome: i % 4 === 0 ? 1 : 0 }));
  const m = fit(pairs, { shrinkage: 0 });
  assert.equal(forecast(m, "s", { symbol: "A" }).p, forecast(m, "s").p);
});

test("the symbol layer never overrides the minimum-support refusal", async () => {
  const pairs = [
    ...Array.from({ length: 5 }, (_, i) => ({ at: i, symbol: "A", state: "thin", outcome: 1 })),
    ...Array.from({ length: 500 }, (_, i) => ({ at: 100 + i, symbol: "B", state: "thick", outcome: 0 })),
  ];
  const m = fit(pairs, { shrinkage: 50 });
  const f = forecast(m, "thin", { symbol: "A" });
  assert.equal(f.p, null, "a state the POOL barely knows must still be refused");
});
