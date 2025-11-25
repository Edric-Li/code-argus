/**
 * LLM-based Issue Deduplicator
 *
 * Uses LLM to perform semantic deduplication of issues.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ValidatedIssue } from './types.js';
import { DEFAULT_DEDUP_MODEL } from './constants.js';
import { extractJSON } from './utils/json-parser.js';

/**
 * Deduplicator options
 */
export interface DeduplicatorOptions {
  /** Anthropic API key */
  apiKey?: string;
  /** Model to use for deduplication (default: haiku for cost efficiency) */
  model?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Deduplication result
 */
export interface DeduplicationResult {
  /** Unique issues after deduplication */
  uniqueIssues: ValidatedIssue[];
  /** Duplicate groups (original issue IDs that were merged) */
  duplicateGroups: Array<{
    /** The kept issue ID */
    kept: string;
    /** The removed duplicate issue IDs */
    duplicates: string[];
    /** Reason for deduplication */
    reason: string;
  }>;
  /** Tokens used for deduplication */
  tokensUsed: number;
}

/**
 * LLM-based Issue Deduplicator
 *
 * Uses semantic understanding to identify duplicate issues.
 */
export class IssueDeduplicator {
  private client: Anthropic;
  private options: Required<DeduplicatorOptions>;

  constructor(options: DeduplicatorOptions = {}) {
    this.options = {
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY || '',
      model: options.model || DEFAULT_DEDUP_MODEL,
      verbose: options.verbose || false,
    };

    this.client = new Anthropic({
      apiKey: this.options.apiKey,
    });
  }

  /**
   * Deduplicate a list of validated issues
   */
  async deduplicate(issues: ValidatedIssue[]): Promise<DeduplicationResult> {
    if (issues.length === 0) {
      return {
        uniqueIssues: [],
        duplicateGroups: [],
        tokensUsed: 0,
      };
    }

    if (issues.length === 1) {
      return {
        uniqueIssues: issues,
        duplicateGroups: [],
        tokensUsed: 0,
      };
    }

    if (this.options.verbose) {
      console.log(`[Deduplicator] Deduplicating ${issues.length} issues`);
    }

    // Build deduplication prompt
    const prompt = this.buildPrompt(issues);

    try {
      // Call LLM for deduplication
      const response = await this.client.messages.create({
        model: this.options.model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

      // Parse response
      const resultText =
        response.content[0]?.type === 'text' && 'text' in response.content[0]
          ? response.content[0].text
          : '';
      const result = this.parseDeduplicationResult(resultText, issues);

      if (this.options.verbose) {
        console.log(`[Deduplicator] Found ${result.duplicateGroups.length} duplicate groups`);
        console.log(
          `[Deduplicator] Reduced from ${issues.length} to ${result.uniqueIssues.length} issues`
        );
      }

      return {
        ...result,
        tokensUsed,
      };
    } catch (error) {
      console.error('[Deduplicator] Failed to deduplicate:', error);
      // Return original issues if deduplication fails
      return {
        uniqueIssues: issues,
        duplicateGroups: [],
        tokensUsed: 0,
      };
    }
  }

  /**
   * Build deduplication prompt
   */
  private buildPrompt(issues: ValidatedIssue[]): string {
    // Prepare issue summaries
    const issueSummaries = issues.map((issue, idx) => ({
      index: idx,
      id: issue.id,
      file: issue.file,
      lines: `${issue.line_start}-${issue.line_end}`,
      category: issue.category,
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      validation_status: issue.validation_status,
      confidence: issue.final_confidence,
    }));

    return `You are an expert code reviewer tasked with deduplicating code review issues.

Two issues are considered duplicates if they:
1. **Point to the same root cause** (even if in different locations)
2. **Describe the same problem** (even if worded differently)
3. **Would be fixed by the same code change**

Two issues are NOT duplicates if they:
1. Are the same type of issue but in different locations (e.g., two different SQL injection vulnerabilities)
2. Are related but describe different aspects of a problem
3. Would require separate fixes

**Issues to analyze**:
${JSON.stringify(issueSummaries, null, 2)}

**Your task**:
1. Analyze all issues for semantic similarity
2. Group duplicates together
3. For each group, select the best issue to keep (highest confidence, most detailed, confirmed validation status)
4. Explain why issues are duplicates

**Output format** (JSON):
\`\`\`json
{
  "duplicate_groups": [
    {
      "kept_id": "issue-id-to-keep",
      "duplicate_ids": ["issue-id-1", "issue-id-2"],
      "reason": "Both issues describe the same SQL injection vulnerability in the login function"
    }
  ]
}
\`\`\`

**Important**:
- Only group issues that are truly duplicates (same root cause)
- If unsure, keep them separate
- Each issue should appear in at most one duplicate group
- Output valid JSON only`;
  }

  /**
   * Parse deduplication result
   */
  private parseDeduplicationResult(
    resultText: string,
    originalIssues: ValidatedIssue[]
  ): Omit<DeduplicationResult, 'tokensUsed'> {
    // Create issue map
    const issueMap = new Map<string, ValidatedIssue>();
    for (const issue of originalIssues) {
      issueMap.set(issue.id, issue);
    }

    try {
      // Use shared JSON extraction utility
      const jsonStr = extractJSON(resultText, { verbose: this.options.verbose });

      if (!jsonStr) {
        throw new Error('No valid JSON found in response');
      }

      const parsed = JSON.parse(jsonStr) as {
        duplicate_groups?: Array<{
          kept_id: string;
          duplicate_ids: string[];
          reason: string;
        }>;
      };

      if (!parsed.duplicate_groups || parsed.duplicate_groups.length === 0) {
        // No duplicates found
        return {
          uniqueIssues: originalIssues,
          duplicateGroups: [],
        };
      }

      // Track which issues to remove
      const removedIds = new Set<string>();
      const duplicateGroups: DeduplicationResult['duplicateGroups'] = [];

      for (const group of parsed.duplicate_groups) {
        // Validate that kept issue exists
        if (!issueMap.has(group.kept_id)) {
          console.warn(`[Deduplicator] Invalid kept_id: ${group.kept_id}`);
          continue;
        }

        // Validate duplicate IDs
        const validDuplicates = group.duplicate_ids.filter((id) => {
          if (!issueMap.has(id)) {
            console.warn(`[Deduplicator] Invalid duplicate_id: ${id}`);
            return false;
          }
          if (id === group.kept_id) {
            console.warn(`[Deduplicator] Duplicate ID same as kept ID: ${id}`);
            return false;
          }
          return true;
        });

        if (validDuplicates.length > 0) {
          duplicateGroups.push({
            kept: group.kept_id,
            duplicates: validDuplicates,
            reason: group.reason,
          });

          // Mark duplicates for removal
          validDuplicates.forEach((id) => removedIds.add(id));
        }
      }

      // Filter out removed issues
      const uniqueIssues = originalIssues.filter((issue) => !removedIds.has(issue.id));

      return {
        uniqueIssues,
        duplicateGroups,
      };
    } catch (error) {
      console.error('[Deduplicator] Failed to parse deduplication result:', error);
      console.error('[Deduplicator] Result text:', resultText.substring(0, 500));

      // Return original issues if parsing fails
      return {
        uniqueIssues: originalIssues,
        duplicateGroups: [],
      };
    }
  }
}

/**
 * Create a deduplicator instance
 */
export function createDeduplicator(options?: DeduplicatorOptions): IssueDeduplicator {
  return new IssueDeduplicator(options);
}
