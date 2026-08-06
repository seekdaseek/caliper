/**
 * caliper miner — turning a liquidation tape into a question and a state.
 *
 * The question, fixed and public:
 *
 *   Will {symbol} see more liquidation volume in the NEXT window than its own
 *   90th-percentile window over the reference period?
 *
 * Three properties make it worth asking. It normalises itself across 799
 * symbols of wildly different size, so one threshold is not wrong for
 * everything. Its base rate is roughly 10% by construction, which is the
 * rare-event regime where naive accuracy metrics fall apart. And anyone
 * subscribed to the same public feed can settle it without trusting the miner.
 */

export const WINDOW_MS = 15 * 60 * 1000;

/**
 * Bucket a tape into fixed windows per symbol.
 * Events are (ts, symbol, side, usd). Returns windows in time order.
 */
export function toWindows(events, windowMs = WINDOW_MS) {
  const bySymbol = new Map();
  for (const e of events) {
    const bucket = Math.floor(e.ts / windowMs) * windowMs;
    if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, new Map());
    const m = bySymbol.get(e.symbol);
    if (!m.has(bucket)) m.set(bucket, { symbol: e.symbol, start: bucket, usd: 0, count: 0, buyUsd: 0, sellUsd: 0 });
    const w = m.get(bucket);
    w.usd += e.usd;
    w.count += 1;
    if (e.side === "Buy") w.buyUsd += e.usd;
    else w.sellUsd += e.usd;
  }
  const out = new Map();
  for (const [symbol, m] of bySymbol) {
    out.set(symbol, [...m.values()].sort((a, b) => a.start - b.start));
  }
  return out;
}

/**
 * Fill the gaps. A window with no liquidations is not missing data, it is a
 * quiet market, and dropping it would silently inflate every base rate. This
 * is the difference between absent and unmeasured, applied to time.
 */
export function densify(windows, windowMs = WINDOW_MS, from = null, to = null) {
  if (windows.length === 0) return [];
  const symbol = windows[0].symbol;
  const start = from ?? windows[0].start;
  const end = to ?? windows[windows.length - 1].start;
  const byStart = new Map(windows.map((w) => [w.start, w]));
  const out = [];
  for (let t = start; t <= end; t += windowMs) {
    out.push(byStart.get(t) ?? { symbol, start: t, usd: 0, count: 0, buyUsd: 0, sellUsd: 0 });
  }
  return out;
}

/** The value at a given quantile of a numeric array. Linear interpolation. */
export function quantile(values, q) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * The threshold a symbol's next window has to beat. Derived only from the
 * reference period, never from the window being predicted.
 */
export function thresholdFor(windows, q = 0.9) {
  return quantile(windows.map((w) => w.usd), q);
}

/**
 * Discrete state of a symbol at the end of a window, used as a lookup key.
 *
 * Everything here is bucketed on purpose. A lookup table over coarse states
 * has an honest support count behind every cell, which is what lets the model
 * decline instead of extrapolating into a region it has never seen.
 */
export const LEVELS = {
  // The original scale. Its top bucket is unbounded, which is what the live
  // reliability curve exposed.
  coarse: (r) => (r === 0 ? 0 : r < 0.1 ? 1 : r < 0.5 ? 2 : r < 1 ? 3 : 4),
  // Splits the top three ways. Kept switchable so both can be run against the
  // same slice: comparing a change measured on one window against a number
  // measured on another window compares nothing.
  fine: (r) => (r === 0 ? 0 : r < 0.1 ? 1 : r < 0.5 ? 2 : r < 1 ? 3 : r < 2 ? 4 : r < 5 ? 5 : 6),
};

export function stateOf(recent, threshold, scheme = "fine") {
  const last = recent[recent.length - 1];
  if (!last || threshold === null || threshold <= 0) return null;

  // How loud is right now, relative to the symbol's own busy threshold.
  //
  // The top bucket used to be an unbounded "at or above threshold", which
  // lumped a window that just cleared the bar together with one ten times over
  // it. The backtest's reliability curve exposed that directly: the model read
  // 0.655 where the truth was 0.836, because the strongest states were being
  // averaged down by merely elevated ones. Splitting the top into three costs
  // support per cell, which is why the minimum-support refusal exists.
  const ratio = last.usd / threshold;
  const level = LEVELS[scheme] ? LEVELS[scheme](ratio) : LEVELS.fine(ratio);

  // Which side is being taken out. Imbalance leads cascades more than volume.
  const total = last.buyUsd + last.sellUsd;
  const skew = total === 0 ? 0.5 : last.buyUsd / total;
  const side = total === 0 ? 0 : skew < 0.25 ? 1 : skew < 0.75 ? 2 : 3;

  // Is this an isolated print or a burst.
  const burst = last.count === 0 ? 0 : last.count < 3 ? 1 : last.count < 10 ? 2 : 3;

  // Was the previous window already elevated. One step of memory, no more,
  // because every extra dimension divides the support behind each cell.
  const prev = recent[recent.length - 2];
  const prevHot = prev && prev.usd >= threshold ? 1 : 0;

  return `${level}|${side}|${burst}|${prevHot}`;
}

/**
 * Walk a symbol's windows and emit (state, outcome) pairs, where the outcome
 * is whether the FOLLOWING window beat the threshold. The final window has no
 * following window and is dropped rather than assumed.
 */
export function labelledPairs(windows, threshold, scheme = "fine") {
  const pairs = [];
  for (let i = 1; i < windows.length - 1; i++) {
    const state = stateOf(windows.slice(i - 1, i + 1), threshold, scheme);
    if (state === null) continue;
    pairs.push({
      symbol: windows[i].symbol,
      at: windows[i].start,
      state,
      outcome: windows[i + 1].usd > threshold ? 1 : 0,
    });
  }
  return pairs;
}
