/**
 * caliper — backtest against the real tape.
 *
 *   HAIRCUT_DB unused here. Point it at the liquidation tape:
 *
 *   LIQ_DB=/opt/agentfeed/liquidations.db node bin/backtest.mjs
 *   LIQ_DB=... node bin/backtest.mjs --json > backtest.json
 *
 * Read only. Symbols are processed one at a time so the whole tape never sits
 * in memory, and only the labelled pairs accumulate.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { prepareSymbol } from "../lib/backtest.mjs";
import { fit, forecastAll } from "../lib/model.mjs";
import { skillScore, coverage, murphy, baseRate, meanBrier } from "../lib/scoring.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DB = process.env.LIQ_DB ?? "/opt/agentfeed/liquidations.db";
// 0.70 to match bin/compare.mjs. These two defaulted differently for a while,
// which made their outputs quietly incomparable: the same scheme read 0.1216
// in one and 0.1428 in the other purely because the slices differed. A number
// is only worth reporting alongside the boundary it came from.
const TRAIN_FRACTION = Number(process.env.TRAIN_FRACTION ?? 0.7);
const MIN_SUPPORT = Number(process.env.MIN_SUPPORT ?? 30);
const MIN_TRAIN_WINDOWS = Number(process.env.MIN_TRAIN_WINDOWS ?? 200);
const jsonOnly = process.argv.includes("--json");
// The test slice is only read when asked for by name. Nothing enforces this
// but the flag, and that is the point: "which slice did that number come from"
// should always have an answer.
const MODE = process.argv.includes("--final") ? "final" : "validation";

// Sealing the final read.
//
// A held-out slice is only held out if nobody has looked at it. On 6 Aug 2026
// a reliability curve was read over the last quarter of the tape and the model
// was changed because of what it showed. Every observation that existed at
// that moment is therefore contaminated, and no re-splitting of it can undo
// that — the information already moved.
//
// Data that arrives AFTER that instant cannot be. So the final read evaluates
// only on windows starting after a recorded seal timestamp, and refuses to
// call itself final otherwise. The tape grows about 49,000 events a day, so
// the wait costs nothing but patience.
const SEAL_FILE = process.env.SEAL_FILE ?? new URL("../SEALED_AT", import.meta.url).pathname;
const SCHEME = process.env.LEVEL_SCHEME ?? "fine";
const SHRINKAGE = Number(process.env.SHRINKAGE ?? 50);
const log = (...a) => { if (!jsonOnly) console.log(...a); };

function main() {
  const db = new DatabaseSync(DB, { readOnly: true });

  const span = db.prepare("SELECT MIN(ts) AS lo, MAX(ts) AS hi, COUNT(*) AS n FROM liquidations").get();
  if (!span || !span.n) {
    console.error("tape is empty");
    process.exit(2);
  }
  const width = span.hi - span.lo;
  const VALIDATION_FRACTION = Number(process.env.VALIDATION_FRACTION ?? 0.85);
  let trainEndTs = span.lo + width * (MODE === "final" ? VALIDATION_FRACTION : TRAIN_FRACTION);
  let evalStartTs = trainEndTs;
  let evalEndTs = MODE === "final" ? Infinity : span.lo + width * VALIDATION_FRACTION;

  if (MODE === "final") {
    let sealedAt;
    try {
      sealedAt = Date.parse(readFileSync(SEAL_FILE, "utf8").trim());
    } catch {
      console.error(`no seal file at ${SEAL_FILE}.`);
      console.error("A final read is only meaningful on data nobody has looked at. Create it with:");
      console.error(`  date -u +%Y-%m-%dT%H:%M:%SZ > ${SEAL_FILE}`);
      console.error("then wait for the tape to grow past that instant.");
      process.exit(2);
    }
    if (!Number.isFinite(sealedAt)) {
      console.error(`seal file ${SEAL_FILE} does not contain a parseable timestamp`);
      process.exit(2);
    }
    if (span.hi <= sealedAt) {
      console.error(`the tape ends ${new Date(span.hi).toISOString()}, at or before the seal ${new Date(sealedAt).toISOString()}.`);
      console.error("There is no unseen data yet. Refusing to report a final number.");
      process.exit(2);
    }
    trainEndTs = sealedAt;
    evalStartTs = sealedAt;
    evalEndTs = Infinity;
    const unseenDays = (span.hi - sealedAt) / 86400000;
    log(`sealed   ${new Date(sealedAt).toISOString()}  (${unseenDays.toFixed(1)} days of unseen data)`);
    if (unseenDays < 3) {
      log(`WARNING  only ${unseenDays.toFixed(1)} days past the seal. Thin, but honest.`);
    }
  }
  const cutoffTs = trainEndTs;
  const days = width / 86400000;

  log(`tape     ${span.n.toLocaleString()} events over ${days.toFixed(1)} days`);
  log(`mode     ${MODE.toUpperCase()}${MODE === "final" ? "  (reading the held-out test slice)" : "  (test slice untouched)"}`);
  log(`scheme   ${SCHEME}  shrinkage ${SHRINKAGE}`);
  log(`train    up to ${new Date(trainEndTs).toISOString()}`);
  log(`evaluate ${new Date(evalStartTs).toISOString()} to ${MODE === "final" ? "end of tape" : new Date(evalEndTs).toISOString()}`);

  const symbols = db.prepare("SELECT DISTINCT symbol FROM liquidations").all().map((r) => r.symbol);
  log(`symbols  ${symbols.length}`);

  const rows = db.prepare("SELECT ts, symbol, side, usd FROM liquidations WHERE symbol = ? ORDER BY ts");
  const trainPairs = [];
  const testPairs = [];
  const skipped = [];
  let included = 0;

  for (const symbol of symbols) {
    const events = rows.all(symbol);
    if (events.length === 0) continue;
    const prepared = prepareSymbol(
      events,
      { trainEndTs, evalStartTs, evalEndTs },
      { minTrainWindows: MIN_TRAIN_WINDOWS, scheme: SCHEME }
    );
    if (!prepared) continue;
    if (prepared.skipped) {
      skipped.push({ symbol, reason: prepared.skipped });
      continue;
    }
    trainPairs.push(...prepared.trainPairs);
    testPairs.push(...prepared.testPairs);
    included++;
  }
  db.close();

  if (testPairs.length === 0) {
    console.error(`no ${MODE} pairs survived the cutoff`);
    process.exit(2);
  }

  const model = fit(trainPairs, { shrinkage: SHRINKAGE });
  const outcomes = testPairs.map((p) => p.outcome);
  const forecasts = forecastAll(model, testPairs.map((p) => p.state), {
    minSupport: MIN_SUPPORT,
    symbols: testPairs.map((p) => p.symbol),
  });
  const m = murphy(forecasts, outcomes);

  const report = {
    mode: MODE,
    scheme: SCHEME,
    shrinkage: SHRINKAGE,
    sealFile: MODE === "final" ? SEAL_FILE : null,
    tape: { events: span.n, days: Number(days.toFixed(2)), firstTs: span.lo, lastTs: span.hi },
    cutoffTs,
    symbols: { total: symbols.length, included, skipped: skipped.length },
    skippedExamples: skipped.slice(0, 5),
    pairs: { train: trainPairs.length, test: testPairs.length },
    states: model.states,
    baseRate: { train: model.baseRate, test: baseRate(outcomes) },
    minSupport: MIN_SUPPORT,
    skill: skillScore(forecasts, outcomes),
    coverage: coverage(forecasts),
    brierAnswered: meanBrier(forecasts, outcomes),
    reliability: m?.reliability ?? null,
    resolution: m?.resolution ?? null,
    residual: m?.residual ?? null,
    curve: m?.curve ?? [],
  };

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pct = (x) => (x === null ? "n/a" : x.toFixed(4));
  log(`included ${included}, skipped ${skipped.length}`);
  if (skipped.length) log(`  e.g. ${skipped[0].symbol}: ${skipped[0].reason}`);
  log(`pairs    ${trainPairs.length.toLocaleString()} train / ${testPairs.length.toLocaleString()} test`);
  log(`states   ${model.states} distinct, min support ${MIN_SUPPORT}`);
  log("");
  log(`base rate    train ${pct(model.baseRate)}   test ${pct(baseRate(outcomes))}`);
  log(`SKILL        ${pct(report.skill)}   <- 0 means no better than knowing the base rate`);
  log(`coverage     ${pct(report.coverage)}   fraction of questions answered rather than declined`);
  log(`brier        ${pct(report.brierAnswered)}   over answered questions only`);
  log(`reliability  ${pct(report.reliability)}   calibration error, lower is better`);
  log(`resolution   ${pct(report.resolution)}   discrimination, higher is better`);
  log(`residual     ${pct(report.residual)}   binning error, should be near zero`);
  log("");
  log("reliability curve  forecast -> observed  (n)");
  for (const b of report.curve) {
    const bar = "#".repeat(Math.max(1, Math.round(b.observedRate * 40)));
    log(`  ${b.meanForecast.toFixed(3)} -> ${b.observedRate.toFixed(3)}  (${String(b.n).padStart(6)})  ${bar}`);
  }
}

main();
