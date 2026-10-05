/**
 * Markdown reporter + GitHub PR comment tests (M5).
 *
 * Server-controlled text must not be able to inject HTML, links or @-mentions into a PR,
 * re-runs must update one comment instead of stacking, and outside a PR nothing happens.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  renderMarkdownReport,
  escapeMarkdown,
  MARKDOWN_REPORT_MARKER,
} from '../../src/report/markdown.js';
import { detectPrContext, upsertPrComment, type PrContext } from '../../src/report/github.js';
import { redactString, clearSecrets } from '../../src/report/redact.js';
import type { CheckReport, CheckResult } from '../../src/report/model.js';

function report(results: CheckResult[]): CheckReport {
  return {
    version: '0.0.0',
    timestamp: 't',
    server: { name: 'srv', version: '1.0.0', protocolVersion: '2025-11-25' },
    summary: {
      total: results.length,
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail').length,
      warnings: results.filter((r) => r.status === 'warn').length,
      skipped: 0,
    },
    results,
  };
}

const finding = (over: Partial<CheckResult>): CheckResult => ({
  id: 'security/injection-pattern',
  family: 'security',
  status: 'fail',
  severity: 'error',
  message: 'm',
  ...over,
});

describe('escapeMarkdown (untrusted server text)', () => {
  it('neutralizes HTML, links, mentions and line breaks', () => {
    const out = escapeMarkdown(
      '<img src=x onerror=alert(1)> [click](https://evil.example) @org/security\nnext'
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('](');
    expect(out).not.toContain('@org');
    expect(out).toContain('&#64;org');
    expect(out).not.toContain('\n');
  });

  it('marks invisible characters', () => {
    expect(escapeMarkdown('a\u200Bb')).toBe('a<U+200B>b'.replace('<', '&lt;').replace('>', '&gt;'));
  });
});

describe('renderMarkdownReport', () => {
  it('escapes a malicious tool name used as location', () => {
    const md = renderMarkdownReport(report([finding({ location: 'evil`\n# heading @team' })]));
    expect(md).toContain("`evil' # heading @team`");
    expect(md).not.toMatch(/^# heading/m);
  });

  it('renders description_changed as a diff with visible zero-width characters', () => {
    const md = renderMarkdownReport(
      report([
        finding({
          id: 'drift/description_changed',
          family: 'drift',
          expected: 'Reads a file.',
          actual: 'Reads a\u200B file.',
          location: 'read_file',
        }),
      ])
    );
    expect(md).toContain('```diff');
    expect(md).toContain('- Reads a file.');
    expect(md).toContain('+ Reads a<U+200B> file.');
  });

  it('uses a longer fence when the description contains backticks', () => {
    const md = renderMarkdownReport(
      report([
        finding({
          id: 'drift/description_changed',
          family: 'drift',
          expected: 'old ```x```',
          actual: 'new ```y```',
        }),
      ])
    );
    expect(md).toContain('````diff');
  });

  it('collapses long sections behind <details>, open when something failed', () => {
    const many = Array.from({ length: 6 }, (_, i) => finding({ location: `t${i}` }));
    expect(renderMarkdownReport(report(many))).toContain('<details open><summary><b>Security</b>');
  });

  it('lists only fail/warn results', () => {
    const md = renderMarkdownReport(
      report([
        finding({ status: 'pass', id: 'compliance/ping', family: 'compliance', message: 'PINGOK' }),
      ])
    );
    expect(md).not.toContain('PINGOK');
    expect(md).toContain('No failures or warnings.');
  });
});

describe('detectPrContext', () => {
  afterEach(() => clearSecrets());
  const event = (payload: unknown) => () => JSON.stringify(payload);

  it('needs a token', () => {
    expect(detectPrContext({ GITHUB_REPOSITORY: 'o/r' })).toEqual({
      reason: expect.stringContaining('no token'),
    });
  });

  it('is not a PR context on push events', () => {
    const ctx = detectPrContext(
      { GITHUB_TOKEN: 'tok-123456', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: '/e.json' },
      event({ ref: 'refs/heads/main' })
    );
    expect(ctx).toEqual({ reason: 'this run is not for a pull request' });
  });

  it('reads the PR number from the event and registers the token as a secret', () => {
    const ctx = detectPrContext(
      { GITHUB_TOKEN: 'ghs_supersecret', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: '/e.json' },
      event({ pull_request: { number: 42 } })
    );
    expect(ctx).toEqual({
      apiUrl: 'https://api.github.com',
      repo: 'o/r',
      prNumber: 42,
      token: 'ghs_supersecret',
    });
    expect(redactString('token=ghs_supersecret')).not.toContain('ghs_supersecret');
  });

  it('rejects a malformed repository slug', () => {
    expect(
      detectPrContext({
        GITHUB_TOKEN: 'tok-123456',
        GITHUB_REPOSITORY: '../../x',
        MCPWARD_PR_NUMBER: '1',
      })
    ).toEqual({
      reason: expect.stringContaining('GITHUB_REPOSITORY'),
    });
  });
});

describe('upsertPrComment', () => {
  const ctx: PrContext = { apiUrl: 'https://api.example', repo: 'o/r', prNumber: 7, token: 't' };

  /** Fake GitHub: `pages` of existing comments; records every request. */
  function fakeGitHub(pages: { id: number; body: string }[][], patchStatus = 200) {
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body as string | undefined });
      if (method === 'GET') {
        const page = Number(new URL(url).searchParams.get('page'));
        return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
      }
      if (method === 'PATCH') return new Response('{}', { status: patchStatus });
      return new Response('{}', { status: 201 });
    };
    return { calls, fetchImpl };
  }

  it('creates a comment when none carries the marker', async () => {
    const gh = fakeGitHub([[{ id: 1, body: 'lgtm' }]]);
    expect(await upsertPrComment(ctx, `${MARKDOWN_REPORT_MARKER}\nbody`, gh.fetchImpl)).toBe(
      'created'
    );
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(gh.calls[1]?.url).toBe('https://api.example/repos/o/r/issues/7/comments');
  });

  it('updates the existing marked comment instead of stacking (found on page 2)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'chatter' }));
    const gh = fakeGitHub([page1, [{ id: 555, body: `${MARKDOWN_REPORT_MARKER}\nold` }]]);
    expect(await upsertPrComment(ctx, `${MARKDOWN_REPORT_MARKER}\nnew`, gh.fetchImpl)).toBe(
      'updated'
    );
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(gh.calls[2]?.url).toBe('https://api.example/repos/o/r/issues/comments/555');
  });

  it('falls back to a new comment when the marked one is not ours (403)', async () => {
    const gh = fakeGitHub([[{ id: 9, body: `quoting ${MARKDOWN_REPORT_MARKER}` }]], 403);
    expect(await upsertPrComment(ctx, MARKDOWN_REPORT_MARKER, gh.fetchImpl)).toBe('created');
  });

  it('truncates bodies over GitHub’s limit with an explicit notice', async () => {
    const gh = fakeGitHub([[]]);
    await upsertPrComment(ctx, MARKDOWN_REPORT_MARKER + 'x'.repeat(70000), gh.fetchImpl);
    const sent = JSON.parse(gh.calls[1]?.body ?? '{}') as { body: string };
    expect(sent.body.length).toBeLessThan(65536);
    expect(sent.body).toContain('report truncated');
  });

  it('surfaces API failures as errors', async () => {
    const fetchImpl = async () => new Response('nope', { status: 500 });
    await expect(upsertPrComment(ctx, 'x', fetchImpl)).rejects.toThrow(/HTTP 500/);
  });
});
