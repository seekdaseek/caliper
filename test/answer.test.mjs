import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, answerMany, questionSpec, loadRecent, QUESTION_ID } from "../lib/answer.mjs";
import { fit } from "../lib/model.mjs";
import { labelledPairs, toWindows, densify, thresholdFor, WINDOW_MS } from "../lib/features.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const NOW = 1785993793486;

function makeDb(dir, { symbol = "SIMUSDT", windows = 1200, seed = 5, silent = false } = {}) {
  const path = join(dir, `${symbol}-${seed}-${silent}.db`);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS liquidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
    side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL,
    exchange TEXT NOT NULL DEFAULT 'bybit')`);
  const ins = db.prepare("INSERT INTO liquidations (ts,symbol,side,size,price,usd) VALUES (?,?,?,?,?,?)");
  const r = rng(seed);
  const start = NOW - windows * WINDOW_MS;
  let hot = false;
  for (let i = 0; i < windows; i++) {
    const ts = start + i * WINDOW_MS + 1;
    if (silent) {
      ins.run(ts, symbol, "Buy", 1, 1, 0);
      continue;
    }
    const p = hot ? 0.45 : 0.06;
    if (r() < p) {
      const n = 5 + Math.floor(r() * 30);
      for (let k = 0; k < n; k++) ins.run(ts + k, symbol, r() < 0.75 ? "Buy" : "Sell", 1, 1, 500 + r() * 3000);
      hot = true;
    } else {
      if (r() < 0.5) ins.run(ts, symbol, r() < 0.5 ? "Buy" : "Sell", 1, 1, 10 + r() * 200);
      hot = false;
    }
  }
  db.close();
  return new DatabaseSync(path, { readOnly: true });
}

function trainedOn(db, symbol) {
  const rows = db.prepare("SELECT ts, symbol, side, usd FROM liquidations WHERE symbol = ? ORDER BY ts").all(symbol);
  const w = densify(toWindows(rows).get(symbol));
  return fit(labelledPairs(w, thresholdFor(w, 0.9)));
}

let dir;
test("setup", () => {
  dir = mkdtempSync(join(tmpdir(), "caliper-"));
});

test("the question spec is machine readable and says how to settle it", () => {
  const q = questionSpec();
  assert.equal(q.id, QUESTION_ID);
  assert.equal(q.windowSeconds, 900);
  assert.match(q.settlement, /public feed|public liquidation|exchange/i);
  assert.match(q.settleable_by, /anyone/i);
  assert.match(q.declines, /not an error/);
});

test("an answer carries the question, the threshold and the support with it", () => {
  const db = makeDb(dir);
  const a = answer(trainedOn(db, "SIMUSDT"), db, "SIMUSDT", NOW);
  db.close();
  assert.equal(a.question.id, QUESTION_ID);
  assert.equal(a.symbol, "SIMUSDT");
  assert.ok(a.thresholdUsd > 0);
  assert.ok(a.windowStart && a.windowEnd);
  assert.ok(["measured", "absent", "unmeasured"].includes(a.evidence));
  if (a.evidence === "measured") {
    assert.ok(a.p >= 0 && a.p <= 1);
    assert.ok(a.support >= 30);
    assert.match(a.basis, /empirical frequency/);
  }
});

test("the window used is one that has actually closed, never the one in progress", () => {
  const db = makeDb(dir);
  const a = answer(trainedOn(db, "SIMUSDT"), db, "SIMUSDT", NOW);
  db.close();
  assert.ok(Date.parse(a.windowEnd) <= NOW, "answered from a window that has not finished yet");
});

test("a symbol with no history declines by name instead of guessing", () => {
  const db = makeDb(dir);
  const a = answer(trainedOn(db, "SIMUSDT"), db, "NOSUCHUSDT", NOW);
  db.close();
  assert.equal(a.evidence, "unmeasured");
  assert.equal(a.p, null);
  assert.match(a.reason, /never been recorded/);
});

test("a symbol that trades but never liquidates is ABSENT, not unmeasured", () => {
  const db = makeDb(dir, { symbol: "DEADUSDT", silent: true });
  const a = answer(fit([]), db, "DEADUSDT", NOW);
  db.close();
  assert.equal(a.evidence, "absent");
  assert.match(a.reason, /covered and has recorded no liquidation volume/);
});

test("an untrained model declines rather than returning the base rate", () => {
  const db = makeDb(dir);
  const a = answer(fit([]), db, "SIMUSDT", NOW);
  db.close();
  assert.equal(a.evidence, "unmeasured");
  assert.equal(a.p, null);
});

test("a broken database is reported, never turned into a probability", () => {
  const broken = { prepare() { throw new Error("database is locked"); } };
  const a = answer(fit([]), broken, "SIMUSDT", NOW);
  assert.equal(a.evidence, "unmeasured");
  assert.match(a.reason, /database is locked/);
  assert.equal(a.p, null);
});

test("a batch survives one bad symbol", () => {
  const db = makeDb(dir);
  const model = trainedOn(db, "SIMUSDT");
  const out = answerMany(model, db, ["SIMUSDT", "NOSUCHUSDT"], NOW);
  db.close();
  assert.equal(out.length, 2);
  assert.equal(out[1].evidence, "unmeasured");
});

test("loadRecent bounds its read instead of scanning the whole tape", () => {
  const calls = [];
  const fake = {
    prepare(sql) {
      calls.push(sql);
      return { all: (...args) => (calls.push(args), []) };
    },
  };
  loadRecent(fake, "X", NOW);
  assert.match(calls[0], /ts >= \?/);
  assert.ok(calls[1][1] < NOW, "the lower bound must actually be in the past");
});

test("teardown", () => {
  rmSync(dir, { recursive: true, force: true });
});

test("a model-supplied threshold is used verbatim and declared as such", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-t-"));
  const db = makeDb(dir2, { seed: 91 });
  const model = trainedOn(db, "SIMUSDT");
  const a = answer(model, db, "SIMUSDT", NOW, { threshold: 12345 });
  db.close();
  rmSync(dir2, { recursive: true, force: true });
  assert.equal(a.thresholdUsd, 12345);
  assert.match(a.thresholdSource, /trained against/);
});

test("without a supplied threshold it recomputes and says so", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-r-"));
  const db = makeDb(dir2, { seed: 92 });
  const a = answer(trainedOn(db, "SIMUSDT"), db, "SIMUSDT", NOW);
  db.close();
  rmSync(dir2, { recursive: true, force: true });
  assert.match(a.thresholdSource, /recomputed/);
});

test("with a supplied threshold only a few windows are needed, not two hundred", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-s-"));
  const db = makeDb(dir2, { symbol: "SHORTUSDT", windows: 20, seed: 93 });
  const a = answer(fit([{ at: 1, state: "x", outcome: 1 }]), db, "SHORTUSDT", NOW, { threshold: 500 });
  db.close();
  rmSync(dir2, { recursive: true, force: true });
  assert.doesNotMatch(a.reason ?? "", /minimum is 200/);
});

test("a quiet market is answered, not refused, when the threshold is known", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-q-"));
  const path = join(dir2, "quiet.db");
  const w = new DatabaseSync(path);
  w.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, symbol TEXT,
    side TEXT, size REAL, price REAL, usd REAL, exchange TEXT DEFAULT 'bybit')`);
  // Plenty of history, but absolutely nothing in the recent windows.
  const ins = w.prepare("INSERT INTO liquidations (ts,symbol,side,size,price,usd) VALUES (?,?,?,?,?,?)");
  for (let i = 0; i < 50; i++) ins.run(NOW - (500 + i) * WINDOW_MS, "QUIETUSDT", "Buy", 1, 1, 1000);
  w.close();
  const db = new DatabaseSync(path, { readOnly: true });
  const model = fit(Array.from({ length: 100 }, (_, i) => ({ at: i, state: "0|0|0|0", outcome: i < 3 ? 1 : 0 })));
  const a = answer(model, db, "QUIETUSDT", NOW, { threshold: 5000 });
  db.close();
  rmSync(dir2, { recursive: true, force: true });
  assert.equal(a.evidence, "measured", `expected an answer, got: ${a.reason}`);
  assert.equal(a.observed.usd, 0, "the recent window really was empty");
  assert.ok(a.p < 0.1, "and a quiet state should read as unlikely");
});

test("the recent frame is complete even when nothing traded in it", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-f-"));
  const path = join(dir2, "empty.db");
  const w = new DatabaseSync(path);
  w.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, symbol TEXT,
    side TEXT, size REAL, price REAL, usd REAL, exchange TEXT DEFAULT 'bybit')`);
  w.close();
  const db = new DatabaseSync(path, { readOnly: true });
  const frame = loadRecent(db, "NOTHINGUSDT", NOW, { lookbackWindows: 6 });
  db.close();
  rmSync(dir2, { recursive: true, force: true });
  assert.equal(frame.length, 6, "a quiet span must still produce six windows");
  assert.ok(frame.every((x) => x.usd === 0 && x.count === 0));
});

test("absent and unmeasured are not collapsed: no volume at all versus not enough of it", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-au-"));
  const mk = (name, fill) => {
    const path = join(dir2, `${name}.db`);
    const w = new DatabaseSync(path);
    w.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, symbol TEXT,
      side TEXT, size REAL, price REAL, usd REAL, exchange TEXT DEFAULT 'bybit')`);
    fill(w.prepare("INSERT INTO liquidations (ts,symbol,side,size,price,usd) VALUES (?,?,?,?,?,?)"));
    w.close();
    return new DatabaseSync(path, { readOnly: true });
  };

  const none = mk("none", (ins) => {
    for (let i = 0; i < 300; i++) ins.run(NOW - (i + 2) * WINDOW_MS, "NONEUSDT", "Buy", 1, 1, 0);
  });
  const a1 = answer(fit([]), none, "NONEUSDT", NOW);
  none.close();
  assert.equal(a1.evidence, "absent", `expected absent, got ${a1.evidence}: ${a1.reason}`);
  assert.match(a1.reason, /covered/);

  const few = mk("few", (ins) => {
    for (let i = 0; i < 10; i++) ins.run(NOW - (i + 2) * WINDOW_MS, "FEWUSDT", "Buy", 1, 1, 900);
  });
  const a2 = answer(fit([]), few, "FEWUSDT", NOW);
  few.close();
  assert.equal(a2.evidence, "unmeasured", `expected unmeasured, got ${a2.evidence}: ${a2.reason}`);
  assert.match(a2.reason, /minimum is 200/);

  rmSync(dir2, { recursive: true, force: true });
});

test("a symbol we have never recorded is a coverage gap, not an absence", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-cov-"));
  const db = makeDb(dir2, { seed: 77 });
  const a = answer(fit([]), db, "NEVERSEENUSDT", NOW);
  db.close();
  rmSync(dir2, { recursive: true, force: true });
  assert.equal(a.evidence, "unmeasured");
  assert.match(a.reason, /says nothing about the market/);
});
