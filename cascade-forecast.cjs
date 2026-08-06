// tools/cascade-forecast.js — caliper miner, served through AgentFeed's rail.
//
// AgentFeed is CommonJS and caliper is ESM, so the library is pulled in with a
// dynamic import the first time it is needed and cached after that.
//
// Two things are deliberately NOT done here. Fitting: it reads the whole tape
// and takes seconds, so the model is precomputed by cron into model.json and
// this only loads it. And a second database module: this opens its own
// read-only handle rather than coupling to AgentFeed's, so a change in either
// cannot silently break the other.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');

const CALIPER_DIR = process.env.CALIPER_DIR || '/opt/caliper';
const MODEL_PATH = process.env.CALIPER_MODEL || `${CALIPER_DIR}/model.json`;
const LIQ_DB = process.env.CALIPER_LIQ_DB || '/opt/agentfeed/liquidations.db';
const RECORD_DB = process.env.CALIPER_RECORD_DB || `${CALIPER_DIR}/record.db`;
const FREE_SYMBOL = 'SOLUSDT';
const MAX_BATCH = 20;

let lib = null;
let model = null;
let modelMtime = 0;
let modelMeta = null;
let db = null;

async function loadLib() {
  if (lib) return lib;
  const [answerMod, modelMod] = await Promise.all([
    import(`file://${CALIPER_DIR}/lib/answer.mjs`),
    import(`file://${CALIPER_DIR}/lib/model.mjs`),
  ]);
  lib = { ...answerMod, fromJSON: modelMod.fromJSON };
  return lib;
}

// Reload when the file changes on disk, so a cron refit takes effect without a
// restart. Cheap: one stat per call.
function loadModel(fromJSON) {
  const stat = fs.statSync(MODEL_PATH);
  if (model && stat.mtimeMs === modelMtime) return model;
  const raw = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  model = fromJSON(raw);
  modelMtime = stat.mtimeMs;
  modelMeta = {
    fittedAt: raw.fittedAt,
    scheme: raw.scheme,
    trainedOn: raw.trainedOn,
    symbolsIncluded: raw.symbolsIncluded,
    thresholds: raw.thresholds || {},
  };
  return model;
}

function getDb() {
  if (!db) db = new DatabaseSync(LIQ_DB, { readOnly: true });
  return db;
}

function normalise(sym) {
  if (!sym) return null;
  const s = String(sym).trim().toUpperCase();
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

/**
 * A failure to load the model is OUR failure and is reported as unmeasured for
 * every requested symbol, never as an exception and never as a probability.
 */
function unmeasuredAll(symbols, reason) {
  return {
    model: null,
    answers: symbols.map((symbol) => ({ symbol, evidence: 'unmeasured', p: null, reason })),
  };
}

async function getCascadeForecast({ query = {} } = {}) {
  const requested = query.symbols
    ? String(query.symbols).split(',').map(normalise).filter(Boolean).slice(0, MAX_BATCH)
    : [normalise(query.symbol) || FREE_SYMBOL];

  let answerFn;
  let m;
  try {
    const l = await loadLib();
    answerFn = l.answerMany;
    m = loadModel(l.fromJSON);
  } catch (err) {
    return unmeasuredAll(requested, `model unavailable: ${err.message}`);
  }

  const now = Date.now();
  const out = requested.map((symbol) => {
    const threshold = modelMeta.thresholds[symbol];
    // No stored threshold means this symbol was not in the training universe.
    // Recomputing one here would answer a different question than the model
    // was trained on, so it is left to the library to refuse.
    const opts = threshold ? { threshold } : {};
    return answerFn(m, getDb(), [symbol], now, opts)[0];
  });

  return {
    model: {
      fittedAt: modelMeta.fittedAt,
      scheme: modelMeta.scheme,
      trainedOnPairs: modelMeta.trainedOn,
      symbolsCovered: modelMeta.symbolsIncluded,
    },
    answers: out,
  };
}

/** Free taster: one symbol, full quality, no delay. */
async function getCascadeForecastFree() {
  return getCascadeForecast({ query: { symbol: FREE_SYMBOL } });
}

/**
 * The live track record.
 *
 * Free on purpose. A backtest is a claim the author also chose how to compute;
 * this is forecasts written before their window and settled from the public
 * feed afterwards. The raw rows travel with the score so nobody has to take
 * the score on trust.
 */
async function getForecastRecord({ query = {} } = {}) {
  let rec;
  try {
    rec = await import(`file://${CALIPER_DIR}/lib/record.mjs`);
  } catch (err) {
    return { error: `record unavailable: ${err.message}` };
  }
  let log;
  try {
    log = new DatabaseSync(RECORD_DB, { readOnly: true });
  } catch (err) {
    return { error: `no record yet: ${err.message}` };
  }
  try {
    const limit = Math.min(Number(query.rows) || 50, 500);
    const summary = rec.tally(log, query.symbol ? { symbol: String(query.symbol).toUpperCase() } : {});
    const rows = rec.exportRows(log, limit).map((r) => ({
      symbol: r.symbol,
      window: new Date(r.window_start).toISOString(),
      madeAt: new Date(r.made_at).toISOString(),
      thresholdUsd: r.threshold_usd,
      p: r.p,
      evidence: r.evidence,
      observedUsd: r.observed_usd,
      outcome: r.outcome,
      settled: r.settled_at !== null,
    }));
    return {
      howToCheck:
        'every row was written before its window opened and settled from the exchange public feed afterwards; sum liquidation USD for the symbol between window start and end and compare to thresholdUsd',
      summary,
      rows,
    };
  } finally {
    log.close();
  }
}

/** The published question contract, so an app never has to read this file. */
async function getForecastQuestion() {
  try {
    const l = await loadLib();
    const spec = l.questionSpec();
    let coverage = null;
    try {
      loadModel(l.fromJSON);
      coverage = {
        fittedAt: modelMeta.fittedAt,
        symbolsCovered: modelMeta.symbolsIncluded,
        symbols: Object.keys(modelMeta.thresholds).sort(),
      };
    } catch (err) {
      coverage = { error: `model unavailable: ${err.message}` };
    }
    return { question: spec, coverage, freeSymbol: FREE_SYMBOL, maxBatch: MAX_BATCH };
  } catch (err) {
    return { error: `caliper unavailable: ${err.message}` };
  }
}

module.exports = { getCascadeForecast, getCascadeForecastFree, getForecastQuestion, getForecastRecord };
