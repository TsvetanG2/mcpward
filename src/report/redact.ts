/**
 * Secret redaction utilities.
 *
 * Redacts sensitive values from strings before they reach reports.
 * Applied at the report-model boundary so all reporters inherit it.
 */

/** Set of resolved secret values to redact */
let resolvedSecrets = new Set<string>();

/** Patterns that indicate sensitive field names */
const SENSITIVE_FIELD_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /api[-_]?key/i,
  /authorization/i,
  /credential/i,
  /private[-_]?key/i,
  /access[-_]?key/i,
  /auth[-_]?token/i,
];

/**
 * Registers a secret value that should be redacted from output.
 * Called during config loading when environment variables are interpolated.
 */
export function registerSecret(value: string): void {
  // Only register non-trivial values (at least 4 chars to avoid redacting common strings)
  if (value && value.length >= 4) {
    resolvedSecrets.add(value);
  }
}

/**
 * Clears all registered secrets. Used for testing.
 */
export function clearSecrets(): void {
  resolvedSecrets = new Set();
}

/**
 * Gets the count of registered secrets. Used for testing.
 */
export function getSecretCount(): number {
  return resolvedSecrets.size;
}

/**
 * Checks if a field name appears to be sensitive.
 */
export function isSensitiveFieldName(fieldName: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Redacts a string value, replacing any registered secrets with [REDACTED].
 */
export function redactString(value: string): string {
  if (!value) return value;

  let result = value;

  // Redact registered secrets (from environment interpolation)
  for (const secret of resolvedSecrets) {
    // Use a simple replacement - secrets should be exact matches or substrings
    // Escape special regex characters in the secret
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }

  // Also redact common patterns that look like secrets in URLs or messages
  // Bearer tokens in Authorization headers
  result = result.replace(/Bearer\s+[A-Za-z0-9_\-./+=]+/gi, 'Bearer [REDACTED]');

  // API keys in query strings (common patterns)
  result = result.replace(/([?&])(api[-_]?key|token|key|secret|password)=([^&\s]+)/gi, '$1$2=[REDACTED]');

  // Basic auth in URLs (user:pass@host)
  result = result.replace(/:\/\/([^:]+):([^@]+)@/g, '://[REDACTED]:[REDACTED]@');

  return result;
}

/**
 * Recursively redacts secrets from an unknown value.
 * Used for sanitizing CheckResult.expected and CheckResult.actual.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      // If the key looks sensitive, redact the entire value
      if (isSensitiveFieldName(key) && typeof val === 'string') {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactValue(val);
      }
    }
    return result;
  }

  return value;
}

/**
 * Redacts secrets from a CheckResult.
 */
export function redactCheckResult(result: {
  message: string;
  expected?: unknown;
  actual?: unknown;
  location?: string;
}): void {
  result.message = redactString(result.message);
  if (result.expected !== undefined) {
    result.expected = redactValue(result.expected);
  }
  if (result.actual !== undefined) {
    result.actual = redactValue(result.actual);
  }
  if (result.location !== undefined) {
    result.location = redactString(result.location);
  }
}

/**
 * Redacts secrets from an entire CheckReport.
 * Call this before rendering to any reporter.
 */
export function redactReport(report: {
  results: {
    message: string;
    expected?: unknown;
    actual?: unknown;
    location?: string;
  }[];
}): void {
  for (const result of report.results) {
    redactCheckResult(result);
  }
}
