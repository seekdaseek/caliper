/**
 * caliper — detecting miners that contribute nothing.
 *
 * Properness handles honesty about your own belief. It does nothing about a
 * miner that has no belief and simply repeats someone else's. On a network
 * that routes by rank, copying is the cheapest attack there is: watch the
 * leader, echo it, collect a share of the demand.
 *
 * Being similar to a good miner is not itself evidence of copying, because two
 * miners looking at the same public data should agree. So similarity alone is
 * never the verdict. What separates them is whether removing the miner makes
 * the consensus worse. A copier can be deleted and nothing is lost. That is
 * the definition used here.
 */

import { isForecast, coverageAdjustedBrier, skillScore, baseRate } from "./scoring.mjs";

/**
 * Mean absolute difference between two miners over the questions they BOTH
 * answered, plus how many that was. A high agreement measured over three
 * questions means nothing, so the count travels with the number.
 */
export function agreement(a, b) {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!isForecast(a[i]) || !isForecast(b[i])) continue;
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  if (n === 0) return { overlap: 0, meanAbsDiff: null, similarity: null };
  const mad = sum / n;
  return { overlap: n, meanAbsDiff: mad, similarity: 1 - mad };
}

/**
 * The consensus forecast per question: the median of everyone who answered.
 * Median rather than mean because a single miner submitting 0 or 1 on every
 * question should not be able to drag the consensus around.
 */
export function consensus(forecastsByMiner, exclude = -1) {
  const nQ = Math.max(...forecastsByMiner.map((f) => f.length), 0);
  const out = [];
  for (let q = 0; q < nQ; q++) {
    const vals = [];
    for (let m = 0; m < forecastsByMiner.length; m++) {
      if (m === exclude) continue;
      const p = forecastsByMiner[m][q];
      if (isForecast(p)) vals.push(p);
    }
    if (vals.length === 0) {
      out.push(null);
      continue;
    }
    vals.sort((x, y) => x - y);
    const mid = vals.length >> 1;
    out.push(vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2);
  }
  return out;
}

/**
 * Decide which pairs of miners are duplicates of each other.
 *
 * An absolute similarity threshold does not work, and finding that out was the
 * whole point of testing this. How alike two HONEST miners look depends
 * entirely on how much signal the questions contain: in a world with a strong
 * public signal, every competent miner converges and a fixed cutoff calls them
 * all copies. A constant is also the easiest thing for an attacker to sit just
 * underneath.
 *
 * So similarity is judged relative to how similar miners on this question set
 * typically are. A pair is a duplicate only when it is a clear outlier against
 * that backdrop.
 *
 * With fewer than three miners there is no backdrop to measure against, and no
 * duplicate is declared. That is a refusal, not a pass.
 */
export function duplicatePairs(forecastsByMiner, opts = {}) {
  const { ratio = 0.3, minOverlap = 100 } = opts;
  const n = forecastsByMiner.length;
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = agreement(forecastsByMiner[i], forecastsByMiner[j]);
      if (a.meanAbsDiff === null || a.overlap < minOverlap) continue;
      pairs.push({ i, j, ...a });
    }
  }
  if (pairs.length < 3) {
    return { pairs, typicalDiff: null, cutoff: null, duplicates: [], reason: "too few comparable miners to calibrate what normal agreement looks like" };
  }
  const diffs = pairs.map((p) => p.meanAbsDiff).sort((x, y) => x - y);
  const typicalDiff = diffs[diffs.length >> 1];
  const cutoff = typicalDiff * ratio;
  const duplicates = pairs.filter((p) => p.meanAbsDiff < cutoff);
  return { pairs, typicalDiff, cutoff, duplicates, reason: null };
}

/**
 * Group miners that are duplicates of each other, so a cluster gets one vote.
 *
 * This closes a hole in the flat median: two miners submitting the same
 * numbers hold two votes, so a copier can IMPROVE the consensus by handing its
 * twin a majority. Measured that way, copying looks like a contribution.
 */
export function clusters(forecastsByMiner, opts = {}) {
  const { duplicates } = duplicatePairs(forecastsByMiner, opts);
  const parent = forecastsByMiner.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const d of duplicates) parent[find(d.i)] = find(d.j);
  const groups = new Map();
  for (let i = 0; i < forecastsByMiner.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()];
}

/**
 * Consensus with one vote per cluster: median inside each cluster, then median
 * across clusters. A miner that is merely a duplicate cannot move it.
 */
export function clusteredConsensus(forecastsByMiner, exclude = -1, opts = {}) {
  const groups = clusters(forecastsByMiner, opts);
  const nQ = Math.max(...forecastsByMiner.map((f) => f.length), 0);
  const out = [];
  for (let q = 0; q < nQ; q++) {
    const votes = [];
    for (const g of groups) {
      const vals = [];
      for (const m of g) {
        if (m === exclude) continue;
        const p = forecastsByMiner[m][q];
        if (isForecast(p)) vals.push(p);
      }
      if (vals.length === 0) continue;
      vals.sort((x, y) => x - y);
      const mid = vals.length >> 1;
      votes.push(vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2);
    }
    if (votes.length === 0) {
      out.push(null);
      continue;
    }
    votes.sort((x, y) => x - y);
    const mid = votes.length >> 1;
    out.push(votes.length % 2 ? votes[mid] : (votes[mid - 1] + votes[mid]) / 2);
  }
  return out;
}

/**
 * How much worse the consensus gets when this miner is removed.
 *
 * Positive means the miner improves the consensus and is carrying real
 * information. Around zero means the network would be unchanged without them.
 * Negative means they actively degrade it.
 */
export function contribution(index, forecastsByMiner, outcomes, opts = {}) {
  const withAll = coverageAdjustedBrier(clusteredConsensus(forecastsByMiner, -1, opts), outcomes);
  const without = coverageAdjustedBrier(clusteredConsensus(forecastsByMiner, index, opts), outcomes);
  if (withAll === null || without === null) return null;
  return without - withAll;
}

/**
 * The full picture for one miner. No single number decides it: a miner is only
 * flagged when it looks like someone else AND removing it costs nothing.
 * Either signal alone is not evidence.
 */
export function auditMiner(index, forecastsByMiner, outcomes, opts = {}) {
  const { contributionThreshold = 1e-4 } = opts;

  const mine = forecastsByMiner[index];
  const peers = [];
  for (let m = 0; m < forecastsByMiner.length; m++) {
    if (m === index) continue;
    const a = agreement(mine, forecastsByMiner[m]);
    if (a.similarity !== null) peers.push({ miner: m, ...a });
  }
  peers.sort((x, y) => y.similarity - x.similarity);
  const nearest = peers[0] ?? null;

  const dup = duplicatePairs(forecastsByMiner, opts);
  const looksCopied = dup.duplicates.some((d) => d.i === index || d.j === index);

  const contrib = contribution(index, forecastsByMiner, outcomes, opts);
  const addsNothing = contrib !== null && contrib <= contributionThreshold;
  const skill = skillScore(mine, outcomes);

  return {
    index,
    skill,
    contribution: contrib,
    nearestPeer: nearest,
    typicalPeerDiff: dup.typicalDiff,
    duplicateCutoff: dup.cutoff,
    flagged: looksCopied && addsNothing,
    reason: dup.reason
      ? dup.reason
      : !looksCopied
        ? "agreement with peers is within the normal range for this question set"
        : !addsNothing
          ? "duplicates a peer but still improves the consensus, so not a copy"
          : "mirrors a peer and removing it costs the consensus nothing",
  };
}

/**
 * Rank every miner. Skill decides the order; the audit decides who is eligible
 * to be ranked at all. A flagged miner keeps its score for inspection but is
 * marked, because silently dropping a miner is how a ranking becomes a rumour.
 */
export function rank(forecastsByMiner, outcomes, opts = {}) {
  const rows = forecastsByMiner.map((_, i) => auditMiner(i, forecastsByMiner, outcomes, opts));
  const eligible = rows.filter((r) => !r.flagged && r.skill !== null);
  eligible.sort((a, b) => b.skill - a.skill);
  eligible.forEach((r, i) => {
    r.rank = i + 1;
  });
  rows.filter((r) => r.flagged).forEach((r) => {
    r.rank = null;
  });
  return {
    baseRate: baseRate(outcomes),
    questions: outcomes.length,
    miners: rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)),
  };
}
