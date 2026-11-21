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

/** A piece of text the model reads, with where it is for the report. */
interface ScannedText {
  /** `description`, `title`, `parameter "a.b" default`, … — goes into the message. */
  where: string;
  location: string;
  text: string;
  /** Tool-level text keeps the pre-1.3.1 wording "injection-like pattern". */
  toolLevel: boolean;
}

/**
 * Every text of a tool the model reads: the tool's description and title, `annotations.title`,
 * and everything `collectSchemaText` finds in the input schema. The location is the full path:
 * `tool`, `tool.title`, `tool.annotations.title`, `tool.inputSchema.<keyword>` for the schema
 * root, `tool.<param path>` for a parameter description and `tool.<param path>.<keyword>` for
 * any other keyword.
 */
function modelTexts(tool: Tool): ScannedText[] {
  const { name } = tool;
  const out: ScannedText[] = [];
  // The server is untrusted: a field typed as a string may be anything at runtime
  const add = (where: string, location: string, value: unknown) => {
    if (typeof value === 'string' && value !== '') {
      out.push({ where, location, text: value, toolLevel: true });
    }
  };
  add('description', name, tool.description);
  add('title', `${name}.title`, tool.title);
  add('annotations.title', `${name}.annotations.title`, tool.annotations?.title);
  if (tool.inputSchema) {
    for (const { path, keyword, text } of collectSchemaText(tool.inputSchema)) {
      if (path === '') {
        out.push({
          where: `input schema ${keyword}`,
          location: `${name}.inputSchema.${keyword}`,
          text,
          toolLevel: false,
        });
      } else {
        out.push({
          where: `parameter "${path}" ${keyword}`,
          location: keyword === 'description' ? `${name}.${path}` : `${name}.${path}.${keyword}`,
          text,
          toolLevel: false,
        });
      }
    }
  }
  return out;
}

/**
 * Injection phrasing and hidden unicode in every text the model reads (see `modelTexts`). One
 * result per rule and location: several strings under one keyword (`examples`) are merged.
 */
function scanModelText(tool: Tool): CheckResult[] {
  const byKey = new Map<string, CheckResult & { actual: unknown[] }>();
  const report = (
    id: 'security/injection-pattern' | 'security/hidden-unicode',
    t: ScannedText,
    found: unknown[],
    message: string
  ) => {
    const key = `${id}\u0000${t.location}`;
    const existing = byKey.get(key);
    // Push one by one: spreading an unbounded list overflows the argument stack (RangeError)
    if (existing) for (const f of found) existing.actual.push(f);
    else {
      byKey.set(key, {
        id,
        family: 'security',
        status: 'fail',
        severity: 'error',
        message,
        actual: found,
        location: t.location,
      });
    }
  };
  for (const t of modelTexts(tool)) {
    const injection = findInjectionPatterns(t.text);
    if (injection.length > 0) {
      const kind = t.toolLevel ? 'injection-like pattern' : 'injection pattern';
      report(
        'security/injection-pattern',
        t,
        injection,
        `Tool "${tool.name}" ${t.where} contains ${kind}: "${injection[0]}"`
      );
    }
    const unicode = findSuspiciousUnicode(t.text);
    if (unicode.length > 0) {
      report(
        'security/hidden-unicode',
        t,
        unicode,
        `Tool "${tool.name}" ${t.where} contains hidden unicode: ${describeUnicode(unicode)}`
      );
    }
  }
  return [...byKey.values()];
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
    results.push(...checkToolSecurity(tool));
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
