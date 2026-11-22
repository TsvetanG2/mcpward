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

import { toolOfResult, type CheckReport, type CheckResult } from './model.js';
import { wordDiff, markInvisibleCharacters } from './text-diff.js';
import { DRIFT_CLASSES } from '../config/schema.js';

/** Hidden marker used to find and update our own comment instead of stacking new ones. */
export const MARKDOWN_REPORT_MARKER = '<!-- mcpward-report -->';

/** Sections with more findings than this are collapsed behind <details>. */
const COLLAPSE_AFTER = 5;
/**
 * Cap for server-controlled text in the comment, counted after invisible characters are marked
 * and Markdown is escaped: each side of a description, a finding's message and its location.
 * The JSON report has the full text.
 */
const MAX_DESCRIPTION_CHARS = 1000;
/** The same cap for the server's name, version and protocol in the heading. */
const MAX_HEADER_CHARS = 200;

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
  let out = '';
  // Word by word, in linear time: the regex this replaces (`\S*@\S*` and a scheme before
  // `://`) backtracked over the rest of the word from every position, quadratic on a long word
  for (const part of flat.split(/(\s+)/)) {
    const at = /^\s/.test(part) ? -1 : linkStart(part);
    out +=
      at < 0 ? escapeInline(part) : escapeInline(part.slice(0, at)) + inlineCode(part.slice(at));
  }
  return out;
}

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;

/**
 * Where, in a word without whitespace, a token GitHub would turn into a link or mention starts:
 * the whole word when it holds an "@", else the first URL (`scheme://` and more) or `www.`
 * host, which runs to the end of the word. -1 for none.
 */
function linkStart(word: string): number {
  if (word.includes('@')) return 0;
  let start = -1;
  // Each `://` is walked back over scheme characters only; the walks never overlap (a `/` ends
  // one), so this is linear. The first `://` that has a scheme gives the earliest start.
  for (let q = word.indexOf('://'); q >= 0 && q + 3 < word.length; q = word.indexOf('://', q + 1)) {
    let p = q;
    while (p > 0 && SCHEME_CHAR.test(word.charAt(p - 1))) p--;
    while (p < q && !LETTER.test(word.charAt(p))) p++;
    if (p < q) {
      start = p;
      break;
    }
  }
  const www = word.search(/www\./i);
  if (www >= 0 && www + 4 < word.length && (start < 0 || www < start)) start = www;
  return start;
}

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
  let longest = 2;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${content}\n${fence}`;
}

const TRUNCATED = '… (truncated; the console output and the JSON report have the full text)';

/**
 * `render(text)`, cut to {@link MAX_DESCRIPTION_CHARS} rendered characters. The raw text is cut
 * (at a code point) before rendering, so no marker or escape is split, and the length counts
 * what the comment holds: a U+200B is 8 characters once marked, and a raw cap let three
 * findings of them fill the 65 000-character comment and push every later one out.
 */
function capRendered(
  text: string,
  render: (text: string) => string,
  max = MAX_DESCRIPTION_CHARS,
  suffix = TRUNCATED
): string {
  // Rendered text is at least half as long (`\r\n` → one space is the only shortening), so a
  // longer text cannot fit and is not rendered whole
  if (text.length <= max * 2) {
    const full = render(text);
    if (full.length <= max) return full;
  }
  // At most `max` code points can fit. Each round cuts in proportion to how much rendering
  // lengthened the text, so a finding takes a render or two, not a search over prefixes
  let chars = Array.from(text.slice(0, max * 2)).slice(0, max);
  for (;;) {
    const out = render(chars.join(''));
    if (out.length <= max) return out + suffix;
    chars = chars.slice(0, Math.floor((chars.length * max) / out.length));
  }
}

const STATUS_ICON: Record<string, string> = { fail: '❌', warn: '⚠️', skip: '⏭️', pass: '✅' };
const DESCRIPTION_HASH = /^sha256:[0-9a-f]{64}$/;

const isHash = (v: unknown) => typeof v === 'string' && DESCRIPTION_HASH.test(v);

/**
 * Text of one side of a description_changed: absent is empty (a title added where there was
 * none), and a non-string value (`examples`, an `x-*` object) is shown as JSON.
 */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

/** A diff code block for description_changed, with invisible characters made visible. */
function renderDescriptionChange(result: CheckResult): string | null {
  if (isHash(result.expected) || isHash(result.actual)) {
    return '_Full text unavailable (`full_text` disabled or v1 baseline) — re-run `mcpward baseline` to see a diff._';
  }
  const prev = asText(result.expected);
  const curr = asText(result.actual);
  if (prev === curr) return null;

  const lines: string[] = [];
  const segments = wordDiff(prev, curr);
  if (segments && prev.length <= MAX_DESCRIPTION_CHARS && curr.length <= MAX_DESCRIPTION_CHARS) {
    const inline = segments
      .map((s) => {
        const t = markInvisibleCharacters(s.text);
        return s.kind === 'removed' ? `[-${t}-]` : s.kind === 'added' ? `{+${t}+}` : t;
      })
      .join('');
    // Both sides fit, but marked invisibles can still make the word diff long: leave it out
    if (inline.length <= MAX_DESCRIPTION_CHARS * 2) {
      lines.push(codeBlock('text', inline.replace(/\r?\n/g, '\n')));
    }
  }
  const asDiffLines = (prefix: string, text: string) =>
    capRendered(text, (t) =>
      markInvisibleCharacters(t)
        .split(/\r?\n/)
        .map((l) => `${prefix} ${l}`)
        .join('\n')
    );
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
  // Capped like descriptions: one server-controlled message or location of any length would
  // otherwise push every later finding out of the comment, which GitHub limits to 64 KB
  const where = result.location ? ` — ${capRendered(result.location, inlineCode)}` : '';
  const head = `- ${icon} **${result.id}**${where}: ${capRendered(result.message, escapeMarkdown)}`;
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

/**
 * Room in the comment, in rendered characters. GitHub cuts the comment at 65 000; the heading
 * and the layout stay well below the remainder. Each finding is already capped
 * (`capRendered`), but their number is not, and a hostile server picks how many there are.
 */
const INDEX_BUDGET = 6_000;
const LIST_BUDGET = 12_000;
const FINDINGS_BUDGET = 36_000;
/** Cap for a tool name in the index and a location in the list at the top. */
const MAX_INDEX_TOOL_CHARS = 40;
const MAX_LIST_LOCATION_CHARS = 120;

/** Where the reader finds what the comment left out. */
const FULL_REPORT = 'the console output (job log) and the JSON report have all of them';

const statusRank = (r: CheckResult) => STATUS_ORDER[r.status] ?? 9;
const iconOf = (r: CheckResult) => (r.status === 'pass' ? 'ℹ️' : (STATUS_ICON[r.status] ?? '•'));

/** One notable result, by its position: the same result object may occur more than once. */
interface Entry {
  index: number;
  result: CheckResult;
  tool: string;
}

/**
 * Which entries fit in `budget`. Failures come first across all tools, then warnings, then
 * reported changes: a run that is red shows what made it red. Within a status, tools take
 * turns, one entry per tool per round, tools with fewer findings first. A tool cannot hide
 * another by having more findings, longer ones, or a smaller share; with more tools than
 * room, the cut falls in the last round and the rest is counted.
 */
function allot(entries: Entry[], sizeOf: (e: Entry) => number, budget: number): Set<number> {
  const kept = new Set<number>();
  let left = budget;
  const ranks = [...new Set(entries.map((e) => statusRank(e.result)))].sort((a, b) => a - b);
  for (const rank of ranks) {
    const byTool = new Map<string, Entry[]>();
    for (const e of entries) {
      if (statusRank(e.result) !== rank) continue;
      let q = byTool.get(e.tool);
      if (!q) byTool.set(e.tool, (q = []));
      q.push(e);
    }
    // Fewer findings first, then the shorter first entry: as many tools as possible get room
    const first = (q: Entry[]) => (q[0] ? sizeOf(q[0]) : 0);
    let queues = [...byTool.values()].sort((a, b) => a.length - b.length || first(a) - first(b));
    for (let round = 0; queues.length > 0 && left > 0; round++) {
      const next: Entry[][] = [];
      for (const q of queues) {
        const e = q[round];
        if (!e) continue;
        const size = sizeOf(e);
        // An entry that does not fit ends this tool's turns; a smaller one elsewhere may fit
        if (size > left) continue;
        kept.add(e.index);
        left -= size;
        if (round + 1 < q.length) next.push(q);
      }
      queues = next;
    }
  }
  return kept;
}

const notShown = (n: number) => `- … ${n} more finding(s) not shown — ${FULL_REPORT}`;

/**
 * One line naming every tool with findings: worst status, name, count. Bounded like the rest;
 * tools that do not fit are counted with their findings.
 */
function renderIndex(entries: Entry[]): string {
  const tools = new Map<string, { worst: CheckResult; count: number }>();
  for (const e of entries) {
    const t = tools.get(e.tool);
    if (!t) tools.set(e.tool, { worst: e.result, count: 1 });
    else {
      t.count++;
      if (statusRank(e.result) < statusRank(t.worst)) t.worst = e.result;
    }
  }
  // Worst status first, then fewer findings, then the shorter entry: as many tools as fit
  const items = [...tools].map(([tool, { worst, count }]) => {
    const name =
      tool === '' ? '(server)' : capRendered(tool, inlineCode, MAX_INDEX_TOOL_CHARS, '…');
    return { worst, count, part: `${iconOf(worst)} ${name} ${count}` };
  });
  items.sort(
    (a, b) =>
      statusRank(a.worst) - statusRank(b.worst) ||
      a.count - b.count ||
      a.part.length - b.part.length
  );
  const parts: string[] = [];
  let used = 0;
  let omittedTools = 0;
  let omittedFindings = 0;
  for (const { part, count } of items) {
    if (used + part.length + 3 > INDEX_BUDGET) {
      omittedTools++;
      omittedFindings += count;
      continue;
    }
    parts.push(part);
    used += part.length + 3;
  }
  if (omittedTools > 0) {
    parts.push(
      `… ${omittedTools} more tool(s) with ${omittedFindings} finding(s) — ${FULL_REPORT}`
    );
  }
  return parts.join(' · ');
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
  // Name, version and protocol come from the server: capped like a finding, or a name of 9 000
  // zero-width spaces (45 000 characters once marked) pushes every finding out of the comment
  const { server } = report;
  out.push(
    `**Server:** ${capRendered(server.name, inlineCode, MAX_HEADER_CHARS)} ` +
      `v${capRendered(server.version, escapeMarkdown, MAX_HEADER_CHARS)} · ` +
      `**Protocol:** ${capRendered(server.protocolVersion, escapeMarkdown, MAX_HEADER_CHARS)} · ` +
      `**mcpward** v${escapeMarkdown(report.version)}`
  );
  out.push('');
  out.push('| Passed | Failed | Warnings | Skipped | Total |');
  out.push('|---:|---:|---:|---:|---:|');
  out.push(
    `| ${summary.passed} | ${summary.failed} | ${summary.warnings} | ${summary.skipped} | ${summary.total} |`
  );

  // Failures, warnings and every contract change
  const entries: Entry[] = report.results
    .filter((r) => r.status === 'fail' || r.status === 'warn' || isContractChange(r))
    .map((result, index) => ({ index, result, tool: toolOfResult(result) }));
  // Render every finding once; the budget then decides which of them fit
  const texts = entries.map((e) => renderFinding(e.result));
  const shown = allot(entries, (e) => (texts[e.index] ?? '').length + 1, FINDINGS_BUDGET);

  // An overview first when there are many findings or some did not fit below: every tool by
  // name and count, then every finding by id and location, both bounded the same way
  if (entries.length > COLLAPSE_AFTER || shown.size < entries.length) {
    out.push('');
    out.push(`**Findings by tool:** ${renderIndex(entries)}`);
    const lines = entries.map((e) => {
      const where = e.result.location
        ? ` — ${capRendered(e.result.location, inlineCode, MAX_LIST_LOCATION_CHARS)}`
        : '';
      return `- ${iconOf(e.result)} ${e.result.id}${where}`;
    });
    const listed = allot(entries, (e) => (lines[e.index] ?? '').length + 1, LIST_BUDGET);
    out.push('');
    out.push(`**All findings (${entries.length}):**`);
    out.push('');
    // Failures first, as allotted
    const order = [...entries].sort((a, b) => statusRank(a.result) - statusRank(b.result));
    for (const e of order) if (listed.has(e.index)) out.push(lines[e.index] ?? '');
    if (listed.size < entries.length) out.push(notShown(entries.length - listed.size));
  }

  const families = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = families.get(e.result.family) ?? [];
    list.push(e);
    families.set(e.result.family, list);
  }

  for (const [family, list] of families) {
    list.sort((a, b) => statusRank(a.result) - statusRank(b.result));
    const fails = list.filter((e) => e.result.status === 'fail').length;
    const warns = list.filter((e) => e.result.status === 'warn').length;
    const changes = list.length - fails - warns;
    const counts = [
      fails ? `${fails} failed` : '',
      warns ? `${warns} warning(s)` : '',
      changes ? `${changes} change(s) reported` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const lines = list.filter((e) => shown.has(e.index)).map((e) => texts[e.index] ?? '');
    if (lines.length < list.length) lines.push(notShown(list.length - lines.length));
    const body = lines.join('\n');

    out.push('');
    if (list.length > COLLAPSE_AFTER) {
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

  if (entries.length === 0) {
    out.push('');
    out.push('No failures, warnings or contract changes.');
  }

  out.push('');
  out.push(
    '<sub>Generated by [mcpward](https://github.com/TsvetanG2/mcpward) — black-box security & contract testing for MCP servers.</sub>'
  );
  return out.join('\n') + '\n';
}
