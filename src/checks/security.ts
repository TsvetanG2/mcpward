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
import type { Tool } from './schema.js';

export interface SecurityCheckContext {
  connection: McpConnection;
}

/**
 * Patterns that indicate injection attempts aimed at the model.
 * These are phrases commonly used in prompt injection attacks.
 */
const INJECTION_PATTERNS = [
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
const SUSPICIOUS_UNICODE = {
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
const SECRET_FIELD_PATTERNS = [
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
 * Checks a string for injection-like patterns.
 */
function findInjectionPatterns(text: string): string[] {
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

/**
 * Finds suspicious unicode characters in a string.
 */
function findSuspiciousUnicode(text: string): { char: string; codePoint: number; type: string }[] {
  const suspicious: { char: string; codePoint: number; type: string }[] = [];

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;

    if (SUSPICIOUS_UNICODE.zeroWidth.includes(codePoint)) {
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
 * Checks if a schema property name looks like it's soliciting secrets.
 */
function isSecretField(fieldName: string): boolean {
  return SECRET_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
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
export async function runSecurityChecks(
  ctx: SecurityCheckContext
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Get tools list
  let tools: Tool[];
  try {
    const toolsResult = await ctx.connection.client.listTools();
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
function checkToolSecurity(tool: Tool): CheckResult[] {
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
      message: `Tool "${name}" name contains hidden unicode: ${nameUnicode.map((u) => `U+${u.codePoint.toString(16).toUpperCase()} (${u.type})`).join(', ')}`,
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
        message: `Tool "${name}" description contains hidden unicode: ${descUnicode.map((u) => `U+${u.codePoint.toString(16).toUpperCase()} (${u.type})`).join(', ')}`,
        actual: descUnicode,
        location: name,
      });
    }
  }

  // 4. Check for secret-soliciting fields in schema
  if (inputSchema?.properties) {
    const secretFields: string[] = [];
    for (const fieldName of Object.keys(inputSchema.properties)) {
      if (isSecretField(fieldName)) {
        secretFields.push(fieldName);
      }
    }
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

  // 5. Check for injection patterns in parameter descriptions
  if (inputSchema?.properties) {
    for (const [fieldName, fieldSchema] of Object.entries(inputSchema.properties)) {
      const fieldDesc = (fieldSchema as { description?: string })?.description;
      if (fieldDesc) {
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
