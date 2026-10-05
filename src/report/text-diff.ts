/**
 * Word-level text diff for description_changed findings (M2.4).
 *
 * Shared by the console reporter and the PR comment renderer so both show the same
 * diff. Pure and dependency-free.
 */

export interface DiffSegment {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/**
 * LCS is O(n·m) in time and memory. Descriptions come from an untrusted server, so
 * above this many tokens per side we return null and callers fall back to before/after.
 */
const MAX_TOKENS = 2000;

/** Splits into words and the whitespace between them, so joining segments restores the text. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Computes a word-level diff. Returns null when either side is too large to diff safely.
 * Adjacent segments of the same kind are merged.
 */
export function wordDiff(previous: string, current: string): DiffSegment[] | null {
  const a = tokenize(previous);
  const b = tokenize(current);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  // Flat (n+1)x(m+1) table: lcs[i*w + j] = LCS length of a[i:] and b[j:]
  const w = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment['kind'], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i] ?? '';
    const bj = b[j] ?? '';
    if (ai === bj) {
      push('same', ai);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push('removed', ai);
      i++;
    } else {
      push('added', bj);
      j++;
    }
  }
  for (; i < a.length; i++) push('removed', a[i] ?? '');
  for (; j < b.length; j++) push('added', b[j] ?? '');

  return segments;
}

/**
 * Marks invisible characters explicitly (e.g. `<U+200B>`). A rug-pull whose only change is
 * an injected zero-width or bidi character must be VISIBLE to the reviewer; printing the raw
 * bytes would hide it in every terminal and in GitHub's UI.
 */
export function markInvisibleCharacters(text: string): string {
  return text.replace(
    /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu,
    (ch) => `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`
  );
}
