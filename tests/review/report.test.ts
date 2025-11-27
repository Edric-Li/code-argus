import { describe, it, expect } from 'vitest';
import {
  calculateMetrics,
  determineRiskLevel,
  generateSummary,
  generateReport,
  formatAsJson,
  formatAsMarkdown,
  formatAsSummary,
  formatReport,
} from '../../src/review/report.js';
import type { ValidatedIssue, RawIssue, ChecklistItem } from '../../src/review/types.js';

// Helper to create mock issues
function createMockRawIssue(overrides: Partial<RawIssue> = {}): RawIssue {
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
    ...overrides,
  };
}

function createMockValidatedIssue(overrides: Partial<ValidatedIssue> = {}): ValidatedIssue {
  return {
    ...createMockRawIssue(),
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

describe('calculateMetrics', () => {
  it('should calculate metrics correctly', () => {
    const rawIssues: RawIssue[] = [
      createMockRawIssue({ id: '1' }),
      createMockRawIssue({ id: '2' }),
      createMockRawIssue({ id: '3' }),
    ];

    const validatedIssues: ValidatedIssue[] = [
      createMockValidatedIssue({
        id: '1',
        validation_status: 'confirmed',
        severity: 'error',
        category: 'security',
      }),
      createMockValidatedIssue({
        id: '2',
        validation_status: 'uncertain',
        severity: 'warning',
        category: 'logic',
      }),
    ];

    const metrics = calculateMetrics(rawIssues, validatedIssues);

    expect(metrics.total_scanned).toBe(3);
    expect(metrics.confirmed).toBe(1);
    expect(metrics.rejected).toBe(1);
    expect(metrics.uncertain).toBe(1);
    expect(metrics.by_severity.error).toBe(1);
    expect(metrics.by_severity.warning).toBe(1);
    expect(metrics.by_category.security).toBe(1);
    expect(metrics.by_category.logic).toBe(1);
  });

  it('should handle empty arrays', () => {
    const metrics = calculateMetrics([], []);

    expect(metrics.total_scanned).toBe(0);
    expect(metrics.confirmed).toBe(0);
    expect(metrics.rejected).toBe(0);
  });
});

describe('determineRiskLevel', () => {
  it('should return high for critical issues', () => {
    const issues: ValidatedIssue[] = [createMockValidatedIssue({ severity: 'critical' })];

    expect(determineRiskLevel(issues)).toBe('high');
  });

  it('should return high for multiple errors', () => {
    const issues: ValidatedIssue[] = [
      createMockValidatedIssue({ id: '1', severity: 'error', file: 'a.ts' }),
      createMockValidatedIssue({ id: '2', severity: 'error', file: 'b.ts' }),
      createMockValidatedIssue({ id: '3', severity: 'error', file: 'c.ts' }),
    ];

    expect(determineRiskLevel(issues)).toBe('high');
  });

  it('should return high for security errors', () => {
    const issues: ValidatedIssue[] = [
      createMockValidatedIssue({ severity: 'error', category: 'security' }),
    ];

    expect(determineRiskLevel(issues)).toBe('high');
  });

  it('should return medium for any errors', () => {
    const issues: ValidatedIssue[] = [createMockValidatedIssue({ severity: 'error' })];

    expect(determineRiskLevel(issues)).toBe('medium');
  });

  it('should return medium for many warnings', () => {
    const issues: ValidatedIssue[] = Array(6)
      .fill(null)
      .map((_, i) =>
        createMockValidatedIssue({ id: String(i), severity: 'warning', file: `${i}.ts` })
      );

    expect(determineRiskLevel(issues)).toBe('medium');
  });

  it('should return low for few warnings', () => {
    const issues: ValidatedIssue[] = [
      createMockValidatedIssue({ severity: 'warning' }),
      createMockValidatedIssue({ id: '2', severity: 'suggestion', file: 'b.ts' }),
    ];

    expect(determineRiskLevel(issues)).toBe('low');
  });

  it('should return low for no issues', () => {
    expect(determineRiskLevel([])).toBe('low');
  });
});

describe('generateSummary', () => {
  it('should generate summary with no issues', () => {
    // Default language is 'zh', test Chinese output
    const summary = generateSummary([]);
    expect(summary).toContain('本次审查未发现重大问题');
    expect(summary).toContain('低');

    // Test English output
    const summaryEn = generateSummary([], undefined, 'en');
    expect(summaryEn).toContain('No significant issues');
    expect(summaryEn).toContain('LOW');
  });

  it('should include issue counts', () => {
    const issues: ValidatedIssue[] = [
      createMockValidatedIssue({ id: '1', severity: 'critical', file: 'a.ts' }),
      createMockValidatedIssue({ id: '2', severity: 'error', file: 'b.ts' }),
      createMockValidatedIssue({ id: '3', severity: 'warning', file: 'c.ts' }),
    ];

    // Test English output
    const summary = generateSummary(issues, undefined, 'en');

    expect(summary).toContain('1 critical');
    expect(summary).toContain('1 error');
    expect(summary).toContain('1 warning');
    expect(summary).toContain('HIGH');
  });
});

describe('generateReport', () => {
  it('should generate a complete report', () => {
    const issues: ValidatedIssue[] = [createMockValidatedIssue({ severity: 'error' })];
    const checklist: ChecklistItem[] = [
      { id: 'c1', category: 'security', question: 'Test?', result: 'pass' },
    ];
    const metrics = calculateMetrics([createMockRawIssue()], issues);

    const report = generateReport(issues, checklist, metrics);

    expect(report.summary).toBeDefined();
    expect(report.risk_level).toBe('medium');
    expect(report.issues).toHaveLength(1);
    expect(report.checklist).toHaveLength(1);
    expect(report.metrics).toBeDefined();
  });
});

describe('formatAsJson', () => {
  it('should format report as JSON', () => {
    const issues: ValidatedIssue[] = [createMockValidatedIssue({ severity: 'error' })];
    const metrics = calculateMetrics([createMockRawIssue()], issues);
    const report = generateReport(issues, [], metrics);

    const json = formatAsJson(report);
    const parsed = JSON.parse(json);

    expect(parsed.summary).toBeDefined();
    expect(parsed.risk_level).toBe('medium');
    expect(parsed.issues).toHaveLength(1);
  });

  it('should exclude checklist when option is false', () => {
    const report = generateReport([], [], calculateMetrics([], []));
    report.checklist = [{ id: 'c1', category: 'security', question: 'Test?', result: 'pass' }];

    const json = formatAsJson(report, { includeChecklist: false });
    const parsed = JSON.parse(json);

    expect(parsed.checklist).toBeUndefined();
  });
});

describe('formatAsMarkdown', () => {
  it('should format report as Markdown', () => {
    const issues: ValidatedIssue[] = [
      createMockValidatedIssue({ severity: 'error', title: 'Test Error' }),
    ];
    const metrics = calculateMetrics([createMockRawIssue()], issues);
    const report = generateReport(issues, [], metrics, undefined, undefined, 'en');

    const md = formatAsMarkdown(report, { language: 'en' });

    expect(md).toContain('# Code Review Report');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Issues');
    expect(md).toContain('Test Error');
    expect(md).toContain('## Metrics');
  });

  it('should include checklist section', () => {
    const checklist: ChecklistItem[] = [
      { id: 'c1', category: 'security', question: 'Is input validated?', result: 'pass' },
    ];
    const report = generateReport(
      [],
      checklist,
      calculateMetrics([], []),
      undefined,
      undefined,
      'en'
    );

    const md = formatAsMarkdown(report, { language: 'en' });

    expect(md).toContain('## Checklist');
    expect(md).toContain('Is input validated?');
  });
});

describe('formatAsSummary', () => {
  it('should format a short summary', () => {
    const issues: ValidatedIssue[] = [
      createMockValidatedIssue({ severity: 'error', title: 'Important Error' }),
    ];
    const metrics = calculateMetrics([createMockRawIssue()], issues);
    const report = generateReport(issues, [], metrics);

    const summary = formatAsSummary(report);

    expect(summary).toContain('Risk Level:');
    expect(summary).toContain('Issues:');
    expect(summary).toContain('Important Error');
  });
});

describe('formatReport', () => {
  it('should use correct format based on option', () => {
    const report = generateReport([], [], calculateMetrics([], []), undefined, undefined, 'en');

    const json = formatReport(report, { format: 'json', language: 'en' });
    expect(() => JSON.parse(json)).not.toThrow();

    const md = formatReport(report, { format: 'markdown', language: 'en' });
    expect(md).toContain('# Code Review Report');

    const summary = formatReport(report, { format: 'summary' });
    expect(summary).toContain('Risk Level:');
  });

  it('should default to markdown', () => {
    const report = generateReport([], [], calculateMetrics([], []), undefined, undefined, 'en');

    const output = formatReport(report, { language: 'en' });

    expect(output).toContain('# Code Review Report');
  });
});
