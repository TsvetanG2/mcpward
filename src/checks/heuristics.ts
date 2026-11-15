/**
 * Tool-poisoning heuristics shared by the security checks and the drift classifier.
 *
 * Pure and dependency-free on purpose: `surface/diff.ts` uses them to escalate a suspicious
 * new input property, and importing `checks/security.ts` from there would drag the MCP client in.
 */

/**
 * Patterns that indicate injection attempts aimed at the model.
 * These are phrases commonly used in prompt injection attacks.
 */
export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?previous/i,
  /before\s+doing\s+(anything|everything)\s+else/i,
  /IMPORTANT:\s*ignore/i,
  /SYSTEM:\s*you\s+are/i,
  /you\s+are\s+now\s+in\s+admin\s+mode/i,
  /ignore\s+safety\s+guidelines/i,
  /execute\s+any\s+command/i,
  /send\s+(all\s+)?(conversation|chat)\s+history/i,
  /\bdo\s+not\s+follow\s+(your\s+)?instructions\b/i,
];

/**
 * Unicode code points that are suspicious in tool names/descriptions.
 * These can be used to hide malicious content or confuse users.
 */
export const SUSPICIOUS_UNICODE = {
  // Zero-width characters (invisible)
  zeroWidth: [
    0x200b, // Zero Width Space
    0x200c, // Zero Width Non-Joiner
    0x200d, // Zero Width Joiner
    0xfeff, // Zero Width No-Break Space (BOM)
    0x2060, // Word Joiner
    0x180e, // Mongolian Vowel Separator
  ],
  // Bidirectional override characters (can reverse/hide text)
  bidi: [
    0x202a, // Left-to-Right Embedding
    0x202b, // Right-to-Left Embedding
    0x202c, // Pop Directional Formatting
    0x202d, // Left-to-Right Override
    0x202e, // Right-to-Left Override
    0x2066, // Left-to-Right Isolate
    0x2067, // Right-to-Left Isolate
    0x2068, // First Strong Isolate
    0x2069, // Pop Directional Isolate
  ],
  // Homoglyph-prone characters (look like ASCII but aren't)
  confusables: [
    0x00a0, // Non-breaking space (looks like space)
    0x2000, // En Quad
    0x2001, // Em Quad
    0x2002, // En Space
    0x2003, // Em Space
    0x2004, // Three-Per-Em Space
    0x2005, // Four-Per-Em Space
    0x2006, // Six-Per-Em Space
    0x2007, // Figure Space
    0x2008, // Punctuation Space
    0x2009, // Thin Space
    0x200a, // Hair Space
  ],
};

/**
 * Field names that indicate secret/credential solicitation.
 * Tools asking for these without clear justification are suspicious.
 */
export const SECRET_FIELD_PATTERNS = [
  /^api[_-]?key$/i,
  /^password$/i,
  /^passwd$/i,
  /^secret$/i,
  /^access[_-]?token$/i,
  /^auth[_-]?token$/i,
  /^bearer[_-]?token$/i,
  /^private[_-]?key$/i,
  /^ssh[_-]?key$/i,
  /^credentials?$/i,
  /^token$/i,
];

/**
 * Checks a string for injection-like patterns.
 */
export function findInjectionPatterns(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      const match = text.match(pattern);
      if (match) {
        matches.push(match[0]);
      }
    }
  }
  return matches;
}

/** Unicode Tags block. Invisible; maps 1:1 onto ASCII, so it can smuggle text past a human reviewer. */
export const TAG_START = 0xe0000;
const TAG_END = 0xe007f;
const TAG_CANCEL = 0xe007f;
/** U+1F3F4 WAVING BLACK FLAG — base of legitimate emoji tag sequences (e.g. the Scotland flag). */
const BLACK_FLAG = 0x1f3f4;

const isTag = (cp: number) => cp >= TAG_START && cp <= TAG_END;

/**
 * A subdivision flag's tag spec is an ISO 3166-2 code: a 2-letter region plus 1–3 lowercase
 * letters/digits (e.g. "gbsct"). Anything else between U+1F3F4 and U+E007F is not a flag —
 * wrapping a smuggled instruction in a "flag" must not exempt it.
 */
const SUBDIVISION_TAG_SPEC = /^[a-z]{2}[a-z0-9]{1,3}$/;

/**
 * Finds suspicious unicode characters in a string.
 *
 * Tag characters (U+E0000–E007F) are flagged as `tag-character` ("ASCII smuggling"),
 * EXCEPT inside a valid subdivision flag: U+1F3F4, an ISO 3166-2 tag spec, U+E007F.
 * Flagging real flags would be a false positive.
 */
export function findSuspiciousUnicode(
  text: string
): { char: string; codePoint: number; type: string }[] {
  const suspicious: { char: string; codePoint: number; type: string }[] = [];
  const chars = Array.from(text);
  const cps = chars.map((c) => c.codePointAt(0) ?? 0);

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? '';
    const codePoint = cps[i] ?? 0;

    if (codePoint === BLACK_FLAG) {
      // Skip a valid subdivision flag; anything else falls through and its tags are flagged.
      let j = i + 1;
      while (j < cps.length && isTag(cps[j] ?? 0) && cps[j] !== TAG_CANCEL) j++;
      const spec = String.fromCharCode(...cps.slice(i + 1, j).map((cp) => cp - TAG_START));
      if (cps[j] === TAG_CANCEL && SUBDIVISION_TAG_SPEC.test(spec)) {
        i = j;
      }
      continue;
    }

    if (isTag(codePoint)) {
      suspicious.push({ char, codePoint, type: 'tag-character' });
    } else if (SUSPICIOUS_UNICODE.zeroWidth.includes(codePoint)) {
      suspicious.push({ char, codePoint, type: 'zero-width' });
    } else if (SUSPICIOUS_UNICODE.bidi.includes(codePoint)) {
      suspicious.push({ char, codePoint, type: 'bidirectional-override' });
    } else if (SUSPICIOUS_UNICODE.confusables.includes(codePoint)) {
      suspicious.push({ char, codePoint, type: 'confusable-space' });
    }
  }

  return suspicious;
}

/** Nesting limit for walking untrusted input schemas. */
const MAX_PARAM_DEPTH = 32;

/** One schema node reached by {@link walkParams}. */
export interface ParamNode {
  /** `filter.status`, `rows[]`, `meta{}` — the same path style as the drift diff. */
  path: string;
  /** The `properties` key that led here; undefined for array items and additionalProperties. */
  name: string | undefined;
  schema: Record<string, unknown>;
}

/**
 * Visits every parameter in an input schema, at any depth: nested `properties`, array
 * `items`, `additionalProperties`, and anyOf/oneOf/allOf branches (which keep their parent's
 * path). The root itself is not a parameter and is not visited. Depth-limited and cycle-safe.
 */
export function walkParams(schema: unknown): ParamNode[] {
  const found: ParamNode[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string, name: string | undefined, depth: number): void => {
    if (
      depth > MAX_PARAM_DEPTH ||
      node === null ||
      typeof node !== 'object' ||
      Array.isArray(node)
    ) {
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    const s = node as Record<string, unknown>;

    if (path !== '') found.push({ path, name, schema: s });
    const props = s.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
        walk(child, path === '' ? key : `${path}.${key}`, key, depth + 1);
      }
    }
    const items = Array.isArray(s.items) ? s.items : [s.items];
    for (const item of items) walk(item, `${path}[]`, undefined, depth + 1);
    walk(s.additionalProperties, `${path}{}`, undefined, depth + 1);
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = s[key];
      if (Array.isArray(branches)) for (const b of branches) walk(b, path, name, depth + 1);
    }
  };

  walk(schema, '', undefined, 0);
  return found;
}

/**
 * Collects every parameter description in an input schema, at any depth.
 * Paths read like `filter.status` or `rows[].note`.
 */
export function collectParamDescriptions(schema: unknown): { path: string; description: string }[] {
  return walkParams(schema).flatMap(({ path, schema: s }) =>
    typeof s.description === 'string' && s.description !== ''
      ? [{ path, description: s.description }]
      : []
  );
}

/**
 * Checks if a schema property name looks like it's soliciting secrets.
 */
export function isSecretField(fieldName: string): boolean {
  return SECRET_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Paths of every parameter, at any depth, whose name solicits a secret (`api_key`,
 * `options.password`, `accounts[].token`). Each path once, in walk order.
 */
export function collectSecretFields(schema: unknown): string[] {
  const paths = walkParams(schema)
    .filter(({ name }) => name !== undefined && isSecretField(name))
    .map(({ path }) => path);
  return [...new Set(paths)];
}
