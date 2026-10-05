/**
 * Markdown reporter (M5, #13).
 *
 * Renders the SAME redacted report model as every other reporter — callers must run
 * redactReport() first; this module never builds a parallel formatter for raw data.
 * Used for the GitHub PR comment and works anywhere Markdown renders (e.g. the Actions
 * job summary via `--reporter markdown --out "$GITHUB_STEP_SUMMARY"`).
 *
 * Everything that originates from the server under test (tool names, descriptions, messages)
 * is UNTRUSTED: it is escaped so it cannot inject HTML, links, or @-mentions into the PR.
 */

import type { CheckReport, CheckResult } from './model.js';
import { wordDiff, markInvisibleCharacters } from './text-diff.js';
import { DRIFT_CLASSES } from '../config/schema.js';

/** Hidden marker used to find and update our own comment instead of stacking new ones. */
export const MARKDOWN_REPORT_MARKER = '<!-- mcpward-report -->';

/** Sections with more findings than this are collapsed behind <details>. */
const COLLAPSE_AFTER = 5;
/** Per-side cap for description text in the comment; the JSON report has the full text. */
const MAX_DESCRIPTION_CHARS = 1000;

/**
 * Escapes untrusted text for inline Markdown: HTML, Markdown punctuation, and @-mentions
 * (an entity renders as "@" but does not notify anyone). Newlines become spaces so a
 * value cannot break out of a table cell or list item.
 *
 * GitHub also autolinks bare URLs, `www.` hosts and e-mail addresses, and resolves
 * @-mentions, after escaping. Those tokens are therefore rendered as inline code, where
 * neither autolinks nor mentions apply.
 *
 * Order matters: Markdown punctuation is escaped BEFORE entities are introduced, otherwise
 * the `#` in `&#64;` would itself be escaped and the entity would break.
 */
export function escapeMarkdown(text: string): string {
  const flat = markInvisibleCharacters(text).replace(/\r?\n|\r/g, ' ');
  return flat
    .split(LINKISH)
    .map((part, i) => (i % 2 === 1 ? inlineCode(part) : escapeInline(part)))
    .join('');
}

/** Tokens GitHub would turn into links or mentions: URLs, www. hosts, anything with an "@". */
const LINKISH = /((?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\S*@\S*)/gi;

function escapeInline(text: string): string {
  return text
    .replace(/[\\`*_{}[\]()#|~]/g, (c) => '\\' + c)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;');
}

/** Inline code span for untrusted identifiers: no backticks, no line breaks, invisibles marked. */
function inlineCode(text: string): string {
  return (
    '`' +
    markInvisibleCharacters(text)
      .replace(/`/g, "'")
      .replace(/\r?\n|\r/g, ' ') +
    '`'
  );
}

/** Fenced code block whose fence is longer than any backtick run in the content. */
function codeBlock(lang: string, content: string): string {
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${content}\n${fence}`;
}

function truncate(text: string): string {
  return text.length <= MAX_DESCRIPTION_CHARS
    ? text
    : `${text.slice(0, MAX_DESCRIPTION_CHARS)}… (truncated, see JSON report for full text)`;
}

const STATUS_ICON: Record<string, string> = { fail: '❌', warn: '⚠️', skip: '⏭️', pass: '✅' };
const DESCRIPTION_HASH = /^sha256:[0-9a-f]{64}$/;

/** A diff code block for description_changed, with invisible characters made visible. */
function renderDescriptionChange(result: CheckResult): string | null {
  const prev = result.expected;
  const curr = result.actual;
  if (typeof prev !== 'string' || typeof curr !== 'string') return null;
  if (DESCRIPTION_HASH.test(prev) || DESCRIPTION_HASH.test(curr)) {
    return '_Full text unavailable (`full_text` disabled or v1 baseline) — re-run `mcpward baseline` to see a diff._';
  }

  const lines: string[] = [];
  const segments = wordDiff(prev, curr);
  if (segments && prev.length <= MAX_DESCRIPTION_CHARS && curr.length <= MAX_DESCRIPTION_CHARS) {
    const inline = segments
      .map((s) => {
        const t = markInvisibleCharacters(s.text);
        return s.kind === 'removed' ? `[-${t}-]` : s.kind === 'added' ? `{+${t}+}` : t;
      })
      .join('');
    lines.push(codeBlock('text', inline.replace(/\r?\n/g, '\n')));
  }
  const asDiffLines = (prefix: string, text: string) =>
    markInvisibleCharacters(truncate(text))
      .split(/\r?\n/)
      .map((l) => `${prefix} ${l}`)
      .join('\n');
  lines.push(codeBlock('diff', `${asDiffLines('-', prev)}\n${asDiffLines('+', curr)}`));
  return lines.join('\n\n');
}

const DRIFT_CHANGE_IDS = new Set<string>(DRIFT_CLASSES.map((c) => `drift/${c}`));

/**
 * A drift change is worth showing in a PR even when it does not fail the run: with
 * `fail_on: high`, a breaking schema change is reported as `pass` — the reviewer still
 * needs to see that the contract changed.
 */
function isContractChange(result: CheckResult): boolean {
  return result.family === 'drift' && DRIFT_CHANGE_IDS.has(result.id);
}

const STATUS_ORDER: Record<string, number> = { fail: 0, warn: 1, pass: 2, skip: 3 };

function renderFinding(result: CheckResult): string {
  const icon = result.status === 'pass' ? 'ℹ️' : (STATUS_ICON[result.status] ?? '•');
  const where = result.location ? ` — ${inlineCode(result.location)}` : '';
  const head = `- ${icon} **${result.id}**${where}: ${escapeMarkdown(result.message)}`;
  if (result.id === 'drift/description_changed') {
    const diff = renderDescriptionChange(result);
    if (diff) {
      const indented = diff
        .split('\n')
        .map((l) => (l === '' ? '' : `  ${l}`))
        .join('\n');
      return `${head}\n\n${indented}\n`;
    }
  }
  return head;
}

function familyTitle(family: string): string {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

/** Renders the report as Markdown. Pass/info results are summarized, not listed. */
export function renderMarkdownReport(report: CheckReport): string {
  const { summary } = report;
  const failed = summary.failed > 0;
  const out: string[] = [MARKDOWN_REPORT_MARKER];

  out.push(
    `## ${failed ? '❌' : '✅'} mcpward: ${failed ? `${summary.failed} check(s) failed` : summary.warnings > 0 ? 'passed with warnings' : 'all checks passed'}`
  );
  out.push('');
  out.push(
    `**Server:** ${inlineCode(report.server.name)} v${escapeMarkdown(report.server.version)} · ` +
      `**Protocol:** ${escapeMarkdown(report.server.protocolVersion)} · **mcpward** v${escapeMarkdown(report.version)}`
  );
  out.push('');
  out.push('| Passed | Failed | Warnings | Skipped | Total |');
  out.push('|---:|---:|---:|---:|---:|');
  out.push(
    `| ${summary.passed} | ${summary.failed} | ${summary.warnings} | ${summary.skipped} | ${summary.total} |`
  );

  // Group failures, warnings and every contract change by family; failures first
  const notable = report.results.filter(
    (r) => r.status === 'fail' || r.status === 'warn' || isContractChange(r)
  );
  const families = new Map<string, CheckResult[]>();
  for (const r of notable) {
    const list = families.get(r.family) ?? [];
    list.push(r);
    families.set(r.family, list);
  }

  for (const [family, results] of families) {
    results.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
    const fails = results.filter((r) => r.status === 'fail').length;
    const warns = results.filter((r) => r.status === 'warn').length;
    const changes = results.length - fails - warns;
    const counts = [
      fails ? `${fails} failed` : '',
      warns ? `${warns} warning(s)` : '',
      changes ? `${changes} change(s) reported` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const body = results.map(renderFinding).join('\n');

    out.push('');
    if (results.length > COLLAPSE_AFTER) {
      out.push(
        `<details${fails > 0 ? ' open' : ''}><summary><b>${familyTitle(family)}</b> (${counts})</summary>`
      );
      out.push('');
      out.push(body);
      out.push('');
      out.push('</details>');
    } else {
      out.push(`### ${familyTitle(family)} (${counts})`);
      out.push('');
      out.push(body);
    }
  }

  if (notable.length === 0) {
    out.push('');
    out.push('No failures, warnings or contract changes.');
  }

  out.push('');
  out.push(
    '<sub>Generated by [mcpward](https://github.com/TsvetanG2/mcpward) — black-box security & contract testing for MCP servers.</sub>'
  );
  return out.join('\n') + '\n';
}
