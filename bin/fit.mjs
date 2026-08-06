/**
 * caliper — fit the model and write it to a small JSON file.
 *
 *   LIQ_DB=/opt/agentfeed/liquidations.db MODEL_OUT=/opt/caliper/model.json node bin/fit.mjs
 *
 * Trains on the WHOLE tape, because this is the live model rather than a
 * backtest. Nothing here is scored, so there is no split to respect: the
 * honest evaluation is bin/backtest.mjs and it uses a different code path on
 * purpose. Run this on a schedule; the tape only gets longer.
 */
import { createRequire } from "node:module";
import { writeFileSync, renameSync } from "node:fs";
import { toWindows, densify, thresholdFor, labelledPairs } from "../lib/features.mjs";
import { fit, toJSON } from "../lib/model.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DB = process.env.LIQ_DB ?? "/opt/agentfeed/liquidations.db";
const OUT = process.env.MODEL_OUT ?? "./model.json";
const MIN_WINDOWS = Number(process.env.MIN_TRAIN_WINDOWS ?? 200);
const SCHEME = process.env.LEVEL_SCHEME ?? "fine";
const SHRINKAGE = Number(process.env.SHRINKAGE ?? 50);

function main() {
  const started = Date.now();
  const db = new DatabaseSync(DB, { readOnly: true });
  const span = db.prepare("SELECT MIN(ts) AS lo, MAX(ts) AS hi, COUNT(*) AS n FROM liquidations").get();
  const symbols = db.prepare("SELECT DISTINCT symbol FROM liquidations").all().map((r) => r.symbol);
  const rows = db.prepare("SELECT ts, symbol, side, usd FROM liquidations WHERE symbol = ? ORDER BY ts");

  const pairs = [];
  const thresholds = {};
  let included = 0;
  for (const symbol of symbols) {
    const events = rows.all(symbol);
    if (events.length === 0) continue;
    const w = toWindows(events).get(symbol);
    if (!w) continue;
    const windows = densify(w);
    if (windows.length < MIN_WINDOWS) continue;
    const threshold = thresholdFor(windows, 0.9);
    if (threshold === null || threshold <= 0) continue;
    thresholds[symbol] = threshold;
    pairs.push(...labelledPairs(windows, threshold, SCHEME));
    included++;
  }
  db.close();

  if (pairs.length === 0) {
    console.error("no training pairs; refusing to write an empty model");
    process.exit(2);
  }

  const model = fit(pairs, { shrinkage: SHRINKAGE });
  const json = toJSON(model, {
    fittedAt: new Date().toISOString(),
    scheme: SCHEME,
    shrinkage: SHRINKAGE,
    tape: { events: span.n, firstTs: span.lo, lastTs: span.hi },
    symbolsIncluded: included,
    thresholds,
  });

  // Write then rename, so a reader never sees a half-written model.
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, JSON.stringify(json));
  renameSync(tmp, OUT);

  console.log(
    `fitted ${model.states} states from ${pairs.length.toLocaleString()} pairs across ${included} symbols`
  );
  console.log(`base rate ${model.baseRate.toFixed(4)}  ->  ${OUT}  in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main();
