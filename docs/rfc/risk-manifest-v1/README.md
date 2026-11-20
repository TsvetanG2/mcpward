# Risk manifest v1 (RFC draft)

**DRAFT.** Shared risk manifest format proposed with KyttoMCP. Not implemented in mcpward yet.

Discussion: https://github.com/TsvetanG2/mcpward/discussions/98

The spec lives in this repository. KyttoMCP links here. It moves to a neutral repository only if a third consumer appears.

## Files

| File                           | Purpose                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `risk-manifest.v1.schema.json` | JSON Schema (2020-12) for the manifest format.                                                                                                                              |
| `example.risk-manifest.json`   | Hand-written example manifest with five tools: no evidence, annotations only, heuristic only, an annotation that conflicts with a heuristic, and an unhashable tool.        |
| `contract_hash.py`             | Reference implementation of the `mcp-tool-contract` hash (rules version 1). Prints the canonical JSON and the `sha256:` hash of one tool object, or `unhashable: <reason>`. |
| `crosscheck.ts`                | Independent TypeScript implementation built on mcpward's canonicalization. Runs both over every vector and fails if they disagree.                                          |
| `validate.ts`                  | Validates the example against the schema (Ajv, strict mode) and checks that forbidden manifests are rejected.                                                               |
| `vectors/`                     | Test vectors for the hash: single tool objects as returned by `tools/list`. `7-duplicate-key.json.txt` is raw text on purpose, so editors and formatters do not "fix" it.   |

The schema's `$id` names the file's place on `main` after the spec is merged. It is an identifier, not a URL that anything fetches, so it does not resolve while this is a draft.

## Contract hash, rules version 1

The contract hash identifies the part of a tool definition that the model is told. Two manifests describe the same contract only if `canonicalization.id`, `version` and `algorithm` match **and** the hashes match.

### 1. Unhashable tools

A tool is **unhashable** when its definition is not valid I-JSON (RFC 7493), when it has an integer that a double cannot hold exactly, or when its `inputSchema` is nested too deeply. The reasons, checked over the whole tool definition, are:

| Reason              | Condition                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate-key`     | An object has the same member name twice, at any depth (compared after unescaping).                                                                  |
| `lone-surrogate`    | Any string, member name or value, contains an unpaired UTF-16 surrogate.                                                                             |
| `non-finite-number` | A number with a fraction or exponent whose nearest double is infinite (e.g. `1e400`). `NaN` and `Infinity` literals are not JSON and count here too. |
| `number-precision`  | A number written as an integer (no fraction, no exponent) outside [−(2^53−1), 2^53−1], e.g. `9007199254740993`.                                      |
| `too-deep`          | A value in `inputSchema` is deeper than 64 levels (see below).                                                                                       |

When several apply, the first in the table is reported.

For an unhashable tool, `contractHash` is `null`, `unhashableReason` is set, and the verdict is `unknown`/`unknown` with basis `none`. This fails safe. Evidence may still be listed, but it does not raise the verdict above `unknown`.

**Consumers** MUST NOT auto-approve a tool whose `contractHash` is `null`, and MUST NOT treat it as unchanged: drift cannot be detected without a hash. They SHOULD show `unhashableReason`. This holds for every reason, `too-deep` included.

**Numbers.** Every number is read as the nearest IEEE-754 binary64 value (round-half-even) and serialized as in section 3. Implementations MUST NOT use decimal or big-integer types for the hash. `0.1` and `1e21` are therefore ordinary values, not precision errors. The one exception is an integer literal outside the safe range, which is `number-precision`: two different literals there can parse to the same double.

**Depth.** `inputSchema` itself has depth 0. Every member value and every array element has the depth of its container plus 1. A tool with any value at depth greater than 64 is unhashable (`too-deep`). Implementations MUST hash every tool whose deepest value is at depth 64 or less. This matches mcpward's `MAX_SCHEMA_DEPTH`.

**Implementation note on raw text.** Duplicate keys and out-of-range integer literals can only be detected by a reader that sees the raw JSON text. A parser has already kept one of two duplicate values, and has already rounded `9007199254740993` to `9007199254740992`. Conforming generators MUST inspect the raw text. _mcpward: not yet able to detect either; it reads tools through the MCP SDK and needs a raw-message hook._

### 2. The canonical object

```
{ name, title, description, inputSchema, annotations }
```

| Field         | Rule                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `name`        | NFC.                                                                         |
| `title`       | The tool's top-level `title` (not `annotations.title`). Absent becomes `""`. |
| `description` | Absent becomes `""`.                                                         |
| `inputSchema` | See below. Absent becomes `{}`.                                              |
| `annotations` | Every string value NFC. Absent becomes `{}`.                                 |

`outputSchema` is explicitly **not** part of the hash: the model is not told it. Other tool fields (`_meta`, `icons`, …) are not part of it either.

**One rule for text:** every string member named `title` or `description` — at the top level of the tool, in `annotations`, and anywhere in `inputSchema` except below `default`, `const`, `enum` or `examples` — is canonical text.

**Canonical text:** NFC; CRLF and CR become LF; on each line, runs of spaces and tabs collapse to one space and ASCII spaces and tabs are trimmed; then ASCII spaces, tabs and LFs are trimmed from the whole string. Invisible characters (zero-width, bidi, U+00A0, U+FEFF) are **kept**.

**`inputSchema`:**

- Every string value is NFC. Values below `default`, `const`, `enum` and `examples` are data, not text for the model, and get nothing beyond NFC.
- Member names are kept exactly as sent. They are identifiers that a client sends byte for byte. The elements of every array named `required` are member names too, so they are not normalized either.
- Every array named `required` is sorted by UTF-16 code units: it is a set. All other arrays keep their source order.

The whole `inputSchema` goes into the hash, so a change to `default`, `examples`, `$comment` or an `x-*` extension changes the contract hash.

### 3. Serialization and hash

Serialize the canonical object with RFC 8785 (JCS): keys sorted by UTF-16 code units at every level, numbers formatted with ECMAScript `Number::toString` (`1` and `1.0` are the same, `-0` is `0`, `1e21` is `1e+21`). Hash the UTF-8 bytes with SHA-256. The result is `sha256:` followed by 64 lowercase hex digits.

### Relation to mcpward's drift hash

mcpward's lockfile keeps a different form: `canonicalizeSchema` applies NFC and sorts keys and `required`, and the drift diff compares descriptions through canonical text at diff time. The two hashes have different jobs:

- The **drift hash** must notice every change, so mcpward escapes lone surrogates before hashing a description.
- The **contract hash** identifies a valid contract, so a tool that is not I-JSON has none, and a consumer must treat it as unreviewable.

When mcpward generates a risk manifest, it applies the rules in this document, not its lockfile rules. `crosscheck.ts` shows the glue that is needed on top of mcpward's canonicalization: the one text rule for `title`/`description`, the unhashable checks (numbers on the raw text) and an RFC 8785 serializer. mcpward's `canonicalJson` is not RFC 8785 for integer-like member names (vector 14), because `JSON.stringify` emits them first, in numeric order.

## Verdicts and evidence

- When evidence conflicts, generators resolve it with "riskier wins". Consumers SHOULD show conflicting evidence and the verdict basis, not only the verdict.
- `arguments[]` (per-argument risk) stays optional.
- **Overrides** live in a separate file that the generator merges, so they survive regeneration. The format of that file is an open question for the next revision.

### Rule ids

Heuristic rule ids are namespaced per generator. The `shared/` namespace is the exception: its ids mean the same thing in every generator.

| Id                                | Meaning                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `shared/destructive-verb-in-name` | The tool name starts with a destructive verb (`delete_`, `drop_`, `remove_`, …).               |
| `shared/sends-externally`         | The tool sends data outside the server's own domain (email, webhook, upload, third-party API). |

The list is open for additions. All other ids are namespaced per generator (`mcpward/…`, `kytto/…`).

## Test vectors

```sh
for f in $(ls vectors | sort -n); do python3 -I contract_hash.py "vectors/$f" | tail -1; done
npx tsx crosscheck.ts   # from the repository root: npx tsx docs/rfc/risk-manifest-v1/crosscheck.ts
npx tsx validate.ts
```

Expected output, in numeric order:

| Vector                     | Content                                                                                                                               | Expected                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `1-basic`                  | whitespace and CRLF in the description, unsorted `required`                                                                           | `sha256:4d15fd30aeaf8a5bc0a52fc03bcbc9beb93a793a37a6dbc330260bd01f988b68` |
| `2-annotated`              | annotations with `annotations.title`                                                                                                  | `sha256:65ef2d414617c0595943768c3ad3533e2bf4e3dd68b5d6768e29b5d133c8d46b` |
| `3-unicode`                | decomposed `é` and a zero-width space in the description                                                                              | `sha256:5e1c5608e662702a0e4188a6b9caf48cf74933533327229ecc41901fdd90cac3` |
| `4-conflict`               | `readOnlyHint: true` on a tool that sends email                                                                                       | `sha256:99c2230e44389bac09535764378728a76a0c8f24e33f359a8c18645bf3e95785` |
| `5-numbers`                | `1e-7`, `1.5e+300`, `0.1`, `100`, `1e21`, `-0`                                                                                        | `sha256:4350b6de57e21adc4e6fda3505a0a80658a7056f4938fc41dfd4009e85523a90` |
| `6-title`                  | whitespace and CRLF in the top-level `title` and in a different `annotations.title`                                                   | `sha256:5dbb498c2c1c6e83e05830eac4bcf6b5ac962a6d8b0131910ac079e597602608` |
| `7-duplicate-key.json.txt` | raw text, a property defined twice                                                                                                    | `unhashable: duplicate-key`                                               |
| `8-lone-surrogate`         | `\ud800` in the description                                                                                                           | `unhashable: lone-surrogate`                                              |
| `9-non-finite`             | `"maximum": 1e400`                                                                                                                    | `unhashable: non-finite-number`                                           |
| `10-nested-text`           | whitespace and CRLF in a parameter description, a description under `anyOf`, schema titles; whitespace in `enum` and `default` (kept) | `sha256:1751745985987cf762462e349c1f02628eab9eab4c8ab0d8a870ebd7cc897951` |
| `11-too-deep`              | a value at depth 65                                                                                                                   | `unhashable: too-deep`                                                    |
| `12-depth-64`              | a value at depth 64                                                                                                                   | `sha256:55c22a3e6143dcc57fb66b4645489c12e7c88e68204775e3a52ed9560c125bff` |
| `13-member-names`          | property names `café` decomposed and composed, both in `required`                                                                     | `sha256:924fabc8a441ad66d1eb9d0f67c55daa496603f77cfe92e8b32456179bea49f8` |
| `14-integer-keys`          | property names `10`, `9`, `1a`, `a`                                                                                                   | `sha256:436ce618c8a28107f80aec9c28af09ab2dc3b741b3deac3d7ff3460bcc741ce9` |
| `15-safe-integer`          | `9007199254740991` and `-9007199254740991`                                                                                            | `sha256:4920b27331bab49ea17f0636b704e09a7ea54a179ae9f49c1b2aa2fd377154dd` |
| `16-unsafe-integer`        | `9007199254740993`                                                                                                                    | `unhashable: number-precision`                                            |
| `17-large-integer`         | `123456789012345680000` (moved out of vector 5)                                                                                       | `unhashable: number-precision`                                            |
| `18-numbers-in-strings`    | out-of-range and non-finite numbers only inside strings and member names                                                              | `sha256:e1fe84ba5a866fa72f0fc2e4ac5f8c7d61b043e7f39945687aa0cc75781308d1` |

`crosscheck.ts` reports vector 7 as "not detectable from parsed input" on the TypeScript side. That is the duplicate-key limitation above, not a disagreement. Its number checks (vectors 9, 15–18) read the raw text, as a conforming generator must.

## Revision history

- **r1** (2026-11-17): first draft.
- **r2** (2026-11-20), after KyttoMCP's review. The rules stay at version 1 because this is still a draft and no implementation stores the hashes yet, but every r1 hash changed.
  - The top-level `title` is in the canonical object. Vectors 1–4 changed because of it.
  - One rule for text: every string member named `title` or `description` (top level, `annotations`, anywhere in `inputSchema` except below `default`/`const`/`enum`/`examples`) is canonical text. r1 canonicalized only the tool description and applied NFC elsewhere; `annotations.title` is no longer taken as received.
  - One rule for invalid input: not I-JSON (duplicate key, lone surrogate, non-finite number), an integer literal beyond ±(2^53−1), or deeper than 64 levels means unhashable, with a fail-safe `unknown` verdict. Previously undefined.
  - Consumers MUST NOT auto-approve an unhashable tool or treat it as unchanged, and SHOULD show the reason.
  - Numbers: nearest binary64, serialized as in RFC 8785 (ECMAScript `Number::toString`); no decimal or big-integer types. r1 was exact only for integers and simple decimals. `123456789012345680000` moved from vector 5 to vector 17 (`number-precision`).
  - Member names and `required` elements are no longer NFC-normalized. They are identifiers, and r1 could make `required` disagree with the property names it lists.
  - Confirmed: the whole `inputSchema` is hashed, so `default`, `examples`, `$comment` and `x-*` are covered.
  - Rule ids are namespaced per generator, plus a small `shared/` set. Consumer guidance on conflicting evidence, overrides in a separate file, `arguments[]` optional, `outputSchema` out of the hash, spec location.
  - Vectors 5–18, and `crosscheck.ts`: every vector is checked by two independent implementations.
