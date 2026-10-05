/**
 * Description collision lint (M4, #22 + #23).
 *
 * Two tools with near-identical descriptions but different accepted payloads: an agent
 * that selects tools by description (increasingly via retrieval/embeddings) picks one
 * confidently and wrong, and no success/error check can see it.
 *
 * THE GATE IS THE FEATURE. A pair is flagged only when BOTH hold:
 *   1. description similarity ≥ threshold, AND
 *   2. input schemas DIVERGE.
 * Similarity alone flags legitimate tool families (list_users / list_projects) and trains
 * users to ignore the check — the cry-wolf failure M0 exists to eliminate.
 *
 * "Diverge" (first cut, behind an interface so it can deepen):
 *   - required-shape: the multiset of required-parameter TYPES differs. Names are ignored on
 *     purpose: get_user(user_id: string) / get_project(project_id: string) is a family, not a
 *     collision. One tool requiring an object where the other requires a scalar is.
 *   - depth: maximum object-nesting depth differs (nested filter object vs flat scalars).
 *
 * This is a lint on a single surface: no baseline needed, usable on first contact.
 */

import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import { listAllTools } from '../client/tools.js';
import { schemaNestingDepth } from '../surface/canonical.js';
import type { Tool, JsonSchema } from './schema.js';
import { trigramDiceScorer, type SimilarityScorer } from './similarity.js';

export const DEFAULT_COLLISION_THRESHOLD = 0.8;
export const DEFAULT_COLLISION_MAX_TOOLS = 500;

export type DivergenceReason =
  { kind: 'required-shape'; a: string[]; b: string[] } | { kind: 'depth'; a: number; b: number };

/** Decides whether two input schemas accept materially different payloads. */
export type DivergencePredicate = (
  a: JsonSchema | undefined,
  b: JsonSchema | undefined
) => DivergenceReason[];

export interface CollisionFinding {
  a: string;
  b: string;
  similarity: number;
  scorer: string;
  reasons: DivergenceReason[];
}

export interface CollisionOptions {
  threshold?: number;
  scorer?: SimilarityScorer;
  divergence?: DivergencePredicate;
}

/** Sorted JSON types of the required parameters (`any` when a property declares no type). */
export function requiredShape(schema: JsonSchema | undefined): string[] {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const props = (schema?.properties ?? {}) as Record<string, { type?: unknown } | undefined>;
  return required
    .map((name) => {
      const type = props[name]?.type;
      if (Array.isArray(type)) return [...type].sort().join('|');
      return typeof type === 'string' ? type : 'any';
    })
    .sort();
}

/** Default divergence predicate: required-shape OR nesting depth. */
export const requiredShapeOrDepth: DivergencePredicate = (a, b) => {
  const reasons: DivergenceReason[] = [];
  const ra = requiredShape(a);
  const rb = requiredShape(b);
  if (ra.join(',') !== rb.join(',')) {
    reasons.push({ kind: 'required-shape', a: ra, b: rb });
  }
  const da = schemaNestingDepth(a ?? null);
  const db = schemaNestingDepth(b ?? null);
  if (da !== db) {
    reasons.push({ kind: 'depth', a: da, b: db });
  }
  return reasons;
};

/**
 * Finds colliding tool pairs. Pure function; O(n²) over pairs — callers cap n.
 * Tools without a description are skipped (the schema check already reports those).
 * A tool whose schema cannot be walked (too deep / cyclic) is skipped rather than guessed at.
 */
export function findCollisions(tools: Tool[], options: CollisionOptions = {}): CollisionFinding[] {
  const threshold = options.threshold ?? DEFAULT_COLLISION_THRESHOLD;
  const scorer = options.scorer ?? trigramDiceScorer;
  const divergence = options.divergence ?? requiredShapeOrDepth;
  const candidates = tools.filter(
    (t) => typeof t.description === 'string' && t.description.trim() !== ''
  );
  const findings: CollisionFinding[] = [];

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (!a || !b) continue;

      const similarity = scorer.score(a.description ?? '', b.description ?? '');
      if (similarity < threshold) continue;

      let reasons: DivergenceReason[];
      try {
        reasons = divergence(a.inputSchema, b.inputSchema);
      } catch {
        continue;
      }
      if (reasons.length === 0) continue;

      const [first, second] = a.name <= b.name ? [a.name, b.name] : [b.name, a.name];
      const ordered =
        first === a.name
          ? reasons
          : reasons.map((r) => ({ ...r, a: r.b, b: r.a }) as DivergenceReason);
      findings.push({ a: first, b: second, similarity, scorer: scorer.name, reasons: ordered });
    }
  }

  return findings.sort((x, y) => `${x.a}\0${x.b}`.localeCompare(`${y.a}\0${y.b}`));
}

function describeReason(r: DivergenceReason): string {
  if (r.kind === 'required-shape') {
    const fmt = (s: string[]) => (s.length === 0 ? 'none' : s.join(', '));
    return `required params [${fmt(r.a)}] vs [${fmt(r.b)}]`;
  }
  return `nesting depth ${r.a} vs ${r.b}`;
}

export interface CollisionCheckContext {
  connection: McpConnection;
  config?: {
    threshold?: number;
    max_tools?: number;
    fail?: boolean;
  };
}

/**
 * Runs the collision lint against the live tool list.
 * Findings are `warn` by default (severity medium → warning: a selection hazard, not a live
 * permission change); `fail: true` in config makes them fail the run.
 */
export async function runCollisionChecks(ctx: CollisionCheckContext): Promise<CheckResult[]> {
  const threshold = ctx.config?.threshold ?? DEFAULT_COLLISION_THRESHOLD;
  const maxTools = ctx.config?.max_tools ?? DEFAULT_COLLISION_MAX_TOOLS;
  const status = ctx.config?.fail ? 'fail' : 'warn';

  let tools: Tool[];
  try {
    tools = await listAllTools(ctx.connection.client);
  } catch (err) {
    return [
      {
        id: 'collision/list-tools',
        family: 'collision',
        status: 'fail',
        severity: 'error',
        message: `Failed to list tools: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  if (tools.length > maxTools) {
    return [
      {
        id: 'collision/summary',
        family: 'collision',
        status: 'skip',
        severity: 'warning',
        message:
          `Collision lint skipped: ${tools.length} tools exceeds max_tools (${maxTools}); ` +
          `pairwise comparison would be ${(tools.length * (tools.length - 1)) / 2} pairs. ` +
          'Raise checks.collision.max_tools to run it.',
      },
    ];
  }

  const findings = findCollisions(tools, { threshold });
  const results: CheckResult[] = findings.map((f) => ({
    id: 'collision/description-collision',
    family: 'collision',
    status,
    severity: ctx.config?.fail ? 'error' : 'warning',
    message:
      `Tools "${f.a}" and "${f.b}" have near-identical descriptions ` +
      `(similarity ${f.similarity.toFixed(2)}, ${f.scorer}) but divergent input schemas: ` +
      `${f.reasons.map(describeReason).join('; ')}. ` +
      'An agent selecting tools by description may call the wrong one with the wrong payload.',
    expected: 'Distinct descriptions for tools that accept different payloads',
    actual: {
      similarity: Number(f.similarity.toFixed(4)),
      scorer: f.scorer,
      divergence: f.reasons,
    },
    location: `${f.a} / ${f.b}`,
  }));

  results.unshift(
    findings.length === 0
      ? {
          id: 'collision/summary',
          family: 'collision',
          status: 'pass',
          severity: 'info',
          message: `No description collisions among ${tools.length} tool(s) (threshold ${threshold})`,
        }
      : {
          id: 'collision/summary',
          family: 'collision',
          status,
          severity: ctx.config?.fail ? 'error' : 'warning',
          message: `${findings.length} description collision(s) among ${tools.length} tool(s)`,
        }
  );

  return results;
}
