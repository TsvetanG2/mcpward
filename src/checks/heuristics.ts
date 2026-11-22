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

/**
 * A location as a linked list from the leaf up. Children share their parent's steps, so a deep
 * schema costs one step per node (copying arrays made a 100 000-level schema quadratic).
 */
export interface Steps {
  readonly up: Steps | undefined;
  readonly step: string;
}

/** The steps from the outermost to `steps` itself; `[]` for undefined. */
export function stepsOf(steps: Steps | undefined): string[] {
  const out: string[] = [];
  for (let n = steps; n !== undefined; n = n.up) out.push(n.step);
  return out.reverse();
}

/** One schema node reached by {@link walkParams}. */
export interface ParamNode {
  /** `filter.status`, `rows[]`, `meta{}` — the same path style as the drift diff. */
  path: string;
  /**
   * The same place with every keyword spelled out, one step each (see {@link stepsOf}):
   * `properties/rows` → `items`, `properties/opts` → `patternProperties/^x`,
   * `properties/a` → `anyOf/0`. Property names carry `properties/`, so a property named
   * `items` is never the keyword `items`. A `$ref` target keeps the referring location.
   */
  location: Steps | undefined;
  /** The `properties` key that led here; undefined for array items and additionalProperties. */
  name: string | undefined;
  /** The node's schema; undefined for a boolean schema (`password: true` is still a field). */
  schema: Record<string, unknown> | undefined;
}

/** A pending step of {@link walkParams}. */
interface Visit {
  node: unknown;
  path: string;
  location: Steps | undefined;
  name: string | undefined;
  isRoot: boolean;
  /** Property paths below it start without a dot: the root, or a `from` start with path `""`. */
  bare: boolean;
  /** Document a `#…` reference resolves against: the nearest enclosing `$id`, else refRoot. */
  base: unknown;
}

/**
 * Visits every parameter in an input schema, at any depth: nested `properties`, array
 * `items`/`prefixItems`/`additionalItems`/`contains`, `additionalProperties`/
 * `patternProperties`, and the in-place applicators (anyOf/oneOf/allOf, not, if/then/else,
 * dependentSchemas, draft-07 `dependencies`), which keep their parent's path. A name listed in
 * `required` but never declared is reported too. The root itself is not a parameter and is
 * not visited; a property named `""` is. A local `$ref` (`#/$defs/Auth`, or an anchor like
 * `#Auth`) is followed into `refRoot` — the document the schema came from, which defaults to the
 * schema itself — and its target keeps the referring path. Inside a subschema with its own
 * (non-fragment) `$id`, references resolve against that subschema — also when a pointer only
 * passes through it on the way to the target.
 *
 * Every named property is reported, even a boolean schema or an object already seen under
 * another name — the NAME is what solicits a secret. Each object is descended into once, so the
 * walk is linear in the size of the document and cycle-safe. It is iterative, with no depth
 * limit: a limit would silently drop whatever lies past it, and a server could hide a field
 * behind a long `$ref` chain.
 *
 * With `from`, the walk starts at a node that IS reported, with that path and location: a
 * definition below a field, or a schema root whose own text matters. With `expanded`, several
 * walks share one record of the nodes they descended into: a node another walk already expanded
 * is reported but not descended again.
 */
export function walkParams(
  schema: unknown,
  refRoot: unknown = schema,
  from?: { path: string; location: Steps | undefined },
  expanded: WeakSet<object> = new WeakSet<object>()
): ParamNode[] {
  const found: ParamNode[] = [];
  const seen = expanded;
  const stack: Visit[] = [
    from
      ? {
          node: schema,
          path: from.path,
          location: from.location,
          name: undefined,
          isRoot: false,
          bare: from.path === '',
          base: refRoot,
        }
      : {
          node: schema,
          path: '',
          location: undefined,
          name: undefined,
          isRoot: true,
          bare: true,
          base: refRoot,
        },
  ];

  while (stack.length > 0) {
    const { node, path, location, name, isRoot, bare, base: outerBase } = stack.pop() as Visit;
    if (node === undefined) continue;
    const s =
      node !== null && typeof node === 'object' && !Array.isArray(node)
        ? (node as Record<string, unknown>)
        : undefined;
    if (!isRoot && (s !== undefined || name !== undefined))
      found.push({ path, location, name, schema: s });
    if (s === undefined || seen.has(s)) continue;
    seen.add(s);
    // A subschema with its own `$id` is a separate schema resource: fragments inside it are
    // relative to it, not to the document
    const base = isSchemaResource(s) ? s : outerBase;

    const children: Visit[] = [];
    const at = (step: string): Steps => ({ up: location, step });
    const add = (child: unknown, childPath: string, childLocation: Steps, childName?: string) =>
      children.push({
        node: child,
        path: childPath,
        location: childLocation,
        name: childName,
        isRoot: false,
        bare: false,
        base,
      });
    // In-place applicators describe this same value: same path, name and root-ness
    const same = (child: unknown, keyword: string) =>
      children.push({ node: child, path, location: at(keyword), name, isRoot, bare, base });
    const entries = (v: unknown): [string, unknown][] =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : [];
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    const values = (v: unknown): unknown[] =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v) : [];

    const props = s.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
        add(child, bare ? key : `${path}.${key}`, at(`properties/${key}`), key);
      }
    }
    // `required`, `dependentRequired` and array-valued draft-07 `dependencies` may name a
    // property that `properties` never declares — it is still requested
    const requested = [
      ...list(s.required),
      ...values(s.dependentRequired).flatMap(list),
      ...values(s.dependencies).flatMap(list),
    ];
    for (const key of new Set(requested)) {
      if (typeof key !== 'string') continue;
      if (props && typeof props === 'object' && Object.hasOwn(props, key)) continue;
      add(true, bare ? key : `${path}.${key}`, at(`properties/${key}`), key);
    }
    if (Array.isArray(s.items))
      s.items.forEach((item, i) => add(item, `${path}[]`, at(`items/${i}`)));
    else add(s.items, `${path}[]`, at('items'));
    list(s.prefixItems).forEach((item, i) => add(item, `${path}[]`, at(`prefixItems/${i}`)));
    for (const key of ['additionalItems', 'contains', 'unevaluatedItems'] as const) {
      add(s[key], `${path}[]`, at(key));
    }
    add(s.additionalProperties, `${path}{}`, at('additionalProperties'));
    for (const [pattern, child] of entries(s.patternProperties)) {
      add(child, `${path}{}`, at(`patternProperties/${pattern}`));
    }
    add(s.unevaluatedProperties, `${path}{}`, at('unevaluatedProperties'));
    add(s.propertyNames, `${path}{}`, at('propertyNames'));
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      list(s[key]).forEach((b, i) => same(b, `${key}/${i}`));
    }
    for (const key of ['not', 'if', 'then', 'else'] as const) same(s[key], key);
    for (const [key, child] of entries(s.dependentSchemas)) same(child, `dependentSchemas/${key}`);
    // draft-07 `dependencies`: a schema value applies in place (an array value lists names)
    for (const [key, child] of entries(s.dependencies)) {
      if (!Array.isArray(child)) same(child, `dependencies/${key}`);
    }
    // `$dynamicRef`/`$recursiveRef` resolve like `$ref` within one document (no dynamic scope
    // across documents to follow — remote references are never fetched)
    for (const key of ['$ref', '$dynamicRef', '$recursiveRef'] as const) {
      const target = typeof s[key] === 'string' ? resolveLocalRefIn(base, s[key]) : undefined;
      // The target keeps this path but resolves its own references in its resource
      if (target) {
        children.push({ node: target.node, path, location, name, isRoot, bare, base: target.base });
      }
    }

    // Reverse so the stack pops them in document order (pre-order, like a recursive walk)
    for (let k = children.length - 1; k >= 0; k--) stack.push(children[k] as Visit);
  }
  return found;
}

/**
 * True for a schema that starts its own resource: its `$id` is a URI, not a draft-07
 * fragment-only anchor such as `"#auth"` (which names a place in the enclosing resource).
 */
export function isSchemaResource(schema: Record<string, unknown>): boolean {
  return typeof schema.$id === 'string' && !schema.$id.startsWith('#');
}

/** Keywords whose values are instance data, never subschemas. */
const DATA_KEYWORDS = new Set(['const', 'default', 'enum', 'examples']);

/** Keywords whose values map names to subschemas. */
const MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
]);

/** Anchors of each resource, built once per resource. */
const anchorCache = new WeakMap<object, Map<string, unknown>>();

/**
 * The plain-name anchors in a schema resource: `$anchor`/`$dynamicAnchor` (2019-09+) and the draft-07
 * `$id: "#Auth"`. Nested resources keep their own anchors and are not entered.
 */
function anchorsOf(root: object): Map<string, unknown> {
  const cached = anchorCache.get(root);
  if (cached) return cached;
  const anchors = new Map<string, unknown>();
  const seen = new WeakSet<object>();
  // `map`: the node is a name → subschema map (`$defs`, `properties`, …), not a schema
  const stack: { node: unknown; map: boolean }[] = [{ node: root, map: false }];
  while (stack.length > 0) {
    const { node, map } = stack.pop() as { node: unknown; map: boolean };
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, map: false });
    } else if (map) {
      for (const child of Object.values(node)) stack.push({ node: child, map: false });
    } else {
      const s = node as Record<string, unknown>;
      if (node !== root && isSchemaResource(s)) continue;
      // `$anchor` and `$dynamicAnchor` (2019-09+) and a draft-07 `$id: "#Name"` all name it
      const names = [
        s.$anchor,
        s.$dynamicAnchor,
        typeof s.$id === 'string' && s.$id.startsWith('#') ? s.$id.slice(1) : undefined,
      ];
      for (const name of names) {
        if (typeof name === 'string' && !anchors.has(name)) anchors.set(name, s);
      }
      // Instance data is not schema: an `$id` inside a default or an enum value is no anchor.
      // Only a schema's own keywords are data — a definition may be NAMED `default`.
      for (const [key, child] of Object.entries(s)) {
        if (!DATA_KEYWORDS.has(key)) stack.push({ node: child, map: MAP_KEYWORDS.has(key) });
      }
    }
  }
  anchorCache.set(root, anchors);
  return anchors;
}

/**
 * Resolves a same-document reference — `#`, a JSON Pointer (`#/$defs/Auth`,
 * `#/definitions/a~1b`) or a plain-name anchor (`#Auth`). Remote references are never fetched:
 * the server under test is untrusted.
 */
export function resolveLocalRef(root: unknown, ref: string): unknown {
  return resolveLocalRefIn(root, ref)?.node;
}

/**
 * Like {@link resolveLocalRef}, and also returns the schema resource the target belongs to: the
 * last subschema with its own `$id` the pointer passed through (or the target itself), else
 * `root`. References inside the target resolve against it.
 */
export function resolveLocalRefIn(
  root: unknown,
  ref: string
): { node: unknown; base: unknown } | undefined {
  if (!ref.startsWith('#')) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (pointer === '') return { node: root, base: root };
  if (!pointer.startsWith('/')) {
    // Anchors are indexed per resource and never inside a nested one
    const node =
      root !== null && typeof root === 'object' ? anchorsOf(root).get(pointer) : undefined;
    return node === undefined ? undefined : { node, base: root };
  }
  let node: unknown = root;
  let base: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      if (isSchemaResource(node as Record<string, unknown>)) base = node;
    }
  }
  return { node, base };
}

/**
 * Collects every parameter description in an input schema, at any depth.
 * Paths read like `filter.status` or `rows[].note`.
 */
export function collectParamDescriptions(
  schema: unknown,
  refRoot: unknown = schema
): { path: string; description: string }[] {
  return walkParams(schema, refRoot).flatMap(({ path, schema: s }) =>
    typeof s?.description === 'string' && s.description !== ''
      ? [{ path, description: s.description }]
      : []
  );
}

/** Keywords whose values map names to definitions, read for text whether referenced or not. */
const DEFINITION_KEYWORDS = ['$defs', 'definitions'] as const;

/**
 * Every node of `params` plus the nodes inside `$defs`/`definitions` declared anywhere in
 * them, referenced or not: their text reaches the model with the schema all the same. Used for
 * text only — a definition is not a field, so its name is not checked as a secret.
 */
export function withDefinitions(params: ParamNode[], refRoot: unknown): ParamNode[] {
  const out = [...params];
  const seen = new WeakSet<object>();
  // Each node is descended into once across all the walks below, and not at all when `params`
  // already reached it: a chain of N definitions referencing each other would otherwise be
  // walked again from every definition in it (N²/2 nodes — a few thousand stall a scan)
  const expanded = new WeakSet<object>();
  for (const p of params) if (p.schema) expanded.add(p.schema);
  // for-of over `out` also visits the nodes pushed below: definitions inside definitions
  for (const { path, location, schema: node } of out) {
    if (!node) continue;
    for (const key of DEFINITION_KEYWORDS) {
      const defs = node[key];
      if (defs === null || typeof defs !== 'object' || Array.isArray(defs)) continue;
      for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
        if (def === null || typeof def !== 'object' || seen.has(def)) continue;
        seen.add(def);
        const step = `${key}/${name}`;
        const at = path === '' ? step : `${path}.${step}`;
        // The walk reports the definition itself and everything below it
        const from = { path: at, location: { up: location, step } };
        for (const p of walkParams(def, refRoot, from, expanded)) {
          out.push({ ...p, name: undefined });
        }
      }
    }
  }
  return out;
}

/** Keywords whose values are text the model reads (the drift diff's text keywords). */
const isModelTextKeyword = (k: string) =>
  k === 'description' ||
  k === 'title' ||
  k === '$comment' ||
  k === 'default' ||
  k === 'examples' ||
  k === 'example' ||
  k === 'enumDescriptions' ||
  k.startsWith('x-');

/** One piece of text the model reads: where it is, under which keyword, and the text. */
export interface ModelText {
  path: string;
  /**
   * The place with its keywords spelled out (see `ParamNode.location`), shared with the node:
   * materialize it with {@link stepsOf} only for a text that is reported — an array per text
   * makes a deep schema quadratic in memory.
   */
  location: Steps | undefined;
  keyword: string;
  text: string;
}

/**
 * Text the model reads on each parameter: every string inside `description`, `title`,
 * `$comment`, `default`, `examples`, `example`, `enumDescriptions` and `x-*` values, object
 * keys included — a value that is not a string (`title: {…}`) is walked as data.
 */
export function collectModelText(params: ParamNode[]): ModelText[] {
  const out: ModelText[] = [];
  for (const { path, location, schema } of params) {
    if (!schema) continue;
    // description first: it is what the reasons quote most often
    const keywords = Object.keys(schema)
      .filter(isModelTextKeyword)
      .sort((a, b) => Number(b === 'description') - Number(a === 'description'));
    for (const keyword of keywords) {
      const stack: unknown[] = [schema[keyword]];
      while (stack.length > 0) {
        const v = stack.pop();
        if (typeof v === 'string') {
          if (v !== '') out.push({ path, location, keyword, text: v });
        }
        // No spread: an argument list overflows on a large array (RangeError)
        else if (Array.isArray(v)) for (const x of v) stack.push(x);
        // A key is read by the model as much as a value is
        else if (v !== null && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) stack.push(k, x);
      }
    }
  }
  return out;
}

/**
 * All text the model reads in an input schema: the root and its in-place branches
 * (`anyOf`, `not`, …), every parameter at any depth, and every `$defs`/`definitions` entry,
 * referenced or not. The root's path is `""`; a definition's path is `$defs/Name` (below the
 * root) or `field.$defs/Name`. The location of the root's own text is undefined, and
 * `anyOf/0`, `not`, … for its in-place branches. A node reached both through a `$ref`
 * and as a definition is reported once, at the referring path.
 */
export function collectSchemaText(schema: unknown): ModelText[] {
  // Start at the root as a reported node: its own text is read by the model too
  const walked = walkParams(schema, schema, { path: '', location: undefined });
  const reached = new Set(walked.map((p) => p.schema).filter((s) => s !== undefined));
  // A definition node is reported once: not again when the walk or an earlier definition (a
  // chain listed in reverse order: D2, then D1 → $ref D2) already reported it
  const nodes = withDefinitions(walked, schema).filter((p, i) => {
    if (i < walked.length || p.schema === undefined) return true;
    if (reached.has(p.schema)) return false;
    reached.add(p.schema);
    return true;
  });
  return collectModelText(nodes);
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
