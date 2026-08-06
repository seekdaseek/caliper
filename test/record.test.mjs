import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLog, recordForecast, settleDue, tally, exportRows, RecordError } from "../lib/record.mjs";
import { WINDOW_MS } from "../lib/features.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

// Sit deliberately just inside a window so the next one has not opened.
const NOW = Math.floor(1785993793486 / WINDOW_MS) * WINDOW_MS + 1000;
const NEXT = Math.floor(NOW / WINDOW_MS) * WINDOW_MS + WINDOW_MS;

const ans = (over = {}) => ({
  symbol: "SOLUSDT", evidence: "measured", p: 0.2, thresholdUsd: 1000,
  support: 500, symbolSupport: 40, state: "2|2|1|0", modelFittedAt: "2026-08-06T00:00:00Z",
  ...over,
});

function logDb(dir, name = "log") {
  return initLog(new DatabaseSync(join(dir, `${name}.db`)));
}

function tape(dir, rows) {
  const db = new DatabaseSync(join(dir, "tape.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER, symbol TEXT, side TEXT, size REAL, price REAL, usd REAL)`);
  const ins = db.prepare("INSERT INTO liquidations (ts,symbol,side,size,price,usd) VALUES (?,?,?,?,?,?)");
  for (const [ts, symbol, usd] of rows) ins.run(ts, symbol, "Buy", 1, 1, usd);
  return db;
}

let dir;
test("setup", () => { dir = mkdtempSync(join(tmpdir(), "caliper-rec-")); });

test("a forecast is written for the NEXT window, never the current one", () => {
  const db = logDb(dir, "next");
  const r = recordForecast(db, ans(), NOW);
  db.close();
  assert.equal(r.written, true);
  assert.equal(r.window_start, NEXT);
  assert.ok(r.window_start > NOW, "the window predicted must not have opened yet");
  assert.equal(r.made_at, NOW);
});

test("the same symbol and window cannot be forecast twice", () => {
  const db = logDb(dir, "dup");
  assert.equal(recordForecast(db, ans(), NOW).written, true);
  const second = recordForecast(db, ans({ p: 0.9 }), NOW + 1000);
  db.close();
  assert.equal(second.written, false);
  assert.match(second.reason, /already forecast/);
});

test("an overwrite attempt leaves the original untouched", () => {
  const db = logDb(dir, "immutable");
  recordForecast(db, ans({ p: 0.2 }), NOW);
  recordForecast(db, ans({ p: 0.95 }), NOW + 1000);
  const rows = exportRows(db);
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].p, 0.2, "the first prediction must survive");
});

test("a declined answer is recorded as a decline, not dropped", () => {
  const db = logDb(dir, "decline");
  const r = recordForecast(db, ans({ p: null, evidence: "unmeasured" }), NOW);
  const rows = exportRows(db);
  db.close();
  assert.equal(r.written, true);
  assert.equal(rows[0].p, null);
  assert.equal(rows[0].evidence, "unmeasured");
});

test("an answer with no symbol is refused outright", () => {
  const db = logDb(dir, "nosym");
  assert.throws(() => recordForecast(db, { evidence: "measured", p: 0.1 }, NOW), RecordError);
  db.close();
});

test("settlement reads the tape and marks the outcome", () => {
  const db = logDb(dir, "settle");
  recordForecast(db, ans({ thresholdUsd: 1000 }), NOW);
  // The window closes; put 5,000 of liquidations inside it.
  const t = tape(dir, [[NEXT + 5, "SOLUSDT", 5000]]);
  const later = NEXT + WINDOW_MS + 120_000;
  const res = settleDue(db, t, later);
  const rows = exportRows(db);
  db.close(); t.close();
  assert.equal(res.settled, 1);
  assert.equal(rows[0].outcome, 1);
  assert.equal(rows[0].observed_usd, 5000);
});

test("a quiet window settles as a zero outcome, not as missing", () => {
  const db = logDb(dir, "quiet");
  recordForecast(db, ans({ symbol: "QUIETUSDT", thresholdUsd: 1000 }), NOW);
  const t = tape(dir, []);
  const res = settleDue(db, t, NEXT + WINDOW_MS + 120_000);
  const rows = exportRows(db);
  db.close(); t.close();
  assert.equal(res.settled, 1);
  assert.equal(rows[0].outcome, 0);
  assert.equal(rows[0].observed_usd, 0);
});

test("a window that has not closed yet is not settled", () => {
  const db = logDb(dir, "early");
  recordForecast(db, ans(), NOW);
  const t = tape(dir, []);
  const res = settleDue(db, t, NEXT + 1000);
  db.close(); t.close();
  assert.equal(res.due, 0);
  assert.equal(res.settled, 0);
});

test("an outcome can never be settled twice", () => {
  const db = logDb(dir, "resettle");
  recordForecast(db, ans({ thresholdUsd: 1000 }), NOW);
  const t1 = tape(dir, [[NEXT + 5, "SOLUSDT", 5000]]);
  const later = NEXT + WINDOW_MS + 120_000;
  assert.equal(settleDue(db, t1, later).settled, 1);
  const again = settleDue(db, t1, later);
  const rows = exportRows(db);
  db.close(); t1.close();
  assert.equal(again.due, 0, "a settled row must not come up as due again");
  assert.equal(rows[0].outcome, 1);
});

test("the tally is computed only from settled rows and reports what is pending", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-tal-"));
  const db = logDb(dir2, "tally");
  const t = tape(dir2, []);
  // Ten windows: half will exceed, half will not.
  for (let i = 0; i < 10; i++) {
    const at = NOW + i * WINDOW_MS;
    const start = Math.floor(at / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
    const ins = t.prepare("INSERT INTO liquidations (ts,symbol,side,size,price,usd) VALUES (?,?,?,?,?,?)");
    if (i % 2 === 0) ins.run(start + 1, "SOLUSDT", "Buy", 1, 1, 9000);
    recordForecast(db, ans({ p: i % 2 === 0 ? 0.8 : 0.1, thresholdUsd: 1000 }), at);
  }
  // Settle only the first nine; the last window has not closed.
  settleDue(db, t, NOW + 9 * WINDOW_MS + WINDOW_MS + 120_000);
  const r = tally(db);
  db.close(); t.close();
  rmSync(dir2, { recursive: true, force: true });
  assert.equal(r.settled, 9);
  assert.equal(r.pending, 1);
  assert.ok(r.skill > 0.5, `a nearly perfect record should show high skill, got ${r.skill}`);
  assert.equal(r.coverage, 1);
});

test("declines are charged climatology in the tally, exactly as in scoring", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "caliper-dec-"));
  const db = logDb(dir2, "decl");
  const t = tape(dir2, []);
  for (let i = 0; i < 8; i++) {
    const at = NOW + i * WINDOW_MS;
    recordForecast(db, ans({ p: null, evidence: "unmeasured", thresholdUsd: 1000 }), at);
  }
  settleDue(db, t, NOW + 8 * WINDOW_MS + WINDOW_MS + 120_000);
  const r = tally(db);
  db.close(); t.close();
  rmSync(dir2, { recursive: true, force: true });
  assert.equal(r.coverage, 0);
  assert.equal(r.declines, r.settled);
  assert.equal(r.skill, null, "with no variance in outcomes there is no skill to report, not zero");
});

test("an empty record says so instead of reporting a score", () => {
  const db = logDb(dir, "empty");
  const r = tally(db);
  db.close();
  assert.equal(r.settled, 0);
  assert.equal(r.skill, null);
  assert.match(r.reason, /nothing has settled/);
});

test("teardown", () => { rmSync(dir, { recursive: true, force: true }); });
