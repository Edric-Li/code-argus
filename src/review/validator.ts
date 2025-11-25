/**
 * Single Issue Validator
 *
 * Validates individual issues by reading actual code and grounding claims in evidence.
 */

import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RawIssue, ValidatedIssue, SymbolLookup, IssueCategory } from './types.js';
import { DEFAULT_VALIDATOR_MAX_TURNS } from './constants.js';
import { extractJSON } from './utils/json-parser.js';
import { withConcurrency } from '../utils/index.js';
import { buildValidationSystemPrompt } from './prompts/validation.js';

/**
 * Progress callback for validation
 */
export type ValidationProgressCallback = (current: number, total: number, issueId: string) => void;

/**
 * Validator options
 */
export interface ValidatorOptions {
  /** Repository path */
  repoPath: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Maximum turns for validation */
  maxTurns?: number;
  /** Progress callback */
  onProgress?: ValidationProgressCallback;
}

/**
 * Internal resolved options (with defaults applied)
 */
interface ResolvedValidatorOptions {
  repoPath: string;
  verbose: boolean;
  maxTurns: number;
  onProgress?: ValidationProgressCallback;
}

/**
 * Validation result with token usage
 */
export interface ValidationResult {
  /** Validated issue */
  issue: ValidatedIssue;
  /** Tokens used */
  tokensUsed: number;
}

/**
 * Single Issue Validator
 *
 * Validates one issue at a time by reading code and collecting evidence.
 */
export class IssueValidator {
  private options: ResolvedValidatorOptions;

  constructor(options: ValidatorOptions) {
    this.options = {
      verbose: false,
      maxTurns: DEFAULT_VALIDATOR_MAX_TURNS,
      ...options,
    };
  }

  /**
   * Validate a single issue
   */
  async validate(issue: RawIssue): Promise<ValidationResult> {
    if (this.options.verbose) {
      console.log(`[Validator] Validating issue: ${issue.id} - ${issue.title}`);
    }

    // Build validation prompt with category-specific rules
    const systemPrompt = this.buildSystemPrompt(issue.category);
    const userPrompt = this.buildUserPrompt(issue);
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    let tokensUsed = 0;
    let resultText = '';

    // Run validation using Claude Agent SDK
    const queryStream = query({
      prompt: fullPrompt,
      options: {
        cwd: this.options.repoPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: this.options.maxTurns,
      },
    });

    // Consume the stream
    let resultSubtype = '';
    for await (const message of queryStream) {
      if (message.type === 'result') {
        const resultMessage = message as SDKResultMessage;
        resultSubtype = resultMessage.subtype;
        if (resultMessage.subtype === 'success') {
          resultText = resultMessage.result;
          tokensUsed = resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;
        } else {
          console.error(`[Validator] Issue ${issue.id} ended with: ${resultMessage.subtype}`);
        }
      }
    }

    // Check for empty result
    if (!resultText || resultText.trim() === '') {
      console.error(
        `[Validator] Issue ${issue.id} returned empty result (subtype: ${resultSubtype})`
      );
    }

    // Parse validation result
    const validatedIssue = this.parseValidationResult(resultText, issue);

    if (this.options.verbose) {
      console.log(`[Validator] Issue ${issue.id} validated: ${validatedIssue.validation_status}`);
    }

    return {
      issue: validatedIssue,
      tokensUsed,
    };
  }

  /**
   * Validate multiple issues concurrently using a worker pool.
   *
   * Uses a true concurrent pool pattern where N workers run continuously.
   * When one task completes, the worker immediately picks up the next task.
   * This is more efficient than batch processing which waits for all tasks
   * in a batch to complete before starting the next batch.
   */
  async validateBatch(
    issues: RawIssue[],
    concurrency = 5
  ): Promise<{ issues: ValidatedIssue[]; tokensUsed: number }> {
    if (issues.length === 0) {
      return { issues: [], tokensUsed: 0 };
    }

    if (this.options.verbose) {
      console.log(
        `[Validator] Validating ${issues.length} issues with concurrency pool (max ${concurrency})`
      );
    }

    // Track progress
    let completedCount = 0;
    const total = issues.length;

    // Create task functions for each issue with progress tracking
    const tasks = issues.map((issue) => async () => {
      const result = await this.validate(issue);
      completedCount++;
      // Call progress callback after each validation completes
      if (this.options.onProgress) {
        this.options.onProgress(completedCount, total, issue.id);
      }
      return result;
    });

    // Run with concurrent pool - when one finishes, next starts immediately
    const results = await withConcurrency(tasks, concurrency);

    const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);

    if (this.options.verbose) {
      console.log(`[Validator] All ${issues.length} issues validated`);
    }

    return {
      issues: results.map((r) => r.issue),
      tokensUsed: totalTokens,
    };
  }

  /**
   * Build system prompt for validator based on issue category
   *
   * Different issue categories have different validation focus and rejection criteria.
   */
  private buildSystemPrompt(category: IssueCategory): string {
    return buildValidationSystemPrompt(category);
  }

  /**
   * Build user prompt for a specific issue
   */
  private buildUserPrompt(issue: RawIssue): string {
    return `Please validate the following issue:

**Issue ID**: ${issue.id}
**File**: ${issue.file}
**Lines**: ${issue.line_start}-${issue.line_end}
**Category**: ${issue.category}
**Severity**: ${issue.severity}
**Title**: ${issue.title}
**Description**: ${issue.description}
${issue.suggestion ? `**Suggestion**: ${issue.suggestion}` : ''}
${issue.code_snippet ? `**Code Snippet**:\n\`\`\`\n${issue.code_snippet}\n\`\`\`` : ''}
**Initial Confidence**: ${issue.confidence}
**Source Agent**: ${issue.source_agent}

Please verify this issue by:
1. Reading the actual code at ${issue.file}:${issue.line_start}-${issue.line_end}
2. Checking for any mitigating factors (error handling, tests, etc.)
3. Making a validation decision

After your analysis, output ONLY the JSON result in a markdown code block like this:
\`\`\`json
{
  "validation_status": "...",
  ...
}
\`\`\``;
  }

  /**
   * Parse validation result from agent output
   */
  private parseValidationResult(resultText: string, originalIssue: RawIssue): ValidatedIssue {
    try {
      // Use shared JSON extraction utility
      const jsonStr = extractJSON(resultText, { verbose: this.options.verbose });

      if (!jsonStr) {
        throw new Error('No valid JSON found in response');
      }

      const parsed = JSON.parse(jsonStr) as {
        validation_status: 'confirmed' | 'rejected' | 'uncertain';
        final_confidence: number;
        grounding_evidence: {
          checked_files: string[];
          checked_symbols: Array<string | SymbolLookup>;
          related_context: string;
          reasoning: string;
        };
        rejection_reason?: string;
        revised_description?: string;
        revised_severity?: 'critical' | 'error' | 'warning' | 'suggestion';
      };

      // Convert string symbols to SymbolLookup objects if needed
      const checkedSymbols = (parsed.grounding_evidence.checked_symbols || []).map((sym) =>
        typeof sym === 'string' ? { name: sym, type: 'reference' as const, locations: [] } : sym
      );

      return {
        ...originalIssue,
        validation_status: parsed.validation_status,
        grounding_evidence: {
          ...parsed.grounding_evidence,
          checked_symbols: checkedSymbols,
        },
        final_confidence: parsed.final_confidence,
        rejection_reason: parsed.rejection_reason,
        revised_description: parsed.revised_description,
        revised_severity: parsed.revised_severity,
      };
    } catch (error) {
      console.error(
        `[Validator] Issue ${originalIssue.id}: Failed to parse validation result:`,
        error
      );
      console.error(
        `[Validator] Issue ${originalIssue.id}: Result text length: ${resultText.length}`
      );
      if (resultText.length > 0) {
        console.error(
          `[Validator] Issue ${originalIssue.id}: Result text:`,
          resultText.substring(0, 1000)
        );
      }

      // Return as uncertain if parsing fails (not pending, since validation was attempted)
      return {
        ...originalIssue,
        validation_status: 'uncertain',
        grounding_evidence: {
          checked_files: [],
          checked_symbols: [],
          related_context: '',
          reasoning: 'Validation failed: Unable to parse result',
        },
        final_confidence: originalIssue.confidence * 0.5,
      };
    }
  }
}

/**
 * Create a validator instance
 */
export function createValidator(options: ValidatorOptions): IssueValidator {
  return new IssueValidator(options);
}
