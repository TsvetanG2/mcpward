import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import pc from 'picocolors';

const DEFAULT_CONFIG = `# mcpward configuration
# See: https://github.com/anthropics/mcpward

server:
  transport: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]
  env: {}
  # For HTTP transport:
  # transport: http
  # url: "https://example.com/mcp"
  # headers:
  #   Authorization: "Bearer \${MCP_TOKEN}"

# expect:
#   protocol_version: "2025-06-18"  # Optional: assert specific version

checks:
  compliance: true
  schema: true
  security: true
  drift:
    baseline: ./mcpward.lock.json
    fail_on:
      - tool_removed
      - description_changed
      - breaking_schema_change
      - annotation_changed
  latency:
    samples: 5
    p95_budget_ms: 1000

# Behavioral test suites (optional)
suites: []
  # - tool: read_file
  #   cases:
  #     - name: reads an existing file
  #       args: { path: "/tmp/sandbox/hello.txt" }
  #       expect:
  #         tool_is_error: false
  #         output_matches_schema: true
`;

export async function initCommand(): Promise<void> {
  const configPath = 'mcpward.yaml';

  if (existsSync(configPath)) {
    console.log(pc.yellow(`Config file already exists: ${configPath}`));
    return;
  }

  await writeFile(configPath, DEFAULT_CONFIG, 'utf-8');
  console.log(pc.green(`Created ${configPath}`));
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Edit ${pc.cyan(configPath)} to configure your server`);
  console.log(`  2. Run ${pc.cyan('mcpward run')} to validate the server`);
  console.log(`  3. Run ${pc.cyan('mcpward baseline')} to create a lockfile`);
}
