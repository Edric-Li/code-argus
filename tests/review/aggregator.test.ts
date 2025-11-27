import { describe, it, expect } from 'vitest';
import {
  aggregate,
  aggregateIssues,
  groupByCategory,
  groupByFile,
  groupBySeverity,
} from '../../src/review/aggregator.js';
import type { ValidatedIssue, ChecklistItem } from '../../src/review/types.js';

// Helper to create mock validated issues
function createMockIssue(overrides: Partial<ValidatedIssue> = {}): ValidatedIssue {
  return {
    id: 'test-001',
    file: 'src/test.ts',
    line_start: 10,
    line_end: 15,
    category: 'logic',
    severity: 'warning',
    title: 'Test Issue',
    description: 'This is a test issue',
    confidence: 0.8,
    source_agent: 'logic-reviewer',
    validation_status: 'confirmed',
    grounding_evidence: {
      checked_files: ['src/test.ts'],
      checked_symbols: [],
      related_context: 'Test context',
      reasoning: 'Test reasoning',
    },
    final_confidence: 0.85,
    ...overrides,
  };
}

function createMockChecklist(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: 'check-001',
    category: 'security',
    question: 'Is input validated?',
    result: 'pass',
    ...overrides,
  };
}

describe('aggregateIssues', () => {
  it('should filter out rejected issues by default', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', validation_status: 'confirmed', file: 'a.ts' }),
      createMockIssue({ id: '2', validation_status: 'rejected', file: 'b.ts' }),
      createMockIssue({ id: '3', validation_status: 'uncertain', file: 'c.ts' }),
    ];

    const result = aggregateIssues(issues);

    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toContain('1');
    expect(result.map((i) => i.id)).toContain('3');
    expect(result.map((i) => i.id)).not.toContain('2');
  });

  it('should include rejected issues when option is set', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', validation_status: 'confirmed', file: 'a.ts' }),
      createMockIssue({ id: '2', validation_status: 'rejected', file: 'b.ts' }),
    ];

    const result = aggregateIssues(issues, { includeRejected: true });

    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toContain('2');
  });

  it('should filter by minimum confidence', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', final_confidence: 0.9, file: 'a.ts' }),
      createMockIssue({ id: '2', final_confidence: 0.5, file: 'b.ts' }),
      createMockIssue({ id: '3', final_confidence: 0.7, file: 'c.ts' }),
    ];

    const result = aggregateIssues(issues, { minConfidence: 0.6 });

    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toContain('1');
    expect(result.map((i) => i.id)).toContain('3');
  });

  it('should not deduplicate issues (deduplication handled by LLM deduplicator)', () => {
    // Note: Deduplication is now handled by the LLM-based deduplicator before aggregation
    // aggregateIssues only handles filtering and sorting
    const issues: ValidatedIssue[] = [
      createMockIssue({
        id: '1',
        file: 'test.ts',
        line_start: 10,
        line_end: 15,
        final_confidence: 0.8,
      }),
      createMockIssue({
        id: '2',
        file: 'test.ts',
        line_start: 10,
        line_end: 15,
        final_confidence: 0.9,
      }),
    ];

    const result = aggregateIssues(issues);

    // Issues are not deduplicated here - both should remain
    expect(result).toHaveLength(2);
  });

  it('should sort by severity by default', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', severity: 'warning' }),
      createMockIssue({ id: '2', severity: 'critical', file: 'b.ts' }),
      createMockIssue({ id: '3', severity: 'error', file: 'c.ts' }),
    ];

    const result = aggregateIssues(issues);

    expect(result[0].severity).toBe('critical');
    expect(result[1].severity).toBe('error');
    expect(result[2].severity).toBe('warning');
  });

  it('should sort by confidence when specified', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', final_confidence: 0.7, file: 'a.ts' }),
      createMockIssue({ id: '2', final_confidence: 0.95, file: 'b.ts' }),
      createMockIssue({ id: '3', final_confidence: 0.85, file: 'c.ts' }),
    ];

    const result = aggregateIssues(issues, { sortBy: 'confidence' });

    expect(result[0].final_confidence).toBe(0.95);
    expect(result[1].final_confidence).toBe(0.85);
    expect(result[2].final_confidence).toBe(0.7);
  });

  it('should sort by file when specified', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', file: 'c.ts' }),
      createMockIssue({ id: '2', file: 'a.ts' }),
      createMockIssue({ id: '3', file: 'b.ts' }),
    ];

    const result = aggregateIssues(issues, { sortBy: 'file' });

    expect(result[0].file).toBe('a.ts');
    expect(result[1].file).toBe('b.ts');
    expect(result[2].file).toBe('c.ts');
  });
});

describe('aggregate', () => {
  it('should return aggregation statistics', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', validation_status: 'confirmed' }),
      createMockIssue({ id: '2', validation_status: 'rejected' }),
      createMockIssue({ id: '3', validation_status: 'confirmed', file: 'other.ts' }),
    ];

    const result = aggregate(issues, []);

    expect(result.stats.total_input).toBe(3);
    expect(result.stats.rejected_filtered).toBe(1);
    expect(result.issues).toHaveLength(2);
  });

  it('should aggregate checklists', () => {
    const checklists: ChecklistItem[] = [
      createMockChecklist({ id: 'check-1', result: 'pass' }),
      createMockChecklist({ id: 'check-1', result: 'fail' }), // Duplicate, fail takes priority
      createMockChecklist({ id: 'check-2', result: 'na' }),
    ];

    const result = aggregate([], checklists);

    expect(result.checklist).toHaveLength(2);
    const check1 = result.checklist.find((c) => c.id === 'check-1');
    expect(check1?.result).toBe('fail'); // fail > pass
  });
});

describe('groupByCategory', () => {
  it('should group issues by category', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', category: 'security' }),
      createMockIssue({ id: '2', category: 'logic' }),
      createMockIssue({ id: '3', category: 'security' }),
    ];

    const result = groupByCategory(issues);

    expect(result.security).toHaveLength(2);
    expect(result.logic).toHaveLength(1);
    expect(result.performance).toHaveLength(0);
  });
});

describe('groupByFile', () => {
  it('should group issues by file', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', file: 'a.ts' }),
      createMockIssue({ id: '2', file: 'b.ts' }),
      createMockIssue({ id: '3', file: 'a.ts' }),
    ];

    const result = groupByFile(issues);

    expect(result.get('a.ts')).toHaveLength(2);
    expect(result.get('b.ts')).toHaveLength(1);
  });
});

describe('groupBySeverity', () => {
  it('should group issues by severity', () => {
    const issues: ValidatedIssue[] = [
      createMockIssue({ id: '1', severity: 'critical' }),
      createMockIssue({ id: '2', severity: 'warning' }),
      createMockIssue({ id: '3', severity: 'critical' }),
      createMockIssue({ id: '4', severity: 'error' }),
    ];

    const result = groupBySeverity(issues);

    expect(result.critical).toHaveLength(2);
    expect(result.error).toHaveLength(1);
    expect(result.warning).toHaveLength(1);
    expect(result.suggestion).toHaveLength(0);
  });
});
