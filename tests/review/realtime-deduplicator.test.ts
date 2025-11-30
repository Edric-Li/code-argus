/**
 * Tests for RealtimeDeduplicator
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealtimeDeduplicator } from '../../src/review/realtime-deduplicator.js';
import type { RawIssue, AgentType } from '../../src/review/types.js';

// Create a mock for the Anthropic client
const mockCreate = vi.fn();

// Mock the Anthropic client
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: mockCreate,
      };
    },
  };
});

// Mock the config module
vi.mock('../../src/config/env.js', () => ({
  getApiKey: () => 'test-api-key',
}));

// Setup default mock behavior before each test
beforeEach(() => {
  mockCreate.mockReset();
  // Default: return "not duplicate" for LLM checks
  mockCreate.mockResolvedValue({
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          is_duplicate: false,
          duplicate_of_id: null,
          reason: 'Different issues',
        }),
      },
    ],
  });
});

/**
 * Create a test issue with sensible defaults
 */
function createTestIssue(overrides: Partial<RawIssue> = {}): RawIssue {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    file: 'src/test.ts',
    line_start: 10,
    line_end: 15,
    category: 'logic',
    severity: 'warning',
    title: 'Test issue',
    description: 'Test description',
    confidence: 0.8,
    source_agent: 'logic-reviewer' as AgentType,
    ...overrides,
  };
}

describe('RealtimeDeduplicator', () => {
  describe('fast rule-based check', () => {
    it('should accept first issue without any checks', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });
      const issue = createTestIssue();

      const result = await deduplicator.checkAndAdd(issue);

      expect(result.isDuplicate).toBe(false);
      expect(result.usedLLM).toBe(false);
      expect(deduplicator.getAcceptedIssues()).toHaveLength(1);
    });

    it('should accept issue in different file without LLM check', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });

      // First issue
      const issue1 = createTestIssue({
        file: 'src/file1.ts',
        line_start: 10,
        line_end: 15,
      });
      await deduplicator.checkAndAdd(issue1);

      // Second issue in different file
      const issue2 = createTestIssue({
        file: 'src/file2.ts',
        line_start: 10,
        line_end: 15,
      });
      const result = await deduplicator.checkAndAdd(issue2);

      expect(result.isDuplicate).toBe(false);
      expect(result.usedLLM).toBe(false);
      expect(deduplicator.getAcceptedIssues()).toHaveLength(2);
    });

    it('should accept issue with non-overlapping lines without LLM check', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });

      // First issue at lines 10-15
      const issue1 = createTestIssue({
        file: 'src/test.ts',
        line_start: 10,
        line_end: 15,
      });
      await deduplicator.checkAndAdd(issue1);

      // Second issue at lines 20-25 (no overlap)
      const issue2 = createTestIssue({
        file: 'src/test.ts',
        line_start: 20,
        line_end: 25,
      });
      const result = await deduplicator.checkAndAdd(issue2);

      expect(result.isDuplicate).toBe(false);
      expect(result.usedLLM).toBe(false);
      expect(deduplicator.getAcceptedIssues()).toHaveLength(2);
    });
  });

  describe('line overlap detection', () => {
    it('should detect full overlap', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });

      // First issue at lines 10-20
      const issue1 = createTestIssue({
        file: 'src/test.ts',
        line_start: 10,
        line_end: 20,
      });
      await deduplicator.checkAndAdd(issue1);

      // Second issue at lines 12-18 (fully inside first)
      const issue2 = createTestIssue({
        file: 'src/test.ts',
        line_start: 12,
        line_end: 18,
      });
      const result = await deduplicator.checkAndAdd(issue2);

      // Should trigger LLM check due to overlap
      expect(result.usedLLM).toBe(true);
    });

    it('should detect partial overlap', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });

      // First issue at lines 10-15
      const issue1 = createTestIssue({
        file: 'src/test.ts',
        line_start: 10,
        line_end: 15,
      });
      await deduplicator.checkAndAdd(issue1);

      // Second issue at lines 13-20 (partial overlap)
      const issue2 = createTestIssue({
        file: 'src/test.ts',
        line_start: 13,
        line_end: 20,
      });
      const result = await deduplicator.checkAndAdd(issue2);

      // Should trigger LLM check due to overlap
      expect(result.usedLLM).toBe(true);
    });

    it('should detect edge overlap (touching lines)', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });

      // First issue at lines 10-15
      const issue1 = createTestIssue({
        file: 'src/test.ts',
        line_start: 10,
        line_end: 15,
      });
      await deduplicator.checkAndAdd(issue1);

      // Second issue at lines 15-20 (touching at line 15)
      const issue2 = createTestIssue({
        file: 'src/test.ts',
        line_start: 15,
        line_end: 20,
      });
      const result = await deduplicator.checkAndAdd(issue2);

      // Should trigger LLM check due to overlap at line 15
      expect(result.usedLLM).toBe(true);
    });

    it('should not detect overlap for adjacent but non-overlapping lines', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });

      // First issue at lines 10-15
      const issue1 = createTestIssue({
        file: 'src/test.ts',
        line_start: 10,
        line_end: 15,
      });
      await deduplicator.checkAndAdd(issue1);

      // Second issue at lines 16-20 (adjacent, not overlapping)
      const issue2 = createTestIssue({
        file: 'src/test.ts',
        line_start: 16,
        line_end: 20,
      });
      const result = await deduplicator.checkAndAdd(issue2);

      // Should NOT trigger LLM check
      expect(result.usedLLM).toBe(false);
    });
  });

  describe('statistics', () => {
    it('should track accepted issues count', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });

      await deduplicator.checkAndAdd(createTestIssue({ file: 'a.ts' }));
      await deduplicator.checkAndAdd(createTestIssue({ file: 'b.ts' }));
      await deduplicator.checkAndAdd(createTestIssue({ file: 'c.ts' }));

      const stats = deduplicator.getStats();
      expect(stats.accepted).toBe(3);
    });

    it('should reset state correctly', async () => {
      const deduplicator = new RealtimeDeduplicator({ verbose: false });

      await deduplicator.checkAndAdd(createTestIssue({ file: 'a.ts' }));
      await deduplicator.checkAndAdd(createTestIssue({ file: 'b.ts' }));

      expect(deduplicator.getStats().accepted).toBe(2);

      deduplicator.reset();

      expect(deduplicator.getStats().accepted).toBe(0);
      expect(deduplicator.getAcceptedIssues()).toHaveLength(0);
    });
  });

  describe('callback', () => {
    it('should call onDeduplicated callback when duplicate is found', async () => {
      // Setup mock to return duplicate result
      mockCreate.mockResolvedValueOnce({
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              is_duplicate: true,
              duplicate_of_id: 'issue-1',
              reason: 'Same root cause',
            }),
          },
        ],
      });

      const onDeduplicated = vi.fn();
      const deduplicator = new RealtimeDeduplicator({
        verbose: false,
        onDeduplicated,
      });

      // First issue
      const issue1 = createTestIssue({
        id: 'issue-1',
        file: 'src/test.ts',
        line_start: 10,
        line_end: 15,
        title: 'First issue',
      });
      await deduplicator.checkAndAdd(issue1);

      // Second issue with overlapping lines (will trigger LLM)
      const issue2 = createTestIssue({
        id: 'issue-2',
        file: 'src/test.ts',
        line_start: 12,
        line_end: 18,
        title: 'Second issue (duplicate)',
      });
      await deduplicator.checkAndAdd(issue2);

      expect(onDeduplicated).toHaveBeenCalledWith(issue2, issue1, 'Same root cause');
    });
  });
});
