/**
 * Security checks - Tool-poisoning heuristics
 *
 * Detects potential security issues in MCP tool definitions:
 * 1. Injection-like phrasing in every text the model reads (descriptions, titles, defaults, …)
 * 2. Hidden/zero-width unicode characters in the name and the same text
 * 3. Secret-soliciting input schemas
 * 4. Annotation/behavior mismatch (readOnlyHint on destructive tools)
 *
 * IMPORTANT: Tuned for ZERO false positives on good-server.
 * A security check that cries wolf is worse than none.
 */

import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import { listAllTools } from '../client/tools.js';
import type { Tool } from './schema.js';
import {
  TAG_START,
  collectSchemaText,
  collectSecretFields,
  findInjectionPatterns,
  findSuspiciousUnicode,
  stepsOf,
  type Steps,
} from './heuristics.js';

export interface SecurityCheckContext {
  connection: McpConnection;
}

/**
 * Keywords that indicate destructive/mutating operations.
 * If readOnlyHint is true but these appear, it's suspicious.
 */
const DESTRUCTIVE_KEYWORDS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdestroy\b/i,
  /\bwipe\b/i,
  /\berase\b/i,
  /\bdrop\b/i,
  /\btruncate\b/i,
  /\bwrite\b/i,
  /\bmodify\b/i,
  /\bupdate\b/i,
  /\bcreate\b/i,
  /\binsert\b/i,
  /\bmutate\b/i,
  /\bchange\b/i,
  /\bpermanently\b/i,
  /\bcannot\s+be\s+undone\b/i,
];

/**
 * Formats hidden-unicode findings. Tag characters are decoded to the ASCII they smuggle
 * so the reviewer sees the hidden instruction, not just a code point list.
 */
function describeUnicode(found: { codePoint: number; type: string }[]): string {
  const tags = found.filter((u) => u.type === 'tag-character');
  const others = found.filter((u) => u.type !== 'tag-character');
  const parts = others.map((u) => `U+${u.codePoint.toString(16).toUpperCase()} (${u.type})`);
  if (tags.length > 0) {
    const decoded = tags
      .map((u) => u.codePoint - TAG_START)
      .filter((c) => c >= 0x20 && c < 0x7f)
      .map((c) => String.fromCharCode(c))
      .join('');
    parts.push(`${tags.length} tag character(s) (ASCII smuggling) decoding to "${decoded}"`);
  }
  return parts.join(', ');
}

/**
 * Checks if text contains destructive/mutating keywords.
 */
function hasDestructiveKeywords(text: string): boolean {
  return DESTRUCTIVE_KEYWORDS.some((pattern) => pattern.test(text));
}

/** Where a scanned text is, for the report. */
interface Place {
  /** `description`, `title`, `inputSchema.properties/a.default`, … — goes into the message. */
  where: string;
  location: string;
  /**
   * What findings are grouped by: tool-level or not, the location segments and the keyword.
   * Not the location string, which can coincide for two places (a property named `a.items`).
   */
  key: string;
}

/** A piece of text the model reads. */
interface ScannedText {
  text: string;
  /**
   * Built only for a text with a finding: a location per text makes a deep schema quadratic
   * (10 000 levels with a description each took 2 GB). Built once per location and keyword:
   * every string under it returns the same object.
   */
  place: () => Place;
  /** Tool-level text keeps the pre-1.3.1 wording "injection-like pattern". */
  toolLevel: boolean;
}

/**
 * Every text of a tool the model reads: the tool's description and title, `annotations.title`,
 * and everything `collectSchemaText` finds in the input schema. The location is the full path:
 * `tool` for the description, `tool.title`, `tool.annotations.title`, and
 * `tool.inputSchema.<segments>.<keyword>` for the schema, with every keyword spelled out and
 * property names prefixed: `tool.inputSchema.description` (root),
 * `tool.inputSchema.properties/rows.items.properties/note.description`,
 * `tool.inputSchema.properties/opts.patternProperties/^x.title`,
 * `tool.inputSchema.$defs/Name.title`.
 */
function modelTexts(tool: Tool): ScannedText[] {
  const { name } = tool;
  const out: ScannedText[] = [];
  // The server is untrusted: a field typed as a string may be anything at runtime
  const add = (where: string, location: string, value: unknown) => {
    if (typeof value === 'string' && value !== '') {
      const place = { where, location, key: JSON.stringify([true, where]) };
      out.push({ text: value, place: () => place, toolLevel: true });
    }
  };
  add('description', name, tool.description);
  add('title', `${name}.title`, tool.title);
  add('annotations.title', `${name}.annotations.title`, tool.annotations?.title);
  if (tool.inputSchema) {
    // The strings under one keyword share its location object: 20 000 matches under a long
    // property name would otherwise build 20 000 location-sized strings
    const places = new Map<Steps | undefined, Map<string, Place>>();
    for (const { location, keyword, text } of collectSchemaText(tool.inputSchema)) {
      const place = () => {
        let byKeyword = places.get(location);
        if (!byKeyword) places.set(location, (byKeyword = new Map()));
        let p = byKeyword.get(keyword);
        if (!p) {
          const steps = stepsOf(location);
          const where = ['inputSchema', ...steps, keyword].join('.');
          p = { where, location: `${name}.${where}`, key: JSON.stringify([false, steps, keyword]) };
          byKeyword.set(keyword, p);
        }
        return p;
      };
      out.push({ text, place, toolLevel: false });
    }
  }
  return out;
}

/**
 * How long the merged details of one finding may grow. The first string is always described;
 * the rest are counted once over: 20 000 strings under one `examples` built a message of a
 * million characters, which pushed every other finding out of the PR comment.
 */
const MAX_MERGED_DETAILS_CHARS = 1000;

/**
 * Injection phrasing and hidden unicode in every text the model reads (see `modelTexts`). One
 * result per rule and location: several strings under one keyword (`examples`) are merged.
 */
function scanModelText(tool: Tool): CheckResult[] {
  interface Group {
    result: CheckResult & { actual: unknown[] };
    prefix: string;
    /** Every distinct detail seen; a Set, so merging N strings stays linear. */
    seen: Set<string>;
    details: string[];
    length: number;
    omitted: number;
  }
  type RuleId = 'security/injection-pattern' | 'security/hidden-unicode';
  const groups = new Map<string, Group>();
  // A place's groups by rule, resolved once per place: the string key is as long as the
  // location, so looking it up again for every match grew with matches × location length
  const groupsOf = new Map<Place, Map<RuleId, Group>>();
  const report = (
    id: RuleId,
    place: Place,
    found: unknown[],
    prefix: () => string,
    detail: string
  ) => {
    let byRule = groupsOf.get(place);
    if (!byRule) groupsOf.set(place, (byRule = new Map()));
    let group = byRule.get(id);
    if (!group) {
      group = groups.get(`${id}\u0000${place.key}`);
      if (group) byRule.set(id, group);
    }
    if (group) {
      // Push one by one: spreading an unbounded list overflows the argument stack (RangeError)
      for (const f of found) group.result.actual.push(f);
      // Every merged string is described while there is room: a tag character joining a
      // zero-width space must not lose its decoded text to the first string's description
      if (group.seen.has(detail)) return;
      group.seen.add(detail);
      if (group.length + detail.length > MAX_MERGED_DETAILS_CHARS) group.omitted++;
      else {
        group.details.push(detail);
        group.length += detail.length;
      }
    } else {
      const result = {
        id,
        family: 'security' as const,
        status: 'fail' as const,
        severity: 'error' as const,
        message: '',
        actual: found,
        location: place.location,
      };
      const created = {
        result,
        prefix: prefix(),
        seen: new Set([detail]),
        details: [detail],
        length: detail.length,
        omitted: 0,
      };
      groups.set(`${id}\u0000${place.key}`, created);
      byRule.set(id, created);
    }
  };
  for (const t of modelTexts(tool)) {
    const injection = findInjectionPatterns(t.text);
    const unicode = findSuspiciousUnicode(t.text);
    if (injection.length === 0 && unicode.length === 0) continue;
    const place = t.place();
    if (injection.length > 0) {
      const kind = t.toolLevel ? 'injection-like pattern' : 'injection pattern';
      report(
        'security/injection-pattern',
        place,
        injection,
        () => `Tool "${tool.name}" ${place.where} contains ${kind}: `,
        `"${injection[0]}"`
      );
    }
    if (unicode.length > 0) {
      report(
        'security/hidden-unicode',
        place,
        unicode,
        () => `Tool "${tool.name}" ${place.where} contains hidden unicode: `,
        describeUnicode(unicode)
      );
    }
  }
  return [...groups.values()].map(({ result, prefix, details, omitted }) => ({
    ...result,
    message:
      prefix +
      details.join('; ') +
      (omitted > 0 ? `; and ${omitted} more (see the JSON report)` : ''),
  }));
}

/**
 * Runs all security checks on tools.
 */
export async function runSecurityChecks(ctx: SecurityCheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Get tools list
  let tools: Tool[];
  try {
    const toolsResult = { tools: await listAllTools(ctx.connection.client) };
    if (!toolsResult.tools || !Array.isArray(toolsResult.tools)) {
      results.push({
        id: 'security/list-tools',
        family: 'security',
        status: 'fail',
        severity: 'error',
        message: 'Server returned invalid tools list',
      });
      return results;
    }
    tools = toolsResult.tools as Tool[];
  } catch (err) {
    results.push({
      id: 'security/list-tools',
      family: 'security',
      status: 'fail',
      severity: 'error',
      message: `Failed to list tools: ${err instanceof Error ? err.message : String(err)}`,
    });
    return results;
  }

  // Check each tool
  for (const tool of tools) {
    for (const item of checkToolSecurity(tool)) results.push(item);
  }

  // Summary
  const failures = results.filter((r) => r.status === 'fail');
  if (failures.length === 0) {
    results.unshift({
      id: 'security/summary',
      family: 'security',
      status: 'pass',
      severity: 'info',
      message: `Security scan passed: ${tools.length} tool(s) checked, no issues found`,
    });
  } else {
    results.unshift({
      id: 'security/summary',
      family: 'security',
      status: 'fail',
      severity: 'error',
      message: `Security scan found ${failures.length} issue(s) in ${tools.length} tool(s)`,
    });
  }

  return results;
}

/**
 * Checks a single tool for security issues.
 */
export function checkToolSecurity(tool: Tool): CheckResult[] {
  const results: CheckResult[] = [];
  const { name, description, inputSchema, annotations } = tool;

  // 1. Hidden unicode in the name
  const nameUnicode = findSuspiciousUnicode(name);
  if (nameUnicode.length > 0) {
    results.push({
      id: 'security/hidden-unicode',
      family: 'security',
      status: 'fail',
      severity: 'error',
      message: `Tool "${name}" name contains hidden unicode: ${describeUnicode(nameUnicode)}`,
      actual: nameUnicode,
      location: name,
    });
  }

  // 2. Secret-soliciting fields at every nesting level (`options.password` too)
  if (inputSchema) {
    const secretFields = collectSecretFields(inputSchema);
    if (secretFields.length > 0) {
      results.push({
        id: 'security/secret-in-schema',
        family: 'security',
        status: 'fail',
        severity: 'error',
        message: `Tool "${name}" schema solicits secrets: ${secretFields.join(', ')}`,
        actual: secretFields,
        location: name,
      });
    }
  }

  // 3. Injection phrasing and hidden unicode in every text the model reads
  for (const r of scanModelText(tool)) results.push(r);

  // 6. Check for annotation/behavior mismatch
  if (annotations?.readOnlyHint === true) {
    const textToCheck = `${name} ${description ?? ''}`;
    if (hasDestructiveKeywords(textToCheck)) {
      results.push({
        id: 'security/annotation-mismatch',
        family: 'security',
        status: 'fail',
        severity: 'error',
        message: `Tool "${name}" has readOnlyHint=true but name/description implies mutation`,
        expected: 'readOnlyHint should be false for destructive operations',
        actual: { readOnlyHint: true, impliesDestruction: true },
        location: name,
      });
    }
  }

  return results;
}
