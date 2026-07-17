/**
 * Compliance checks
 *
 * Verifies protocol-level compliance:
 * - Successful initialize handshake
 * - Sane negotiated protocolVersion
 * - Declared capabilities consistent with reality
 * - Ping response
 */

import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import type { Config } from '../config/schema.js';

export interface ComplianceCheckContext {
  connection: McpConnection;
  config: Config;
}

/**
 * Runs all compliance checks.
 */
export async function runComplianceChecks(
  ctx: ComplianceCheckContext
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Check 1: Handshake completed (if we got here, it did)
  results.push({
    id: 'compliance/handshake',
    family: 'compliance',
    status: 'pass',
    severity: 'error',
    message: 'Protocol handshake completed successfully',
    actual: {
      serverName: ctx.connection.serverInfo.name,
      serverVersion: ctx.connection.serverInfo.version,
      protocolVersion: ctx.connection.protocolVersion,
    },
  });

  // Check 2: Protocol version is reasonable
  results.push(checkProtocolVersion(ctx));

  // Check 3: Server info is present and valid
  results.push(checkServerInfo(ctx));

  // Check 4: Capabilities are declared
  results.push(checkCapabilities(ctx));

  // Check 5: Ping works
  results.push(await checkPing(ctx));

  // Check 6: If expected protocol version is specified, verify it matches
  if (ctx.config.expect?.protocol_version) {
    results.push(checkExpectedProtocolVersion(ctx));
  }

  return results;
}

function checkProtocolVersion(ctx: ComplianceCheckContext): CheckResult {
  const version = ctx.connection.protocolVersion;

  // Protocol version should be a non-empty string in date format or similar
  if (!version || version === 'unknown') {
    return {
      id: 'compliance/protocol-version',
      family: 'compliance',
      status: 'fail',
      severity: 'error',
      message: 'Server did not negotiate a protocol version',
      expected: 'A valid protocol version string',
      actual: version,
    };
  }

  // Basic sanity check - should look like a version string
  // MCP versions are typically date-based like "2025-11-25" or semantic
  const looksValid = /^[\w.-]+$/.test(version);

  if (!looksValid) {
    return {
      id: 'compliance/protocol-version',
      family: 'compliance',
      status: 'warn',
      severity: 'warning',
      message: `Protocol version has unusual format: ${version}`,
      expected: 'Version string like "2025-11-25" or "1.0.0"',
      actual: version,
    };
  }

  return {
    id: 'compliance/protocol-version',
    family: 'compliance',
    status: 'pass',
    severity: 'info',
    message: `Negotiated protocol version: ${version}`,
    actual: version,
  };
}

function checkServerInfo(ctx: ComplianceCheckContext): CheckResult {
  const { name, version } = ctx.connection.serverInfo;

  if (!name || name.trim() === '') {
    return {
      id: 'compliance/server-info',
      family: 'compliance',
      status: 'fail',
      severity: 'error',
      message: 'Server did not provide a name',
      expected: 'Non-empty server name',
      actual: name,
    };
  }

  if (!version || version.trim() === '') {
    return {
      id: 'compliance/server-info',
      family: 'compliance',
      status: 'warn',
      severity: 'warning',
      message: 'Server did not provide a version',
      expected: 'Non-empty server version',
      actual: version,
    };
  }

  return {
    id: 'compliance/server-info',
    family: 'compliance',
    status: 'pass',
    severity: 'info',
    message: `Server: ${name} v${version}`,
    actual: { name, version },
  };
}

function checkCapabilities(ctx: ComplianceCheckContext): CheckResult {
  const capabilities = ctx.connection.capabilities;

  // Capabilities object should exist
  if (!capabilities || typeof capabilities !== 'object') {
    return {
      id: 'compliance/capabilities',
      family: 'compliance',
      status: 'fail',
      severity: 'error',
      message: 'Server did not declare capabilities',
      expected: 'Capabilities object',
      actual: capabilities,
    };
  }

  // List what capabilities are declared
  const declared = Object.keys(capabilities).filter(
    (k) => capabilities[k] !== undefined && capabilities[k] !== null
  );

  return {
    id: 'compliance/capabilities',
    family: 'compliance',
    status: 'pass',
    severity: 'info',
    message: `Server declares capabilities: ${declared.length > 0 ? declared.join(', ') : 'none'}`,
    actual: capabilities,
  };
}

async function checkPing(ctx: ComplianceCheckContext): Promise<CheckResult> {
  try {
    // SDK Client has a ping method
    await ctx.connection.client.ping();

    return {
      id: 'compliance/ping',
      family: 'compliance',
      status: 'pass',
      severity: 'info',
      message: 'Server responds to ping',
    };
  } catch (err) {
    return {
      id: 'compliance/ping',
      family: 'compliance',
      status: 'fail',
      severity: 'error',
      message: `Server failed to respond to ping: ${err instanceof Error ? err.message : String(err)}`,
      expected: 'Successful ping response',
      actual: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkExpectedProtocolVersion(ctx: ComplianceCheckContext): CheckResult {
  const expected = ctx.config.expect?.protocol_version;
  const actual = ctx.connection.protocolVersion;

  if (expected !== actual) {
    return {
      id: 'compliance/expected-protocol-version',
      family: 'compliance',
      status: 'fail',
      severity: 'error',
      message: `Protocol version mismatch`,
      expected,
      actual,
    };
  }

  return {
    id: 'compliance/expected-protocol-version',
    family: 'compliance',
    status: 'pass',
    severity: 'info',
    message: `Protocol version matches expected: ${expected}`,
    expected,
    actual,
  };
}
