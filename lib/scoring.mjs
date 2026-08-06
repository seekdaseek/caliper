/**
 * caliper — scoring rules for ranking miners.
 *
 * The whole design rests on one property. A scoring rule is PROPER when a
 * forecaster maximises their expected score only by reporting what they
 * actually believe. Brier and log score are proper. Accuracy and hit rate are
 * not, which is why a script built on accuracy can be farmed by anyone who
 * understands it better than its author.
 *
 * Everything else here exists to close a specific hole that properness alone
 * does not close:
 *
 *   base-rate camping  -> skill against a climatological reference, and the
 *                         resolution term of the Murphy decomposition, which
 *                         is exactly zero for a constant forecaster
 *   cherry-picking     -> declining is charged the reference score, so
 *                         answering only easy questions earns nothing
 *   copying            -> measured separately in gaming.mjs
 *   overconfidence     -> punished by properness, made visible by reliability
 */

/** Forecasts are probabilities in [0,1]. A decline is null, never 0.5. */
export const DECLINED = null;

const clamp01 = (p) => (p < 0 ? 0 : p > 1 ? 1 : p);

export function isForecast(p) {
  return typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;
}

/**
 * Brier score for one forecast. Lower is better, range 0..1.
 * Squared error between a probability and a binary outcome.
 */
export function brier(p, outcome) {
  if (!isForecast(p)) throw new TypeError(`not a forecast: ${p}`);
  if (outcome !== 0 && outcome !== 1) throw new TypeError(`outcome must be 0 or 1, got ${outcome}`);
  const d = p - outcome;
  return d * d;
}

/**
 * Logarithmic score. Also proper, and far harsher on confident mistakes.
 * Clipped, because an unclipped log score lets a single wrong certainty
 * produce infinity and destroy a whole ranking.
 */
export function logScore(p, outcome, eps = 1e-6) {
  if (!isForecast(p)) throw new TypeError(`not a forecast: ${p}`);
  const q = Math.min(1 - eps, Math.max(eps, p));
  return -(outcome === 1 ? Math.log(q) : Math.log(1 - q));
}

/** Mean Brier over answered questions only. Says nothing about coverage. */
export function meanBrier(forecasts, outcomes) {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < forecasts.length; i++) {
    if (!isForecast(forecasts[i])) continue;
    sum += brier(forecasts[i], outcomes[i]);
    n++;
  }
  return n === 0 ? null : sum / n;
}

/** The base rate of the outcomes. This is what a climatological forecaster knows. */
export function baseRate(outcomes) {
  if (outcomes.length === 0) return null;
  return outcomes.reduce((s, o) => s + o, 0) / outcomes.length;
}

/**
 * Reference score: what you get for free by predicting the base rate every
 * time. Any miner that cannot beat this has contributed nothing.
 */
export function referenceBrier(outcomes) {
  const c = baseRate(outcomes);
  if (c === null) return null;
  return outcomes.reduce((s, o) => s + (c - o) ** 2, 0) / outcomes.length;
}

/**
 * Coverage-adjusted Brier.
 *
 * A declined question is charged the reference score for that question rather
 * than skipped. Declining therefore buys exactly climatological performance:
 * no penalty for honesty, and no advantage from answering only the easy ones.
 * That single choice removes cherry-picking as a strategy.
 */
export function coverageAdjustedBrier(forecasts, outcomes) {
  const c = baseRate(outcomes);
  if (c === null) return null;
  let sum = 0;
  for (let i = 0; i < outcomes.length; i++) {
    sum += isForecast(forecasts[i]) ? brier(forecasts[i], outcomes[i]) : (c - outcomes[i]) ** 2;
  }
  return sum / outcomes.length;
}

/**
 * Brier Skill Score against climatology, over every question asked.
 * 1 is perfect, 0 is no better than knowing the base rate, negative is worse.
 */
export function skillScore(forecasts, outcomes) {
  const ref = referenceBrier(outcomes);
  if (ref === null) return null;
  if (ref === 0) return null; // every outcome identical; no skill is measurable
  const bs = coverageAdjustedBrier(forecasts, outcomes);
  return 1 - bs / ref;
}

/** What fraction of questions the miner was willing to answer. */
export function coverage(forecasts) {
  if (forecasts.length === 0) return 0;
  return forecasts.filter(isForecast).length / forecasts.length;
}

/**
 * Murphy decomposition: BS = reliability - resolution + uncertainty.
 *
 * reliability  calibration error. 0 means that when you say 30% it happens 30%
 *              of the time. Lower is better.
 * resolution   how far your forecasts move away from the base rate in the
 *              right direction. Higher is better. A constant forecaster has
 *              resolution exactly 0, which is the mathematical statement of
 *              why base-rate camping is not skill.
 * uncertainty  a property of the questions, not the forecaster.
 */
export function murphy(forecasts, outcomes, bins = 10) {
  const pairs = [];
  for (let i = 0; i < forecasts.length; i++) {
    if (isForecast(forecasts[i])) pairs.push([clamp01(forecasts[i]), outcomes[i]]);
  }
  const n = pairs.length;
  if (n === 0) return null;
  const cbar = pairs.reduce((s, [, o]) => s + o, 0) / n;

  const buckets = new Map();
  for (const [p, o] of pairs) {
    const k = Math.min(bins - 1, Math.floor(p * bins));
    if (!buckets.has(k)) buckets.set(k, { n: 0, sumP: 0, sumO: 0 });
    const b = buckets.get(k);
    b.n++;
    b.sumP += p;
    b.sumO += o;
  }

  let reliability = 0;
  let resolution = 0;
  const curve = [];
  for (const [k, b] of [...buckets.entries()].sort((a, z) => a[0] - z[0])) {
    const pk = b.sumP / b.n;
    const ok = b.sumO / b.n;
    reliability += (b.n * (pk - ok) ** 2) / n;
    resolution += (b.n * (ok - cbar) ** 2) / n;
    curve.push({ bin: k, n: b.n, meanForecast: pk, observedRate: ok });
  }
  const uncertainty = cbar * (1 - cbar);

  // The identity BS = reliability - resolution + uncertainty is exact only for
  // DISCRETE forecasts, where every distinct probability is its own bin. With
  // continuous forecasts, binning throws away the spread inside each bin and
  // the identity no longer closes. Rather than hide that, the gap is reported.
  // A large residual means the binning is too coarse for these forecasts.
  const bs = pairs.reduce((acc, [p, o]) => acc + (p - o) ** 2, 0) / n;
  const residual = bs - (reliability - resolution + uncertainty);

  return { reliability, resolution, uncertainty, residual, brierScore: bs, baseRate: cbar, n, curve };
}

/**
 * Sharpness: how far forecasts sit from the base rate, regardless of whether
 * they are right. High sharpness with high reliability is real skill. High
 * sharpness with poor reliability is bluffing, and the pair separates them.
 */
export function sharpness(forecasts, outcomes) {
  const c = baseRate(outcomes);
  const used = forecasts.filter(isForecast);
  if (used.length === 0 || c === null) return null;
  return used.reduce((s, p) => s + Math.abs(p - c), 0) / used.length;
}

/**
 * Paired bootstrap over per-observation scores.
 *
 * Two models scored on the SAME questions produce paired differences, and the
 * pairing is what makes a small effect measurable: most of the variance is the
 * questions themselves, and pairing cancels it. Resampling the differences
 * gives a confidence interval without assuming anything about their shape.
 *
 * Deterministic by seed, because a significance claim that changes between
 * runs is not a significance claim.
 */
export function pairedBootstrap(diffs, { samples = 2000, seed = 12345, alpha = 0.05 } = {}) {
  const n = diffs.length;
  if (n === 0) return null;
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const observed = mean(diffs);

  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };

  const means = new Float64Array(samples);
  for (let b = 0; b < samples; b++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += diffs[(rnd() * n) | 0];
    means[b] = acc / n;
  }
  const sorted = Array.from(means).sort((a, b) => a - b);
  const lo = sorted[Math.floor((alpha / 2) * samples)];
  const hi = sorted[Math.min(samples - 1, Math.floor((1 - alpha / 2) * samples))];
  const crossesZero = lo <= 0 && hi >= 0;
  return { n, observed, lo, hi, samples, crossesZero };
}

/** Per-observation Brier, with declines charged the reference score. */
export function perObservationBrier(forecasts, outcomes) {
  const c = baseRate(outcomes);
  if (c === null) return [];
  return outcomes.map((o, i) =>
    isForecast(forecasts[i]) ? brier(forecasts[i], o) : (c - o) ** 2
  );
}
