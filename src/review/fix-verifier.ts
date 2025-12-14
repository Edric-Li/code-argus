/**
 * Fix Verifier Agent Executor
 *
 * Runs the fix-verifier agent to check if issues from a previous review
 * have been properly addressed in the current changes.
 */

import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  PreviousReviewData,
  FixVerificationResult,
  FixVerificationSummary,
  VerificationStatus,
  FixVerificationEvidence,
} from './types.js';
import { DEFAULT_AGENT_MODEL } from './constants.js';
import type { IProgressPrinter } from '../cli/index.js';

/**
 * Screening result from Phase 1
 */
interface ScreeningResult {
  issue_id: string;
  screening_status: 'resolved' | 'unresolved' | 'unclear';
  quick_reasoning: string;
}

/**
 * Options for fix verifier
 */
export interface FixVerifierOptions {
  /** Repository path (worktree path for agent to work in) */
  repoPath: string;
  /** Previous review data containing issues to verify */
  previousReview: PreviousReviewData;
  /** Diff content for context */
  diffContent: string;
  /** Summary of file changes */
  fileChangesSummary: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Progress printer for status updates */
  progress?: IProgressPrinter;
  /** Callbacks for real-time updates */
  callbacks?: {
    onScreeningComplete?: (issueId: string, status: string) => void;
    onVerificationComplete?: (result: FixVerificationResult) => void;
  };
}

/**
 * Execute fix verifier agent
 *
 * @param options - Fix verifier options
 * @returns Fix verification summary with all results
 */
export async function executeFixVerifier(
  options: FixVerifierOptions
): Promise<FixVerificationSummary> {
  const startTime = Date.now();
  const screeningResults: ScreeningResult[] = [];
  const verificationResults: FixVerificationResult[] = [];
  let tokensUsed = 0;

  const { previousReview, repoPath, verbose, progress, callbacks } = options;

  if (verbose) {
    console.log(`[FixVerifier] Starting verification of ${previousReview.issues.length} issues...`);
  }

  progress?.info(`开始验证 ${previousReview.issues.length} 个上次问题...`);

  // Create MCP server with verification tools
  const mcpServer = createSdkMcpServer({
    name: 'fix-verifier-tools',
    version: '1.0.0',
    tools: [
      // Phase 1: Quick screening result
      tool(
        'report_screening_result',
        `Report quick screening result for an issue (Phase 1).
Call this for EACH issue after initial screening.`,
        {
          issue_id: z.string().describe('Original issue ID'),
          screening_status: z
            .enum(['resolved', 'unresolved', 'unclear'])
            .describe('Screening status'),
          quick_reasoning: z.string().describe('Brief explanation in Chinese'),
        },
        async (args) => {
          if (verbose) {
            console.log(`[FixVerifier] Screening: ${args.issue_id} → ${args.screening_status}`);
          }

          screeningResults.push({
            issue_id: args.issue_id,
            screening_status: args.screening_status,
            quick_reasoning: args.quick_reasoning,
          });

          callbacks?.onScreeningComplete?.(args.issue_id, args.screening_status);

          // Find original issue for status message
          const originalIssue = previousReview.issues.find((i) => i.id === args.issue_id);
          const issueTitle = originalIssue?.title || args.issue_id;

          const statusEmoji =
            args.screening_status === 'resolved'
              ? '✅'
              : args.screening_status === 'unresolved'
                ? '❓'
                : '🔍';

          progress?.info(`筛查: ${statusEmoji} ${issueTitle}`);

          return {
            content: [
              {
                type: 'text' as const,
                text: `✓ 筛查结果已记录: ${args.issue_id} → ${args.screening_status}`,
              },
            ],
          };
        }
      ),

      // Phase 2: Deep verification result
      tool(
        'report_verification_result',
        `Report final verification result for an issue (Phase 2).
Call this after deep investigation of unresolved/unclear issues.`,
        {
          issue_id: z.string().describe('Original issue ID'),
          status: z
            .enum(['fixed', 'missed', 'false_positive', 'obsolete', 'uncertain'])
            .describe('Final verification status'),
          confidence: z.number().min(0).max(1).describe('Confidence in the verdict (0-1)'),
          evidence: z
            .object({
              checked_files: z.array(z.string()).describe('Files that were checked'),
              examined_code: z.array(z.string()).describe('Code snippets examined'),
              related_changes: z.string().describe('Summary of related changes found'),
              reasoning: z.string().describe('Detailed reasoning in Chinese'),
            })
            .describe('Evidence collected during verification'),
          updated_issue: z
            .object({
              title: z.string().describe('Updated issue title'),
              description: z.string().describe('Updated issue description'),
              suggestion: z.string().optional().describe('Updated fix suggestion'),
            })
            .optional()
            .describe('Updated issue details (only if status is missed)'),
          false_positive_reason: z
            .string()
            .optional()
            .describe('Explanation (only if status is false_positive)'),
          notes: z.string().optional().describe('Additional notes'),
        },
        async (args) => {
          // Find original issue
          const originalIssue = previousReview.issues.find((i) => i.id === args.issue_id);

          if (!originalIssue) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `⚠️ 错误: 找不到原始问题 ${args.issue_id}`,
                },
              ],
            };
          }

          // Build verification result
          const result: FixVerificationResult = {
            original_issue_id: args.issue_id,
            original_issue: originalIssue,
            status: args.status,
            confidence: args.confidence,
            evidence: args.evidence as FixVerificationEvidence,
            false_positive_reason: args.false_positive_reason,
            notes: args.notes,
          };

          // If missed, create updated issue
          if (args.status === 'missed' && args.updated_issue) {
            result.updated_issue = {
              id: `${args.issue_id}-updated`,
              file: originalIssue.file,
              line_start: originalIssue.line_start,
              line_end: originalIssue.line_end,
              category: originalIssue.category,
              severity: originalIssue.severity,
              title: args.updated_issue.title,
              description: args.updated_issue.description,
              suggestion: args.updated_issue.suggestion,
              confidence: args.confidence,
              source_agent: 'fix-verifier',
            };
          }

          verificationResults.push(result);
          callbacks?.onVerificationComplete?.(result);

          if (verbose) {
            console.log(`[FixVerifier] Verified: ${args.issue_id} → ${args.status}`);
          }

          // Status message
          const statusEmoji = getStatusEmoji(args.status);
          const statusText = getStatusText(args.status);
          progress?.success(`验证完成: ${statusEmoji} ${originalIssue.title} → ${statusText}`);

          return {
            content: [
              {
                type: 'text' as const,
                text: `✓ 验证结果已记录: ${args.issue_id} → ${args.status} (置信度: ${Math.round(args.confidence * 100)}%)`,
              },
            ],
          };
        }
      ),
    ],
  });

  // Build prompts
  const systemPrompt = buildFixVerifierSystemPrompt();
  const userPrompt = buildFixVerifierUserPrompt(options);
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  // Execute agent
  try {
    const queryStream = query({
      prompt: fullPrompt,
      options: {
        cwd: repoPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: Math.max(30, previousReview.issues.length * 5), // Scale with issue count
        model: DEFAULT_AGENT_MODEL,
        mcpServers: {
          'fix-verifier-tools': mcpServer,
        },
      },
    });

    // Consume the stream
    for await (const message of queryStream) {
      if (message.type === 'result' && message.usage) {
        tokensUsed = message.usage.input_tokens + message.usage.output_tokens;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[FixVerifier] Error during verification: ${errorMessage}`);
    progress?.error(`修复验证失败: ${errorMessage}`);
  }

  // Process issues that were only screened (resolved in Phase 1)
  // Convert screening results to verification results for resolved issues
  for (const screening of screeningResults) {
    // Skip if already has a deep verification result
    if (verificationResults.some((v) => v.original_issue_id === screening.issue_id)) {
      continue;
    }

    const originalIssue = previousReview.issues.find((i) => i.id === screening.issue_id);
    if (!originalIssue) continue;

    if (screening.screening_status === 'resolved') {
      // Treat as fixed based on Phase 1 screening
      verificationResults.push({
        original_issue_id: screening.issue_id,
        original_issue: originalIssue,
        status: 'fixed',
        confidence: 0.8, // Lower confidence since no deep verification
        evidence: {
          checked_files: [],
          examined_code: [],
          related_changes: '',
          reasoning: screening.quick_reasoning,
        },
      });
    }
  }

  // Calculate summary
  const byStatus: Record<VerificationStatus, number> = {
    fixed: 0,
    missed: 0,
    false_positive: 0,
    obsolete: 0,
    uncertain: 0,
  };

  for (const result of verificationResults) {
    byStatus[result.status]++;
  }

  const summary: FixVerificationSummary = {
    total_verified: verificationResults.length,
    by_status: byStatus,
    results: verificationResults,
    verification_time_ms: Date.now() - startTime,
    tokens_used: tokensUsed,
  };

  if (verbose) {
    console.log(`[FixVerifier] Completed. Results:`, byStatus);
  }

  progress?.success(
    `修复验证完成: ${byStatus.fixed} 已修复, ${byStatus.missed} 漏修复, ${byStatus.false_positive} 误报`
  );

  return summary;
}

/**
 * Build system prompt for fix verifier agent
 */
function buildFixVerifierSystemPrompt(): string {
  return `You are a Fix Verification Specialist. Your task is to verify whether code issues identified in a previous review have been properly addressed in the current changes.

## Your Mission

For each issue from the previous review, determine its current status through a TWO-PHASE PROCESS:

### Phase 1: Batch Initial Screening (批量初筛)
Quickly scan ALL issues and categorize each as:
- **resolved**: Clear evidence the issue has been fixed
- **unresolved**: Issue still exists or fix is incomplete
- **unclear**: Need deeper investigation

Use the \`report_screening_result\` tool for EACH issue.

### Phase 2: Deep Investigation (深入验证)
For issues marked as **unresolved** or **unclear**, conduct thorough investigation:
1. Confirm if the issue truly still exists
2. Determine if it's a genuine miss or a false positive
3. If missed, provide updated issue description

Use the \`report_verification_result\` tool for each deeply investigated issue.

## Verification Status Definitions

- **fixed**: Issue has been properly addressed
- **missed**: Issue still exists (developer oversight)
- **false_positive**: Original detection was wrong
- **obsolete**: Code changed so much the issue is no longer relevant
- **uncertain**: Cannot determine with confidence

## Important Guidelines

1. Complete ALL Phase 1 screenings first, then proceed to Phase 2
2. Be thorough but efficient - Phase 1 should be quick
3. Provide evidence for all conclusions
4. All text output (reasoning, descriptions) must be in Chinese
5. Be fair - some original issues may have been false positives`;
}

/**
 * Build user prompt for fix verifier agent
 */
function buildFixVerifierUserPrompt(options: FixVerifierOptions): string {
  const { previousReview, diffContent, fileChangesSummary } = options;

  // Format issues list
  const issuesList = previousReview.issues
    .map((issue, idx) => {
      return `### Issue #${idx + 1}: ${issue.id}
**File**: \`${issue.file}\` (lines ${issue.line_start}-${issue.line_end})
**Severity**: ${issue.severity} | **Category**: ${issue.category}
**Title**: ${issue.title}
**Description**: ${issue.description}
${issue.suggestion ? `**Suggestion**: ${issue.suggestion}` : ''}
${issue.code_snippet ? `**Original Code**:\n\`\`\`\n${issue.code_snippet}\n\`\`\`` : ''}`;
    })
    .join('\n\n---\n\n');

  // Truncate diff if too long
  const maxDiffLength = 50000;
  const truncatedDiff =
    diffContent.length > maxDiffLength
      ? diffContent.slice(0, maxDiffLength) + '\n... (truncated)'
      : diffContent;

  return `# Fix Verification Task

## Previous Review Issues to Verify

Total issues: ${previousReview.issues.length}

${issuesList}

## Current Diff (What Changed)

\`\`\`diff
${truncatedDiff}
\`\`\`

## File Changes Summary

${fileChangesSummary || 'No summary available.'}

## Instructions

Please follow the two-phase verification process:

**Phase 1: Batch Screening**
1. Quickly scan all ${previousReview.issues.length} issues
2. For each issue, use \`report_screening_result\` to classify as resolved/unresolved/unclear
3. Be efficient - spend ~30 seconds per issue in this phase

**Phase 2: Deep Investigation**
1. For issues marked as "unresolved" or "unclear" in Phase 1, conduct thorough investigation
2. Use Read, Grep, Glob tools to gather evidence
3. Determine if it's a "missed fix" or "false positive"
4. Use \`report_verification_result\` to report final status

Begin with Phase 1 now.`;
}

/**
 * Get emoji for verification status
 */
function getStatusEmoji(status: VerificationStatus): string {
  switch (status) {
    case 'fixed':
      return '✅';
    case 'missed':
      return '🔴';
    case 'false_positive':
      return '🟡';
    case 'obsolete':
      return '⚪';
    case 'uncertain':
      return '❓';
  }
}

/**
 * Get Chinese text for verification status
 */
function getStatusText(status: VerificationStatus): string {
  switch (status) {
    case 'fixed':
      return '已修复';
    case 'missed':
      return '漏修复';
    case 'false_positive':
      return '误报';
    case 'obsolete':
      return '已过时';
    case 'uncertain':
      return '不确定';
  }
}
