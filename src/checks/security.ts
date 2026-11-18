/**
 * Security checks - Tool-poisoning heuristics
 *
 * Detects potential security issues in MCP tool definitions:
 * 1. Injection-like phrasing in descriptions
 * 2. Hidden/zero-width unicode characters
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
  collectParamDescriptions,
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

  // 1. Check for injection patterns in description
  if (description) {
    const injectionMatches = findInjectionPatterns(description);
    if (injectionMatches.length > 0) {
      results.push({
        id: 'security/injection-pattern',
        family: 'security',
        status: 'fail',
        severity: 'error',
        message: `Tool "${name}" description contains injection-like pattern: "${injectionMatches[0]}"`,
        actual: injectionMatches,
        location: name,
      });
    }
  }

  // 2. Check for suspicious unicode in name
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

  // 3. Check for suspicious unicode in description
  if (description) {
    const descUnicode = findSuspiciousUnicode(description);
    if (descUnicode.length > 0) {
      results.push({
        id: 'security/hidden-unicode',
        family: 'security',
        status: 'fail',
        severity: 'error',
        message: `Tool "${name}" description contains hidden unicode: ${describeUnicode(descUnicode)}`,
        actual: descUnicode,
        location: name,
      });
    }
  }

  // 4. Check for secret-soliciting fields at every nesting level (`options.password` too)
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

  // 5. Check parameter descriptions at every nesting level (the model reads them all)
  if (inputSchema) {
    for (const { path: fieldName, description: fieldDesc } of collectParamDescriptions(
      inputSchema
    )) {
      // Parameter descriptions are read by the model too — same hidden-unicode rule
      const paramUnicode = findSuspiciousUnicode(fieldDesc);
      if (paramUnicode.length > 0) {
        results.push({
          id: 'security/hidden-unicode',
          family: 'security',
          status: 'fail',
          severity: 'error',
          message: `Tool "${name}" parameter "${fieldName}" description contains hidden unicode: ${describeUnicode(paramUnicode)}`,
          actual: paramUnicode,
          location: `${name}.${fieldName}`,
        });
      }

      const paramInjection = findInjectionPatterns(fieldDesc);
      if (paramInjection.length > 0) {
        results.push({
          id: 'security/injection-pattern',
          family: 'security',
          status: 'fail',
          severity: 'error',
          message: `Tool "${name}" parameter "${fieldName}" description contains injection pattern: "${paramInjection[0]}"`,
          actual: paramInjection,
          location: `${name}.${fieldName}`,
        });
      }
    }
  }

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
