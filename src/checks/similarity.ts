/**
 * Description similarity scorers for the collision lint (M4.1).
 *
 * The README promises no account, no API calls, no telemetry. So the default — and
 * currently only — scorer is LEXICAL: zero dependencies, zero network, deterministic.
 * Embedding-based scorers (local model / bring-your-own endpoint) can drop in behind
 * `SimilarityScorer` later, but only as an explicit opt-in.
 */

import { canonicalizeDescription } from '../surface/canonical.js';

export interface SimilarityScorer {
  /** Stable identifier, recorded in findings so results are reproducible. */
  readonly name: string;
  /** Similarity in [0, 1]; 1 means identical after normalization. */
  score(a: string, b: string): number;
}

/** Lowercase, canonicalize, drop punctuation, collapse whitespace. */
export function normalizeForSimilarity(text: string): string {
  return canonicalizeDescription(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function trigrams(text: string): Map<string, number> {
  const padded = `  ${text} `;
  const grams = new Map<string, number>();
  for (let i = 0; i + 3 <= padded.length; i++) {
    const g = padded.slice(i, i + 3);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/**
 * Sørensen–Dice coefficient over character trigram multisets.
 * Robust to small wording changes and word-order shuffles; weak on true paraphrase
 * (different words, same meaning) — the known tradeoff of staying offline.
 */
export const trigramDiceScorer: SimilarityScorer = {
  name: 'trigram-dice',
  score(a: string, b: string): number {
    const na = normalizeForSimilarity(a);
    const nb = normalizeForSimilarity(b);
    if (na.length === 0 || nb.length === 0) return 0;
    if (na === nb) return 1;

    const ga = trigrams(na);
    const gb = trigrams(nb);
    let overlap = 0;
    let total = 0;
    for (const [g, count] of ga) {
      overlap += Math.min(count, gb.get(g) ?? 0);
      total += count;
    }
    for (const count of gb.values()) total += count;
    return total === 0 ? 0 : (2 * overlap) / total;
  },
};
