/**
 * GitHub PR comment publishing (M5, #13).
 *
 * Opt-in (needs a token with PR write scope). Upserts ONE comment per PR, found by the
 * hidden marker, so re-runs update it instead of stacking. Outside a PR context it reports
 * why and does nothing — the normal report still prints, the exit code is unchanged.
 *
 * The body comes from renderMarkdownReport over the already-redacted report model; the
 * token is registered as a secret so it can never appear in any output.
 */

import { MARKDOWN_REPORT_MARKER } from './markdown.js';
import { registerSecret } from './redact.js';

/** GitHub rejects comment bodies over 65536 characters. */
const MAX_COMMENT_CHARS = 65000;
/** Upper bound on comment pages scanned for our marker (100 per page). */
const MAX_COMMENT_PAGES = 30;

export interface PrContext {
  apiUrl: string;
  repo: string;
  prNumber: number;
  token: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Detects the PR to comment on from the GitHub Actions environment.
 * Returns `{ reason }` when not in a usable PR context.
 *
 * Token: MCPWARD_GITHUB_TOKEN, else GITHUB_TOKEN. PR number: MCPWARD_PR_NUMBER (the action
 * passes `github.event.pull_request.number`, which also covers pull_request_target), else
 * GITHUB_REF of a `pull_request` run (`refs/pull/<n>/merge`). Only environment variables are
 * read — nothing from disk flows into the request URL.
 */
export function detectPrContext(
  env: NodeJS.ProcessEnv = process.env
): PrContext | { reason: string } {
  const token = env.MCPWARD_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    return {
      reason: 'no token (set GITHUB_TOKEN or MCPWARD_GITHUB_TOKEN with pull-requests: write)',
    };
  }
  registerSecret(token);

  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { reason: 'GITHUB_REPOSITORY is not set — not running in GitHub Actions' };
  }

  const fromRef = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1];
  const prNumber = Number(env.MCPWARD_PR_NUMBER || fromRef);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { reason: 'this run is not for a pull request' };
  }

  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  return { apiUrl, repo, prNumber, token };
}

function truncateBody(body: string): string {
  if (body.length <= MAX_COMMENT_CHARS) return body;
  return (
    body.slice(0, MAX_COMMENT_CHARS) +
    "\n\n_… report truncated to fit GitHub's comment limit — see the JSON/SARIF report artifact for everything._\n"
  );
}

/** Author of comments posted with the Actions GITHUB_TOKEN (which cannot call GET /user). */
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';

/**
 * Creates or updates the mcpward comment on the PR.
 *
 * Only OUR comment is ever edited: it must start with the marker AND be authored by the
 * token's own identity. A maintainer's token can edit anyone's comment, so matching on the
 * marker alone would let a human comment that quotes it be overwritten. Anything that does
 * not qualify gets a fresh comment instead.
 */
export async function upsertPrComment(
  ctx: PrContext,
  markdown: string,
  fetchImpl: FetchLike = fetch
): Promise<'created' | 'updated'> {
  const body = truncateBody(markdown);
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${ctx.token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mcpward',
  };
  const base = `${ctx.apiUrl}/repos/${ctx.repo}`;

  // Our identity: GET /user works for user tokens; installation tokens get 403 → Actions bot.
  const me = await fetchImpl(`${ctx.apiUrl}/user`, { headers })
    .then(async (r) => (r.ok ? ((await r.json()) as { login?: string }).login : undefined))
    .catch(() => undefined);
  const myLogin = me ?? ACTIONS_BOT_LOGIN;

  let existingId: number | undefined;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await fetchImpl(
      `${base}/issues/${ctx.prNumber}/comments?per_page=100&page=${page}`,
      {
        headers,
      }
    );
    if (!res.ok) throw new Error(`listing PR comments failed: HTTP ${res.status}`);
    const comments = (await res.json()) as {
      id: number;
      body?: string;
      user?: { login?: string };
    }[];
    for (const c of comments) {
      const ours =
        typeof c.body === 'string' &&
        c.body.startsWith(MARKDOWN_REPORT_MARKER) &&
        c.user?.login === myLogin;
      if (ours) existingId = c.id;
    }
    if (comments.length < 100) break;
  }

  if (existingId !== undefined) {
    const res = await fetchImpl(`${base}/issues/comments/${existingId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    });
    if (res.ok) return 'updated';
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`updating PR comment failed: HTTP ${res.status}`);
    }
  }

  const res = await fetchImpl(`${base}/issues/${ctx.prNumber}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`creating PR comment failed: HTTP ${res.status}`);
  return 'created';
}
