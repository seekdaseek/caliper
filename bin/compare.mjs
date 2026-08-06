/**
 * caliper — settle a design change with a paired test.
 *
 *   LIQ_DB=/opt/agentfeed/liquidations.db node bin/compare.mjs
 *
 * Runs two level schemes over the IDENTICAL windows, outcomes and split, then
 * bootstraps the paired per-observation difference. Three metrics moving the
 * same way is evidence. An interval that excludes zero is a measurement.
 */
import { createRequire } from "node:module";
import { prepareSymbol } from "../lib/backtest.mjs";
import { fit, forecastAll } from "../lib/model.mjs";
import { skillScore, perObservationBrier, pairedBootstrap, baseRate } from "../lib/scoring.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DB = process.env.LIQ_DB ?? "/opt/agentfeed/liquidations.db";
const MIN_SUPPORT = Number(process.env.MIN_SUPPORT ?? 30);
const MIN_TRAIN_WINDOWS = Number(process.env.MIN_TRAIN_WINDOWS ?? 200);
const FINAL = process.argv.includes("--final");

// Two configurations, each "scheme:shrinkage". Generalised from a scheme-only
// comparison because the same question came up again for the shrinkage weight:
// a difference you cannot measure is a preference, not an improvement.
function parseConfig(spec, fallback) {
  const [scheme, weight] = String(process.env[spec] ?? fallback).split(":");
  return { scheme, shrinkage: Number(weight), label: `${scheme}:${weight}` };
}
const A = parseConfig("CONFIG_A", "fine:0");
const B = parseConfig("CONFIG_B", "fine:50");

function build(db, symbols, scheme, bounds) {
  const rows = db.prepare("SELECT ts, symbol, side, usd FROM liquidations WHERE symbol = ? ORDER BY ts");
  const train = [];
  const test = [];
  for (const symbol of symbols) {
    const events = rows.all(symbol);
    if (events.length === 0) continue;
    const p = prepareSymbol(events, bounds, { minTrainWindows: MIN_TRAIN_WINDOWS, scheme });
    if (!p || p.skipped) continue;
    train.push(...p.trainPairs);
    test.push(...p.testPairs);
  }
  return { train, test };
}

function main() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const span = db.prepare("SELECT MIN(ts) AS lo, MAX(ts) AS hi, COUNT(*) AS n FROM liquidations").get();
  const width = span.hi - span.lo;
  const trainEndTs = span.lo + width * (FINAL ? 0.85 : 0.7);
  const bounds = {
    trainEndTs,
    evalStartTs: trainEndTs,
    evalEndTs: FINAL ? Infinity : span.lo + width * 0.85,
  };
  const symbols = db.prepare("SELECT DISTINCT symbol FROM liquidations").all().map((r) => r.symbol);

  const results = {};
  for (const cfg of [A, B]) {
    const { train, test } = build(db, symbols, cfg.scheme, bounds);
    const model = fit(train, { shrinkage: cfg.shrinkage });
    const outcomes = test.map((p) => p.outcome);
    const forecasts = forecastAll(model, test.map((p) => p.state), {
      minSupport: MIN_SUPPORT,
      symbols: test.map((p) => p.symbol),
    });
    results[cfg.label] = {
      states: model.states,
      symbolCells: model.symbolStates,
      skill: skillScore(forecasts, outcomes),
      per: perObservationBrier(forecasts, outcomes),
      outcomes,
      test,
    };
  }
  db.close();

  const a = results[A.label];
  const b = results[B.label];
  if (a.per.length !== b.per.length) {
    console.error(`the two runs did not line up: ${a.per.length} vs ${b.per.length} observations`);
    console.error("a paired test is meaningless unless both scored the same questions");
    process.exit(2);
  }
  for (let i = 0; i < a.outcomes.length; i++) {
    if (a.outcomes[i] !== b.outcomes[i] || a.test[i].at !== b.test[i].at) {
      console.error(`observation ${i} differs between runs; the pairing is broken`);
      process.exit(2);
    }
  }

  // Positive means B is better, since lower Brier is better.
  const diffs = a.per.map((x, i) => x - b.per[i]);
  const boot = pairedBootstrap(diffs);
  const changed = diffs.filter((d) => d !== 0).length;

  console.log(`mode         ${FINAL ? "FINAL" : "VALIDATION"}`);
  console.log(`observations ${a.per.length.toLocaleString()}  base rate ${baseRate(a.outcomes).toFixed(4)}`);
  console.log(`A ${A.label.padEnd(11)} skill ${a.skill.toFixed(4)}  states ${a.states}  symbolCells ${a.symbolCells}`);
  console.log(`B ${B.label.padEnd(11)} skill ${b.skill.toFixed(4)}  states ${b.states}  symbolCells ${b.symbolCells}`);
  console.log("");
  console.log(`the two configurations scored differently on ${changed.toLocaleString()} of ${a.per.length.toLocaleString()} observations`);
  console.log(`mean paired Brier improvement  ${boot.observed.toExponential(3)}`);
  console.log(`95% interval                   ${boot.lo.toExponential(3)} to ${boot.hi.toExponential(3)}`);
  console.log("");
  console.log(
    boot.crossesZero
      ? `VERDICT: the interval contains zero. ${B.label} is not measurably better than ${A.label} on this data, so keep the simpler one.`
      : boot.observed > 0
        ? `VERDICT: ${B.label} is better and the interval excludes zero. Keep it.`
        : `VERDICT: ${A.label} is better and the interval excludes zero. Revert to it.`
  );
}

main();
