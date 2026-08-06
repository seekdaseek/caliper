/**
 * caliper — write the next forecast and settle what has closed.
 *
 *   LIQ_DB=/opt/agentfeed/liquidations.db RECORD_DB=/opt/caliper/record.db \
 *   node bin/record.mjs
 *
 * Run every 15 minutes on the window boundary. Each run does two things and
 * neither can be undone: it writes forecasts for the window that has NOT
 * opened yet, and it settles any window that has closed by reading the tape.
 *
 * SYMBOLS defaults to the majors. Widening it costs nothing but rows.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fromJSON } from "../lib/model.mjs";
import { answer } from "../lib/answer.mjs";
import { initLog, recordForecast, settleDue, tally } from "../lib/record.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const LIQ_DB = process.env.LIQ_DB ?? "/opt/agentfeed/liquidations.db";
const RECORD_DB = process.env.RECORD_DB ?? "./record.db";
const MODEL = process.env.CALIPER_MODEL ?? "./model.json";
const SYMBOLS = (process.env.SYMBOLS ?? "SOLUSDT,BTCUSDT,ETHUSDT,XRPUSDT,DOGEUSDT").split(",");

function main() {
  const now = Date.now();
  const tape = new DatabaseSync(LIQ_DB, { readOnly: true });
  const log = initLog(new DatabaseSync(RECORD_DB));

  // Settle first. If the model or the tape is broken, yesterday's outcomes
  // still get written, and a record with a gap in its forecasts is far more
  // honest than one with a gap in its results.
  const settled = settleDue(log, tape, now);

  let raw;
  try {
    raw = JSON.parse(readFileSync(MODEL, "utf8"));
  } catch (err) {
    console.error(`settled ${settled.settled}/${settled.due}; no forecasts written: model unreadable (${err.message})`);
    log.close();
    tape.close();
    process.exit(1);
  }
  const model = fromJSON(raw);
  const thresholds = raw.thresholds ?? {};

  let written = 0;
  let skipped = 0;
  for (const symbol of SYMBOLS) {
    const t = thresholds[symbol];
    const a = answer(model, tape, symbol, now, t ? { threshold: t } : {});
    a.modelFittedAt = raw.fittedAt ?? null;
    try {
      const r = recordForecast(log, a, now);
      r.written ? written++ : skipped++;
    } catch (err) {
      console.error(`${symbol}: ${err.message}`);
      skipped++;
    }
  }

  const t = tally(log);
  log.close();
  tape.close();
  console.log(
    `settled ${settled.settled}/${settled.due}  wrote ${written}  skipped ${skipped}  ` +
    `record ${t.settled} settled / ${t.pending} pending` +
    (t.skill === null ? "" : `  skill ${t.skill.toFixed(4)}  coverage ${t.coverage.toFixed(3)}`)
  );
}

main();
