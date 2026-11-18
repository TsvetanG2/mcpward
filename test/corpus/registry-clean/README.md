# Registry clean corpus

Real tool definitions that the security detectors should not flag.

## Source

- **Registry:** the official MCP Registry, https://registry.modelcontextprotocol.io/v0/servers
- **Collected:** 2026-11-18 by `node scripts/collect-registry-tools.mjs 400 4`
- **File:** `tools-2026-11-18.json`: 400 tools from 114 servers

## Method

1. List every server in the registry and keep the latest version of each (`isLatest`): 40,078 servers had a public Streamable HTTP remote. Remotes with URL template variables or required headers were skipped.
2. Take every 133rd server in name order (302 servers) and contact them in a fixed pseudo-random order (seed 1).
3. For each server, `initialize` and `tools/list` through the official SDK client, with no credentials and a 10 s timeout. No tool was called and no package was downloaded or run.
4. Keep at most 4 tools per server and stop at 400 tools. 208 servers were contacted: 117 answered, 91 failed (auth required, timeout, or offline).
5. Keep only the fields the detectors read: `name`, `title`, `description`, `inputSchema`, `annotations`.

The snapshot is never refreshed by tests. To refresh it, rerun the script, then review `known-false-positives.json`.

## `known-false-positives.json`

Definitions from this snapshot that are flagged today, with the rule ids and the reason. The test asserts exactly those ids, so a fix and a new false positive both show up.
