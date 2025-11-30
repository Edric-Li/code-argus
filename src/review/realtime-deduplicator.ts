/**
 * Realtime Issue Deduplicator
 *
 * Performs real-time deduplication as issues are reported by agents.
 * Uses a two-layer approach:
 * 1. Fast rule-based check: same file + overlapping lines
 * 2. LLM semantic check: only when rule-based check finds potential duplicates
 */

import Anthropic from '@anthropic-ai/sdk';
import type { RawIssue } from './types.js';
import { getApiKey } from '../config/env.js';
import { extractJSON } from './utils/json-parser.js';
import { DEFAULT_REALTIME_DEDUP_MODEL } from './constants.js';

/**
 * Options for the realtime deduplicator
 */
export interface RealtimeDeduplicatorOptions {
  /** Anthropic API key */
  apiKey?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Callback when an issue is deduplicated */
  onDeduplicated?: (newIssue: RawIssue, existingIssue: RawIssue, reason: string) => void;
}

/**
 * Result of checking an issue for duplicates
 */
export interface DeduplicationCheckResult {
  /** Whether the issue is a duplicate */
  isDuplicate: boolean;
  /** If duplicate, which existing issue it duplicates */
  duplicateOf?: RawIssue;
  /** Reason for deduplication (if duplicate) */
  reason?: string;
  /** Whether LLM was used for this check */
  usedLLM: boolean;
  /** Tokens used (if LLM was called) */
  tokensUsed: number;
}

/**
 * Realtime Issue Deduplicator
 *
 * Maintains a list of accepted issues and checks new issues against them.
 */
export class RealtimeDeduplicator {
  private client: Anthropic;
  private options: Required<Omit<RealtimeDeduplicatorOptions, 'onDeduplicated'>> & {
    onDeduplicated?: RealtimeDeduplicatorOptions['onDeduplicated'];
  };
  private acceptedIssues: RawIssue[] = [];
  private totalTokensUsed = 0;
  private duplicatesFound = 0;
  /** Lock to ensure sequential processing of issues (prevents race conditions) */
  private processingLock: Promise<void> = Promise.resolve();

  constructor(options: RealtimeDeduplicatorOptions = {}) {
    this.options = {
      apiKey: options.apiKey || getApiKey(),
      verbose: options.verbose || false,
      onDeduplicated: options.onDeduplicated,
    };

    this.client = new Anthropic({
      apiKey: this.options.apiKey,
    });
  }

  /**
   * Check if an issue is a duplicate and add it if not
   * Uses a lock to ensure sequential processing and prevent race conditions
   *
   * @returns Result indicating whether the issue was accepted or deduplicated
   */
  async checkAndAdd(issue: RawIssue): Promise<DeduplicationCheckResult> {
    // Use lock to ensure sequential processing
    let result: DeduplicationCheckResult;
    this.processingLock = this.processingLock.then(async () => {
      result = await this.checkAndAddImpl(issue);
    });
    await this.processingLock;
    return result!;
  }

  /**
   * Internal implementation of checkAndAdd (called within lock)
   */
  private async checkAndAddImpl(issue: RawIssue): Promise<DeduplicationCheckResult> {
    // Find potential duplicates using fast rule-based check
    const potentialDuplicates = this.findPotentialDuplicates(issue);

    if (potentialDuplicates.length === 0) {
      // No potential duplicates - accept immediately
      this.acceptedIssues.push(issue);
      if (this.options.verbose) {
        console.log(`[RealtimeDedup] Accepted: ${issue.title} (no overlapping issues)`);
      }
      return {
        isDuplicate: false,
        usedLLM: false,
        tokensUsed: 0,
      };
    }

    // Found potential duplicates - use LLM to verify
    if (this.options.verbose) {
      console.log(
        `[RealtimeDedup] Found ${potentialDuplicates.length} potential duplicate(s) for: ${issue.title}`
      );
    }

    const llmResult = await this.checkWithLLM(issue, potentialDuplicates);
    this.totalTokensUsed += llmResult.tokensUsed;

    if (llmResult.isDuplicate && llmResult.duplicateOf) {
      this.duplicatesFound++;
      if (this.options.verbose) {
        console.log(
          `[RealtimeDedup] Deduplicated: "${issue.title}" duplicates "${llmResult.duplicateOf.title}"`
        );
      }
      this.options.onDeduplicated?.(issue, llmResult.duplicateOf, llmResult.reason || '');
      return llmResult;
    }

    // Not a duplicate - accept
    this.acceptedIssues.push(issue);
    if (this.options.verbose) {
      console.log(`[RealtimeDedup] Accepted after LLM check: ${issue.title}`);
    }
    return llmResult;
  }

  /**
   * Fast rule-based check for potential duplicates
   * Returns issues that are in the same file with overlapping line ranges
   */
  private findPotentialDuplicates(issue: RawIssue): RawIssue[] {
    return this.acceptedIssues.filter((existing) => {
      // Must be same file
      if (existing.file !== issue.file) {
        return false;
      }

      // Check for line range overlap
      return this.linesOverlap(
        existing.line_start,
        existing.line_end,
        issue.line_start,
        issue.line_end
      );
    });
  }

  /**
   * Check if two line ranges overlap
   */
  private linesOverlap(start1: number, end1: number, start2: number, end2: number): boolean {
    // Two ranges [a, b] and [c, d] overlap if a <= d && c <= b
    return start1 <= end2 && start2 <= end1;
  }

  /**
   * Use LLM to check if an issue duplicates any of the potential duplicates
   */
  private async checkWithLLM(
    newIssue: RawIssue,
    potentialDuplicates: RawIssue[]
  ): Promise<DeduplicationCheckResult> {
    const prompt = this.buildLLMPrompt(newIssue, potentialDuplicates);

    try {
      const response = await this.client.messages.create({
        model: DEFAULT_REALTIME_DEDUP_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
      const resultText = response.content[0]?.type === 'text' ? response.content[0].text : '';

      return this.parseLLMResponse(resultText, potentialDuplicates, tokensUsed);
    } catch (error) {
      console.error('[RealtimeDedup] LLM check failed:', error);
      // On error, accept the issue (false negative is better than false positive)
      return {
        isDuplicate: false,
        usedLLM: true,
        tokensUsed: 0,
      };
    }
  }

  /**
   * Build prompt for LLM deduplication check
   */
  private buildLLMPrompt(newIssue: RawIssue, existingIssues: RawIssue[]): string {
    const existingList = existingIssues
      .map(
        (issue, idx) => `
### Existing Issue ${idx + 1} (ID: ${issue.id})
- **Agent**: ${issue.source_agent}
- **Category**: ${issue.category}
- **Severity**: ${issue.severity}
- **Lines**: ${issue.line_start}-${issue.line_end}
- **Title**: ${issue.title}
- **Description**: ${issue.description}
${issue.code_snippet ? `- **Code**: \`\`\`\n${issue.code_snippet}\n\`\`\`` : ''}`
      )
      .join('\n');

    return `You are a code review deduplication expert. Determine if the NEW issue is a duplicate of any EXISTING issue.

Two issues are duplicates if they:
1. Point to the **same root cause** in the code
2. Would be **fixed by the same code change**
3. Describe the **same problem** (even if from different perspectives like "performance" vs "logic")

Two issues are NOT duplicates if they:
1. Are about different code locations (even if similar type)
2. Would require separate fixes
3. Describe genuinely different problems

## EXISTING ISSUES (already accepted)
${existingList}

## NEW ISSUE (to check)
- **Agent**: ${newIssue.source_agent}
- **Category**: ${newIssue.category}
- **Severity**: ${newIssue.severity}
- **Lines**: ${newIssue.line_start}-${newIssue.line_end}
- **Title**: ${newIssue.title}
- **Description**: ${newIssue.description}
${newIssue.code_snippet ? `- **Code**: \`\`\`\n${newIssue.code_snippet}\n\`\`\`` : ''}

## Task
Determine if the NEW issue duplicates any EXISTING issue.

Output JSON only:
\`\`\`json
{
  "is_duplicate": true/false,
  "duplicate_of_id": "existing-issue-id or null",
  "reason": "Brief explanation"
}
\`\`\``;
  }

  /**
   * Parse LLM response
   */
  private parseLLMResponse(
    responseText: string,
    potentialDuplicates: RawIssue[],
    tokensUsed: number
  ): DeduplicationCheckResult {
    try {
      const jsonStr = extractJSON(responseText, { verbose: this.options.verbose });
      if (!jsonStr) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonStr) as {
        is_duplicate: boolean;
        duplicate_of_id?: string;
        reason?: string;
      };

      if (!parsed.is_duplicate) {
        return {
          isDuplicate: false,
          usedLLM: true,
          tokensUsed,
        };
      }

      // Find the existing issue
      const duplicateOf = potentialDuplicates.find((i) => i.id === parsed.duplicate_of_id);

      if (!duplicateOf) {
        // Invalid ID returned - treat as not duplicate
        if (this.options.verbose) {
          console.warn(
            `[RealtimeDedup] LLM returned invalid duplicate_of_id: ${parsed.duplicate_of_id}`
          );
        }
        return {
          isDuplicate: false,
          usedLLM: true,
          tokensUsed,
        };
      }

      return {
        isDuplicate: true,
        duplicateOf,
        reason: parsed.reason,
        usedLLM: true,
        tokensUsed,
      };
    } catch (error) {
      if (this.options.verbose) {
        console.error('[RealtimeDedup] Failed to parse LLM response:', error);
        console.error('[RealtimeDedup] Response text:', responseText.substring(0, 500));
      }
      // On parse error, accept the issue
      return {
        isDuplicate: false,
        usedLLM: true,
        tokensUsed,
      };
    }
  }

  /**
   * Get all accepted issues
   */
  getAcceptedIssues(): RawIssue[] {
    return [...this.acceptedIssues];
  }

  /**
   * Get statistics
   */
  getStats(): {
    accepted: number;
    deduplicated: number;
    tokensUsed: number;
  } {
    return {
      accepted: this.acceptedIssues.length,
      deduplicated: this.duplicatesFound,
      tokensUsed: this.totalTokensUsed,
    };
  }

  /**
   * Reset the deduplicator state
   */
  reset(): void {
    this.acceptedIssues = [];
    this.totalTokensUsed = 0;
    this.duplicatesFound = 0;
  }
}

/**
 * Create a realtime deduplicator instance
 */
export function createRealtimeDeduplicator(
  options?: RealtimeDeduplicatorOptions
): RealtimeDeduplicator {
  return new RealtimeDeduplicator(options);
}
