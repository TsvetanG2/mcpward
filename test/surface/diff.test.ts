/**
 * Classifier truth table tests for drift detection.
 *
 * Tests each change class from SPEC.md §7.2:
 * | Change | Class | Breaking? |
 * |--------|-------|-----------|
 * | In lock, absent now | tool_removed | yes |
 * | Absent in lock, present now | tool_added | no |
 * | descriptionHash changed | description_changed | yes |
 * | Added required field | breaking_schema_change | yes |
 * | Removed field | breaking_schema_change | yes |
 * | Added optional field | nonbreaking_schema_change | no |
 * | readOnlyHint true→false | annotation_changed | yes |
 * | destructiveHint false→true | annotation_changed | yes |
 */

import { describe, it, expect } from 'vitest';
import {
  diffSurfaces,
  filterFailingChanges,
  applySeverityOverrides,
  type ServerSurface,
  type ToolSurface,
} from '../../src/surface/index.js';
import { hashDescription } from '../../src/surface/capture.js';

// Helper to create a minimal ServerSurface
function createSurface(tools: Record<string, ToolSurface>): ServerSurface {
  return {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {}, resources: {}, prompts: {} },
    tools,
    meta: {
      schemaVersion: 2,
      mcpwardVersion: '1.0.0',
      canonicalVersion: 1,
      capturedAt: '2025-07-17T00:00:00.000Z',
      serverName: 'test-server',
      serverVersion: '1.0.0',
      target: {
        transport: 'stdio',
        identity: 'test-server',
      },
      authContext: {
        kind: 'none',
        keys: [],
        fingerprint: null,
        label: null,
      },
      environment: {
        ci: false,
        nodeVersion: '20.0.0',
        platform: 'test',
      },
    },
  };
}

// Helper to create a minimal ToolSurface
function createTool(overrides: Partial<ToolSurface> = {}): ToolSurface {
  const desc = 'Default description';
  return {
    descriptionHash: hashDescription(desc),
    description: desc, // M1: full text for diffs
    inputSchema: {
      type: 'object',
      properties: {},
    },
    outputSchema: null,
    annotations: null,
    ...overrides,
  };
}

describe('diffSurfaces classifier', () => {
  describe('tool_removed', () => {
    it('detects when a tool is removed', () => {
      const baseline = createSurface({
        existing_tool: createTool(),
        removed_tool: createTool(),
      });

      const current = createSurface({
        existing_tool: createTool(),
        // removed_tool is absent
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({
        tool: 'removed_tool',
        class: 'tool_removed',
      });
    });
  });

  describe('tool_added', () => {
    it('detects when a tool is added', () => {
      const baseline = createSurface({
        existing_tool: createTool(),
      });

      const current = createSurface({
        existing_tool: createTool(),
        added_tool: createTool(),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({
        tool: 'added_tool',
        class: 'tool_added',
      });
    });
  });

  describe('description_changed (rug-pull detection)', () => {
    it('detects when a description changes', () => {
      const baseline = createSurface({
        echo: createTool({
          descriptionHash: hashDescription('Original description'),
        }),
      });

      const current = createSurface({
        echo: createTool({
          descriptionHash: hashDescription('Modified description'),
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({
        tool: 'echo',
        class: 'description_changed',
      });
      expect(result.changes[0]?.message).toContain('rug-pull');
    });

    it('does not flag unchanged descriptions', () => {
      const desc = 'Same description';
      const baseline = createSurface({
        echo: createTool({
          descriptionHash: hashDescription(desc),
        }),
      });

      const current = createSurface({
        echo: createTool({
          descriptionHash: hashDescription(desc),
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(true);
      expect(result.changes).toHaveLength(0);
    });
  });

  describe('breaking_schema_change', () => {
    it('detects when a required field is added', () => {
      const baseline = createSurface({
        compute: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'number' },
            },
            required: ['value'],
          },
        }),
      });

      const current = createSurface({
        compute: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'number' },
              multiplier: { type: 'number' },
            },
            required: ['value', 'multiplier'],
          },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const breakingChange = result.changes.find((c) => c.class === 'breaking_schema_change');
      expect(breakingChange).toBeDefined();
      expect(breakingChange?.message).toContain('required');
      expect(breakingChange?.message).toContain('multiplier');
    });

    it('detects when a field is removed', () => {
      const baseline = createSurface({
        query: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              filter: { type: 'string' },
            },
            required: ['id'],
          },
        }),
      });

      const current = createSurface({
        query: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              // filter removed
            },
            required: ['id'],
          },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const breakingChange = result.changes.find((c) => c.class === 'breaking_schema_change');
      expect(breakingChange).toBeDefined();
      expect(breakingChange?.message).toContain('removed');
      expect(breakingChange?.message).toContain('filter');
    });

    it('detects when schema is removed entirely', () => {
      const baseline = createSurface({
        tool: createTool({
          inputSchema: {
            type: 'object',
            properties: { x: { type: 'string' } },
          },
        }),
      });

      const current = createSurface({
        tool: createTool({
          inputSchema: null,
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const breakingChange = result.changes.find((c) => c.class === 'breaking_schema_change');
      expect(breakingChange).toBeDefined();
      expect(breakingChange?.message).toContain('removed');
    });

    it('detects when optional field becomes required', () => {
      const baseline = createSurface({
        tool: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              filter: { type: 'string' },
            },
            required: ['id'],
          },
        }),
      });

      const current = createSurface({
        tool: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              filter: { type: 'string' },
            },
            required: ['id', 'filter'],
          },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const breakingChange = result.changes.find((c) => c.class === 'breaking_schema_change');
      expect(breakingChange).toBeDefined();
      expect(breakingChange?.message).toContain('became required');
    });
  });

  describe('nonbreaking_schema_change', () => {
    it('classifies an added optional input field as input_property_added (non-breaking)', () => {
      const baseline = createSurface({
        query: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
            required: ['id'],
          },
        }),
      });

      const current = createSurface({
        query: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              limit: { type: 'number' },
            },
            required: ['id'],
          },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const added = result.changes.find((c) => c.class === 'input_property_added');
      expect(added).toBeDefined();
      expect(added?.message).toContain('optional');
      expect(added?.message).toContain('limit');
      expect(result.changes.some((c) => c.class === 'breaking_schema_change')).toBe(false);
    });

    it('detects when schema is added (was null)', () => {
      const baseline = createSurface({
        tool: createTool({
          inputSchema: null,
        }),
      });

      const current = createSurface({
        tool: createTool({
          inputSchema: {
            type: 'object',
            properties: { x: { type: 'string' } },
          },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const nonBreakingChange = result.changes.find((c) => c.class === 'nonbreaking_schema_change');
      expect(nonBreakingChange).toBeDefined();
      expect(nonBreakingChange?.message).toContain('added');
    });

    it('detects when required field becomes optional', () => {
      const baseline = createSurface({
        tool: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              filter: { type: 'string' },
            },
            required: ['id', 'filter'],
          },
        }),
      });

      const current = createSurface({
        tool: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              filter: { type: 'string' },
            },
            required: ['id'],
          },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const nonBreakingChange = result.changes.find((c) => c.class === 'nonbreaking_schema_change');
      expect(nonBreakingChange).toBeDefined();
      expect(nonBreakingChange?.message).toContain('became optional');
    });
  });

  describe('annotation_changed', () => {
    it('detects when readOnlyHint changes true → false', () => {
      const baseline = createSurface({
        read_data: createTool({
          annotations: { readOnlyHint: true },
        }),
      });

      const current = createSurface({
        read_data: createTool({
          annotations: { readOnlyHint: false },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const annotationChange = result.changes.find((c) => c.class === 'annotation_changed');
      expect(annotationChange).toBeDefined();
      expect(annotationChange?.message).toContain('readOnlyHint');
    });

    it('detects when destructiveHint changes false → true', () => {
      const baseline = createSurface({
        update_data: createTool({
          annotations: { destructiveHint: false },
        }),
      });

      const current = createSurface({
        update_data: createTool({
          annotations: { destructiveHint: true },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);
      const annotationChange = result.changes.find((c) => c.class === 'annotation_changed');
      expect(annotationChange).toBeDefined();
      expect(annotationChange?.message).toContain('destructiveHint');
    });

    it('reports readOnlyHint false → true as annotation_relaxed (a path to auto-approval)', () => {
      const baseline = createSurface({
        tool: createTool({
          annotations: { readOnlyHint: false },
        }),
      });

      const current = createSurface({
        tool: createTool({
          annotations: { readOnlyHint: true },
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.changes.map((c) => [c.class, c.severity])).toEqual([
        ['annotation_relaxed', 'medium'],
      ]);
    });
  });

  describe('annotation hints: both directions on effective values (truth table)', () => {
    type Hints = NonNullable<ToolSurface['annotations']>;
    const run = (before: Hints | null, after: Hints | null) =>
      diffSurfaces(
        createSurface({ t: createTool({ annotations: before }) }),
        createSurface({ t: createTool({ annotations: after }) })
      ).changes.map((c) => `${c.class}/${c.severity}`);

    // [case, before, after, expected class/severity list]
    const table: [string, Hints | null, Hints | null, string[]][] = [
      // riskier → annotation_changed
      [
        'readOnlyHint true→false',
        { readOnlyHint: true },
        { readOnlyHint: false },
        ['annotation_changed/high'],
      ],
      [
        'readOnlyHint true→absent (means false)',
        { readOnlyHint: true },
        {},
        ['annotation_changed/high'],
      ],
      [
        'readOnlyHint true→no annotations',
        { readOnlyHint: true },
        null,
        ['annotation_changed/high'],
      ],
      [
        'destructiveHint false→true',
        { destructiveHint: false },
        { destructiveHint: true },
        ['annotation_changed/high'],
      ],
      [
        'destructiveHint false→absent (means true)',
        { destructiveHint: false },
        {},
        ['annotation_changed/high'],
      ],
      [
        'openWorldHint false→true',
        { openWorldHint: false },
        { openWorldHint: true },
        ['annotation_changed/high'],
      ],
      [
        'openWorldHint false→absent (means true)',
        { openWorldHint: false },
        {},
        ['annotation_changed/high'],
      ],
      [
        'idempotentHint true→false (medium)',
        { idempotentHint: true },
        { idempotentHint: false },
        ['annotation_changed/medium'],
      ],
      [
        'idempotentHint true→absent (means false)',
        { idempotentHint: true },
        {},
        ['annotation_changed/medium'],
      ],
      // safer → annotation_relaxed
      [
        'readOnlyHint false→true',
        { readOnlyHint: false },
        { readOnlyHint: true },
        ['annotation_relaxed/medium'],
      ],
      ['readOnlyHint absent→true', {}, { readOnlyHint: true }, ['annotation_relaxed/medium']],
      [
        'destructiveHint true→false',
        { destructiveHint: true },
        { destructiveHint: false },
        ['annotation_relaxed/medium'],
      ],
      [
        'destructiveHint absent→false',
        null,
        { destructiveHint: false },
        ['annotation_relaxed/medium'],
      ],
      [
        'openWorldHint true→false',
        { openWorldHint: true },
        { openWorldHint: false },
        ['annotation_relaxed/medium'],
      ],
      [
        'idempotentHint false→true',
        { idempotentHint: false },
        { idempotentHint: true },
        ['annotation_relaxed/medium'],
      ],
      // same effective value → nothing
      ['readOnlyHint false→absent', { readOnlyHint: false }, {}, []],
      ['destructiveHint absent→true', {}, { destructiveHint: true }, []],
      ['openWorldHint true→absent', { openWorldHint: true }, null, []],
      ['idempotentHint absent→false', null, { idempotentHint: false }, []],
      ['no annotations → empty annotations', null, {}, []],
      // destructive/idempotent mean nothing while the tool is read-only on both sides
      [
        'read-only tool drops destructiveHint: false',
        { readOnlyHint: true, destructiveHint: false },
        { readOnlyHint: true },
        [],
      ],
      [
        'read-only tool drops idempotentHint: true',
        { readOnlyHint: true, idempotentHint: true },
        { readOnlyHint: true },
        [],
      ],
      [
        'tool stops being read-only and gains destructiveHint: true',
        { readOnlyHint: true },
        { readOnlyHint: false, destructiveHint: true },
        ['annotation_changed/high'],
      ],
      // several hints at once: one finding each, in hint order
      [
        'readOnlyHint relaxed while openWorldHint widens',
        { readOnlyHint: false, openWorldHint: false },
        { readOnlyHint: true, openWorldHint: true },
        ['annotation_relaxed/medium', 'annotation_changed/high'],
      ],
    ];

    it.each(table)('%s', (_case, before, after, expected) => {
      expect(run(before, after)).toEqual(expected);
    });

    it('names both values in the message, absent included', () => {
      const [change] = diffSurfaces(
        createSurface({ t: createTool({ annotations: { readOnlyHint: true } }) }),
        createSurface({ t: createTool({ annotations: {} }) })
      ).changes;
      expect(change?.message).toBe(
        'Tool "t" readOnlyHint changed from true to absent (means false) (tool may now mutate state)'
      );
      expect(change?.previous).toEqual({ readOnlyHint: true });
      expect(change?.current).toEqual({ readOnlyHint: null });
    });
  });

  describe('no changes', () => {
    it('reports unchanged when surfaces are identical', () => {
      const surface = createSurface({
        echo: createTool(),
        add: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
          },
        }),
      });

      const result = diffSurfaces(surface, surface);

      expect(result.unchanged).toBe(true);
      expect(result.changes).toHaveLength(0);
    });
  });

  describe('complex scenario', () => {
    it('detects multiple changes in a single diff', () => {
      const baseline = createSurface({
        removed_tool: createTool(),
        echo: createTool({
          descriptionHash: hashDescription('Old description'),
        }),
        compute: createTool({
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
          },
        }),
        read_data: createTool({
          annotations: { readOnlyHint: true },
        }),
      });

      const current = createSurface({
        // removed_tool absent → tool_removed
        added_tool: createTool(), // → tool_added
        echo: createTool({
          descriptionHash: hashDescription('New description'), // → description_changed
        }),
        compute: createTool({
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'number' },
              multiplier: { type: 'number' },
            },
            required: ['value', 'multiplier'], // → breaking_schema_change
          },
        }),
        read_data: createTool({
          annotations: { readOnlyHint: false }, // → annotation_changed
        }),
      });

      const result = diffSurfaces(baseline, current);

      expect(result.unchanged).toBe(false);

      const classes = result.changes.map((c) => c.class);
      expect(classes).toContain('tool_removed');
      expect(classes).toContain('tool_added');
      expect(classes).toContain('description_changed');
      expect(classes).toContain('breaking_schema_change');
      expect(classes).toContain('annotation_changed');
    });
  });
});

describe('filterFailingChanges', () => {
  it('filters changes based on fail_on config', () => {
    const changes = [
      { tool: 'a', class: 'tool_removed' as const, severity: 'low' as const, message: 'removed' },
      { tool: 'b', class: 'tool_added' as const, severity: 'low' as const, message: 'added' },
      {
        tool: 'c',
        class: 'description_changed' as const,
        severity: 'high' as const,
        message: 'desc',
      },
      {
        tool: 'd',
        class: 'breaking_schema_change' as const,
        severity: 'medium' as const,
        message: 'break',
      },
      {
        tool: 'e',
        class: 'nonbreaking_schema_change' as const,
        severity: 'low' as const,
        message: 'non',
      },
    ];

    const failOn = ['tool_removed', 'description_changed', 'breaking_schema_change'];
    const failing = filterFailingChanges(changes, failOn);

    expect(failing).toHaveLength(3);
    expect(failing.map((c) => c.class)).toEqual([
      'tool_removed',
      'description_changed',
      'breaking_schema_change',
    ]);
  });

  it('returns empty array when no changes match fail_on', () => {
    const changes = [
      { tool: 'a', class: 'tool_added' as const, severity: 'low' as const, message: 'added' },
      {
        tool: 'b',
        class: 'nonbreaking_schema_change' as const,
        severity: 'low' as const,
        message: 'non',
      },
    ];

    const failOn = ['tool_removed', 'description_changed'];
    const failing = filterFailingChanges(changes, failOn);

    expect(failing).toHaveLength(0);
  });
});

describe('M2: Severity levels', () => {
  it('assigns high severity to description_changed', () => {
    const baseline = createSurface({
      test_tool: createTool({
        descriptionHash: hashDescription('Original'),
        description: 'Original',
      }),
    });

    const current = createSurface({
      test_tool: createTool({
        descriptionHash: hashDescription('Changed'),
        description: 'Changed',
      }),
    });

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'description_changed',
      severity: 'high',
    });
  });

  it('assigns high severity to annotation_changed (readOnlyHint flip)', () => {
    const baseline = createSurface({
      test_tool: createTool({ annotations: { readOnlyHint: true } }),
    });

    const current = createSurface({
      test_tool: createTool({ annotations: { readOnlyHint: false } }),
    });

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'annotation_changed',
      severity: 'high',
    });
  });

  it('assigns medium severity to breaking_schema_change', () => {
    const baseline = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      }),
    });

    const current = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: {}, // Removed 'name' property
        },
      }),
    });

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'breaking_schema_change',
      severity: 'medium',
    });
  });

  it('assigns low severity to tool_removed', () => {
    const baseline = createSurface({
      removed_tool: createTool(),
    });

    const current = createSurface({});

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'tool_removed',
      severity: 'low', // CRITICAL: low, not high - breaks loudly, fixed in minutes
    });
  });

  it('assigns low severity to tool_added', () => {
    const baseline = createSurface({});

    const current = createSurface({
      added_tool: createTool(),
    });

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'tool_added',
      severity: 'low',
    });
  });

  it('assigns medium severity to input_property_added', () => {
    const baseline = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: {},
        },
      }),
    });

    const current = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: { optional_field: { type: 'string' } }, // Added optional field
        },
      }),
    });

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'input_property_added',
      severity: 'medium',
    });
  });
});

describe('M2: filterFailingChanges with severity threshold', () => {
  const changes = [
    {
      tool: 'tool1',
      class: 'description_changed' as const,
      severity: 'high' as const,
      message: 'High severity change',
    },
    {
      tool: 'tool2',
      class: 'breaking_schema_change' as const,
      severity: 'medium' as const,
      message: 'Medium severity change',
    },
    {
      tool: 'tool3',
      class: 'tool_added' as const,
      severity: 'low' as const,
      message: 'Low severity change',
    },
  ];

  it('severity threshold "high" fails only high severity changes', () => {
    const failing = filterFailingChanges(changes, 'high');
    expect(failing).toHaveLength(1);
    expect(failing[0]?.severity).toBe('high');
  });

  it('severity threshold "medium" fails high and medium severity changes', () => {
    const failing = filterFailingChanges(changes, 'medium');
    expect(failing).toHaveLength(2);
    expect(failing.map((c) => c.severity).sort()).toEqual(['high', 'medium']);
  });

  it('severity threshold "low" fails all changes', () => {
    const failing = filterFailingChanges(changes, 'low');
    expect(failing).toHaveLength(3);
  });

  it('legacy array mode still works', () => {
    const failing = filterFailingChanges(changes, ['description_changed']);
    expect(failing).toHaveLength(1);
    expect(failing[0]?.class).toBe('description_changed');
  });
});

describe('M2.2: Type change classification', () => {
  it('classifies type widening as nonbreaking with low severity', () => {
    const baseline = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: {
            field: { type: 'string' },
          },
        },
      }),
    });

    const current = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: {
            field: { type: ['string', 'number'] }, // Widened: string → string|number
          },
        },
      }),
    });

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'nonbreaking_schema_change',
      severity: 'low',
    });
    expect(result.changes[0]?.message).toContain('widened');
  });

  it('classifies type narrowing as breaking with medium severity', () => {
    const baseline = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: {
            field: { type: ['string', 'number'] },
          },
        },
      }),
    });

    const current = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: {
            field: { type: 'string' }, // Narrowed: string|number → string
          },
        },
      }),
    });

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'breaking_schema_change',
      severity: 'medium',
    });
    expect(result.changes[0]?.message).toContain('narrowed');
  });

  it('classifies unrelated type change as breaking with medium severity', () => {
    const baseline = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: {
            field: { type: 'string' },
          },
        },
      }),
    });

    const current = createSurface({
      test_tool: createTool({
        inputSchema: {
          type: 'object',
          properties: {
            field: { type: 'object' }, // Unrelated: string → object
          },
        },
      }),
    });

    const result = diffSurfaces(baseline, current);
    expect(result.changes[0]).toMatchObject({
      class: 'breaking_schema_change',
      severity: 'medium',
    });
    expect(result.changes[0]?.message).toContain('changed');
  });
});

describe('hashDescription', () => {
  it('returns consistent hash for same description', () => {
    const hash1 = hashDescription('Test description');
    const hash2 = hashDescription('Test description');
    expect(hash1).toBe(hash2);
  });

  it('returns different hash for different descriptions', () => {
    const hash1 = hashDescription('Description A');
    const hash2 = hashDescription('Description B');
    expect(hash1).not.toBe(hash2);
  });

  it('handles undefined description', () => {
    const hash = hashDescription(undefined);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('handles empty description', () => {
    const hash = hashDescription('');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('M2: per-class severity overrides', () => {
  const removed = (): ServerSurface['tools'] => ({ gone: createTool() });

  it('tool_removed is low by default and passes fail_on: high', () => {
    const { changes } = diffSurfaces(createSurface(removed()), createSurface({}));
    expect(changes.map((c) => c.severity)).toEqual(['low']);
    expect(filterFailingChanges(changes, 'high')).toHaveLength(0);
  });

  it('override raises tool_removed to high so fail_on: high fails it', () => {
    const { changes } = diffSurfaces(createSurface(removed()), createSurface({}));
    const overridden = applySeverityOverrides(changes, { tool_removed: 'high' });
    expect(overridden.map((c) => c.severity)).toEqual(['high']);
    expect(filterFailingChanges(overridden, 'high')).toHaveLength(1);
  });

  it('does not mutate the input changes', () => {
    const { changes } = diffSurfaces(createSurface(removed()), createSurface({}));
    applySeverityOverrides(changes, { tool_removed: 'high' });
    expect(changes[0]?.severity).toBe('low');
  });

  it('empty or missing overrides are a no-op', () => {
    const { changes } = diffSurfaces(createSurface(removed()), createSurface({}));
    expect(applySeverityOverrides(changes, {})).toBe(changes);
    expect(applySeverityOverrides(changes, undefined)).toBe(changes);
  });
});
