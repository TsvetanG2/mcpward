# Risk manifest v1 (RFC draft)

**DRAFT.** Shared risk manifest format proposed with KyttoMCP. Not implemented in mcpward yet.

Discussion: https://github.com/TsvetanG2/mcpward/discussions/98

## Files

| File | Purpose |
| --- | --- |
| `risk-manifest.v1.schema.json` | JSON Schema (2020-12) for the manifest format. |
| `example.risk-manifest.json` | Hand-written example manifest with four tools: no evidence, annotations only, heuristic only, and an annotation that conflicts with a heuristic. |
| `contract_hash.py` | Reference implementation of the `mcp-tool-contract` hash (rules version 1). Prints the canonical JSON and the `sha256:` hash of one tool object. |
| `vectors/*.json` | Test vectors for the hash: single tool objects as returned by `tools/list`. |

## Test vectors

```sh
for f in vectors/*.json; do python3 -I contract_hash.py "$f" | tail -1; done
```

Expected output, in order:

```
sha256:e357ae1ab7e99d7607e718cee5276e626598aeda292b50af9874180aea723eea
sha256:f7aec6368c29e82062ab418ec32086533ecbc78e6e44983555dd3b6e158b54cc
sha256:9c2e1766c0893bbd125c6a81602b342e577dc0de4c70b83f4ee58254778abd83
sha256:5daaf08fdc15544ed68ea21c78a31b6e9245ca1c009afff49b625737ab706d04
```
