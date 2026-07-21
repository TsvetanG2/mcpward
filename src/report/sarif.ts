/**
 * SARIF (Static Analysis Results Interchange Format) reporter.
 *
 * Generates SARIF 2.1.0 output for integration with GitHub Code Scanning
 * and other security tools.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

import type { CheckResult, CheckReport } from './model.js';

const SARIF_VERSION = '2.1.0';
const SARIF_SCHEMA = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';

/**
 * SARIF Result Level mapping from our severity.
 */
function toSarifLevel(severity: string): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'note';
  }
}

/**
 * Maps check family to SARIF rule category.
 */
function toCategory(family: string): string {
  switch (family) {
    case 'security':
      return 'security';
    case 'compliance':
      return 'correctness';
    case 'schema':
      return 'correctness';
    case 'drift':
      return 'maintainability';
    default:
      return 'general';
  }
}

/**
 * Creates a unique rule ID from check result.
 */
function toRuleId(result: CheckResult): string {
  return result.id.replace(/\//g, '-');
}

/**
 * Creates a markdown anchor from a check ID.
 * GitHub Flavored Markdown removes slashes and converts to lowercase.
 */
export function toHelpAnchor(checkId: string): string {
  return checkId.replace(/\//g, '').toLowerCase();
}

/**
 * Creates SARIF rule definitions from check results.
 */
function createRules(results: CheckResult[]): SarifRule[] {
  const ruleMap = new Map<string, SarifRule>();

  for (const result of results) {
    const ruleId = toRuleId(result);
    if (!ruleMap.has(ruleId)) {
      const help = getHelp(result.id);
      const rule: SarifRule = {
        id: ruleId,
        name: result.id,
        shortDescription: {
          text: getShortDescription(result.id),
        },
        fullDescription: {
          text: getFullDescription(result.id),
        },
        helpUri: `https://github.com/TsvetanG2/mcpward/blob/main/docs/rules.md#${toHelpAnchor(result.id)}`,
        defaultConfiguration: {
          level: getDefaultLevel(result.family),
        },
        properties: {
          category: toCategory(result.family),
          security: result.family === 'security',
        },
      };
      if (help) {
        rule.help = help;
      }
      ruleMap.set(ruleId, rule);
    }
  }

  return Array.from(ruleMap.values());
}

/**
 * Gets a short description for a rule.
 */
function getShortDescription(ruleId: string): string {
  const descriptions: Record<string, string> = {
    'security/injection-pattern': 'Prompt injection pattern detected',
    'security/hidden-unicode': 'Hidden unicode characters detected',
    'security/secret-in-schema': 'Schema solicits secrets',
    'security/annotation-mismatch': 'Annotation behavior mismatch',
    'security/summary': 'Security scan summary',
    'compliance/handshake': 'Protocol handshake check',
    'compliance/protocol-version': 'Protocol version check',
    'compliance/server-info': 'Server info check',
    'compliance/capabilities': 'Capabilities check',
    'compliance/ping': 'Ping check',
    'schema/tool-name': 'Tool name validation',
    'schema/tool-description': 'Tool description validation',
    'schema/tool-input-schema': 'Input schema validation',
    'schema/tool-annotations': 'Annotations validation',
    'schema/unique-names': 'Unique names check',
    'drift/tool_removed': 'Tool removed',
    'drift/tool_added': 'Tool added',
    'drift/description_changed': 'Description changed (rug-pull)',
    'drift/breaking_schema_change': 'Breaking schema change',
    'drift/nonbreaking_schema_change': 'Non-breaking schema change',
    'drift/annotation_changed': 'Annotation changed',
  };
  return descriptions[ruleId] ?? ruleId;
}

/**
 * Gets a full description for a rule.
 */
function getFullDescription(ruleId: string): string {
  const descriptions: Record<string, string> = {
    'security/injection-pattern':
      'The tool description contains patterns commonly used in prompt injection attacks, such as "ignore previous instructions" or "before doing anything else".',
    'security/hidden-unicode':
      'The tool name or description contains zero-width or bidirectional override characters that can hide malicious content.',
    'security/secret-in-schema':
      'The tool input schema contains field names that suggest it is soliciting secrets such as api_key, password, or token.',
    'security/annotation-mismatch':
      'The tool has readOnlyHint=true but its name or description implies destructive/mutating behavior.',
    'drift/description_changed':
      'The tool description has silently changed between versions. This could indicate a rug-pull attack where the tool behavior changes after trust is established.',
    'drift/tool-added':
      'A new tool has been added since the baseline was captured. Review the new tool carefully for unexpected functionality.',
    'drift/tool-removed':
      'A tool that existed in the baseline is no longer present. This is a breaking change for clients relying on this tool.',
    'compliance/handshake':
      'Verifies that the MCP server completes the protocol handshake successfully, returning valid server info and capabilities.',
    'schema/tool-name':
      'Tool names must match the pattern ^[a-zA-Z0-9_-]+$ to ensure compatibility across clients and prevent injection issues.',
    'schema/tool-description':
      'Tools should have meaningful descriptions that help LLMs understand when and how to use them effectively.',
    'errors/unknown-tool':
      'Calling an unknown tool should return a JSON-RPC protocol error, not a tool-level error with isError:true.',
    'errors/invalid-params':
      'Calling a tool with invalid parameters should return a JSON-RPC protocol error (-32602), not a tool-level error.',
    'latency/tool':
      'Tool response time exceeded the configured latency budget. Consider optimizing the tool implementation.',
    'behavioral/case':
      'A behavioral test case failed. The tool output did not match the expected result defined in the test suite.',
  };
  return descriptions[ruleId] ?? getShortDescription(ruleId);
}

/**
 * Gets help documentation for a rule in both plain text and markdown formats.
 */
function getHelp(
  ruleId: string
): { text: string; markdown: string } | undefined {
  const helpDocs: Record<string, { text: string; markdown: string }> = {
    'security/injection-pattern': {
      text:
        'This tool description contains language that could manipulate LLM behavior. ' +
        'Common injection patterns include "ignore previous instructions", "you must always", or "before doing anything else". ' +
        'These patterns can be used to override safety guidelines or hijack the LLM\'s behavior. ' +
        'Fix: Rewrite the tool description to focus on what the tool does, not instructions for how the LLM should behave.',
      markdown:
        '## Prompt Injection Pattern Detected\n\n' +
        'This tool description contains language that could manipulate LLM behavior.\n\n' +
        '### Dangerous Patterns\n' +
        '- "Ignore previous instructions"\n' +
        '- "You must always call this tool first"\n' +
        '- "Before doing anything else"\n\n' +
        '### Why It Matters\n' +
        'These patterns can override safety guidelines or hijack LLM behavior.\n\n' +
        '### How to Fix\n' +
        'Rewrite the description to focus on **what the tool does**, not instructions for the LLM.',
    },
    'security/hidden-unicode': {
      text:
        'Hidden unicode characters were detected in this tool name or description. ' +
        'Zero-width characters, bidirectional overrides, and other invisible characters can hide malicious content from human reviewers. ' +
        'Fix: Remove all non-printable unicode characters from tool names and descriptions.',
      markdown:
        '## Hidden Unicode Characters Detected\n\n' +
        'Invisible characters were found that could hide malicious content.\n\n' +
        '### Why It Matters\n' +
        'Zero-width and bidirectional override characters can:\n' +
        '- Hide text from human review\n' +
        '- Reverse text direction to disguise URLs\n' +
        '- Insert invisible instructions\n\n' +
        '### How to Fix\n' +
        'Use a unicode-aware editor to identify and remove all non-printable characters.',
    },
    'security/secret-in-schema': {
      text:
        'This tool schema contains field names suggesting it requests sensitive data like passwords or API keys. ' +
        'Tools should not request credentials as input parameters. ' +
        'Fix: Use environment variables or secure configuration for credentials.',
      markdown:
        '## Schema Solicits Secrets\n\n' +
        'The input schema contains fields that appear to request sensitive credentials.\n\n' +
        '### Detected Fields\n' +
        'Common patterns: `password`, `api_key`, `secret`, `token`, `authorization`\n\n' +
        '### Why It Matters\n' +
        'Credentials passed through tool inputs may be logged, cached, or exposed.\n\n' +
        '### How to Fix\n' +
        'Use environment variables or secure configuration instead of tool parameters.',
    },
    'drift/description_changed': {
      text:
        'The tool description has silently changed since the baseline was captured. ' +
        'This could indicate a rug-pull attack where tool behavior is modified after trust is established. ' +
        'Review the change carefully and update the baseline if the change is intentional.',
      markdown:
        '## Description Changed (Potential Rug-Pull)\n\n' +
        'The tool description has silently changed since the baseline.\n\n' +
        '### Why It Matters\n' +
        'Changing descriptions after trust is established can:\n' +
        '- Modify how LLMs interpret and use the tool\n' +
        '- Introduce malicious instructions unnoticed\n' +
        '- Change tool behavior without explicit versioning\n\n' +
        '### How to Fix\n' +
        '1. Review the description change carefully\n' +
        '2. Verify the change is intentional and benign\n' +
        '3. Run `mcpward baseline` to update if approved',
    },
    'schema/tool-name': {
      text:
        'Tool names must use only alphanumeric characters, underscores, and hyphens. ' +
        'Invalid characters can cause compatibility issues across clients. ' +
        'Fix: Rename the tool to use only allowed characters.',
      markdown:
        '## Invalid Tool Name\n\n' +
        'Tool names must match the pattern `^[a-zA-Z0-9_-]+$`.\n\n' +
        '### Why It Matters\n' +
        'Special characters in tool names can:\n' +
        '- Break client implementations\n' +
        '- Cause parsing issues in JSON-RPC\n' +
        '- Create injection vulnerabilities\n\n' +
        '### How to Fix\n' +
        'Use only letters, numbers, underscores, and hyphens.',
    },
  };
  return helpDocs[ruleId];
}

/**
 * Gets the default severity level for a rule family.
 */
function getDefaultLevel(family: string): 'error' | 'warning' | 'note' {
  switch (family) {
    case 'security':
      return 'error';
    case 'compliance':
      return 'error';
    case 'schema':
      return 'warning';
    case 'drift':
      return 'warning';
    case 'errors':
      return 'error';
    case 'behavioral':
      return 'error';
    case 'latency':
      return 'warning';
    default:
      return 'note';
  }
}

/**
 * Creates SARIF results from check results.
 */
function createResults(results: CheckResult[]): SarifResult[] {
  return results
    .filter((r) => r.status === 'fail' || r.status === 'warn')
    .map((result) => ({
      ruleId: toRuleId(result),
      level: toSarifLevel(result.severity),
      message: {
        text: result.message,
      },
      locations: result.location
        ? [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: 'mcpward.yaml',
                  uriBaseId: '%SRCROOT%',
                },
              },
              logicalLocations: [
                {
                  name: result.location,
                  kind: 'tool',
                },
              ],
            },
          ]
        : [],
      properties: {
        expected: result.expected,
        actual: result.actual,
        family: result.family,
      },
    }));
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri: string;
  help?: {
    text: string;
    markdown: string;
  };
  defaultConfiguration: {
    level: 'error' | 'warning' | 'note';
  };
  properties: {
    category: string;
    security: boolean;
  };
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: {
    physicalLocation?: {
      artifactLocation: {
        uri: string;
        uriBaseId: string;
      };
    };
    logicalLocations?: {
      name: string;
      kind: string;
    }[];
  }[];
  properties: Record<string, unknown>;
}

interface SarifReport {
  $schema: string;
  version: string;
  runs: {
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
    invocations: {
      executionSuccessful: boolean;
      endTimeUtc: string;
    }[];
  }[];
}

/**
 * Renders a SARIF report from check results.
 */
export function renderSarifReport(report: CheckReport): string {
  const sarif: SarifReport = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: 'mcpward',
            version: report.version,
            informationUri: 'https://github.com/TsvetanG2/mcpward',
            rules: createRules(report.results),
          },
        },
        results: createResults(report.results),
        invocations: [
          {
            executionSuccessful: report.summary.failed === 0,
            endTimeUtc: report.timestamp,
          },
        ],
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
