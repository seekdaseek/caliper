/**
 * caliper — tune the shrinkage weight on VALIDATION, never on the test slice.
 *
 *   LIQ_DB=/opt/agentfeed/liquidations.db node bin/sweep.mjs
 *
 * The weight m controls how hard a symbol's own record is pulled toward the
 * pooled estimate. Too low and thin symbols overfit their own noise; too high
 * and the symbol layer does nothing. Fifty was a guess, so it gets measured.
 *
 * Every candidate is scored on the SAME questions, so the comparison is
 * paired and the differences mean something.
 */
import { createRequire } from "node:module";
import { prepareSymbol } from "../lib/backtest.mjs";
import { fit, forecastAll } from "../lib/model.mjs";
import { skillScore, coverage, murphy } from "../lib/scoring.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DB = process.env.LIQ_DB ?? "/opt/agentfeed/liquidations.db";
const WEIGHTS = (process.env.WEIGHTS ?? "0,10,25,50,100,250,1000").split(",").map(Number);
const SCHEMES = (process.env.SCHEMES ?? "coarse,fine").split(",");

function main() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const span = db.prepare("SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM liquidations").get();
  const width = span.hi - span.lo;
  const bounds = {
    trainEndTs: span.lo + width * 0.7,
    evalStartTs: span.lo + width * 0.7,
    evalEndTs: span.lo + width * 0.85,
  };
  const symbols = db.prepare("SELECT DISTINCT symbol FROM liquidations").all().map((r) => r.symbol);
  const rows = db.prepare("SELECT ts, symbol, side, usd FROM liquidations WHERE symbol = ? ORDER BY ts");

  const sets = {};
  for (const scheme of SCHEMES) {
    const train = [];
    const test = [];
    for (const symbol of symbols) {
      const events = rows.all(symbol);
      if (events.length === 0) continue;
      const p = prepareSymbol(events, bounds, { minTrainWindows: 200, scheme });
      if (!p || p.skipped) continue;
      train.push(...p.trainPairs);
      test.push(...p.testPairs);
    }
    sets[scheme] = { train, test };
  }
  db.close();

  console.log("scheme   shrink     skill  coverage  reliability  resolution   symbolCells");
  let best = null;
  for (const scheme of SCHEMES) {
    const { train, test } = sets[scheme];
    const outcomes = test.map((p) => p.outcome);
    const states = test.map((p) => p.state);
    const syms = test.map((p) => p.symbol);
    for (const m of WEIGHTS) {
      const model = fit(train, { shrinkage: m });
      const f = forecastAll(model, states, { minSupport: 30, symbols: syms });
      const mu = murphy(f, outcomes);
      const s = skillScore(f, outcomes);
      console.log(
        `${scheme.padEnd(8)} ${String(m).padStart(6)}  ${s.toFixed(4)}    ${coverage(f).toFixed(4)}     ${mu.reliability.toFixed(5)}     ${mu.resolution.toFixed(5)}   ${model.symbolStates}`
      );
      if (!best || s > best.skill) best = { scheme, m, skill: s };
    }
  }
  console.log("");
  console.log(`best on validation: scheme=${best.scheme} shrinkage=${best.m} skill=${best.skill.toFixed(4)}`);
  console.log("Tuned on validation only. The sealed slice has not been read.");
}

main();
