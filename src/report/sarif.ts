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
 * Creates SARIF rule definitions from check results.
 */
function createRules(results: CheckResult[]): SarifRule[] {
  const ruleMap = new Map<string, SarifRule>();

  for (const result of results) {
    const ruleId = toRuleId(result);
    if (!ruleMap.has(ruleId)) {
      ruleMap.set(ruleId, {
        id: ruleId,
        name: result.id,
        shortDescription: {
          text: getShortDescription(result.id),
        },
        fullDescription: {
          text: getFullDescription(result.id),
        },
        helpUri: `https://github.com/TsvetanG2/mcpward#${result.id.replace(/\//g, '')}`,
        properties: {
          category: toCategory(result.family),
          security: result.family === 'security',
        },
      });
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
    'security/injection-pattern': 'The tool description contains patterns commonly used in prompt injection attacks, such as "ignore previous instructions" or "before doing anything else".',
    'security/hidden-unicode': 'The tool name or description contains zero-width or bidirectional override characters that can hide malicious content.',
    'security/secret-in-schema': 'The tool input schema contains field names that suggest it is soliciting secrets such as api_key, password, or token.',
    'security/annotation-mismatch': 'The tool has readOnlyHint=true but its name or description implies destructive/mutating behavior.',
    'drift/description_changed': 'The tool description has silently changed between versions. This could indicate a rug-pull attack where the tool behavior changes after trust is established.',
  };
  return descriptions[ruleId] ?? getShortDescription(ruleId);
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
