/**
 * Single Issue Validator
 *
 * Validates individual issues by reading actual code and grounding claims in evidence.
 */

import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RawIssue, ValidatedIssue, SymbolLookup, IssueCategory } from './types.js';
import {
  DEFAULT_VALIDATOR_MAX_TURNS,
  DEFAULT_CHALLENGE_MODE,
  MAX_CHALLENGE_ROUNDS,
} from './constants.js';
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
  /**
   * Enable challenge mode (反问确认)
   * When enabled, the validator will challenge the AI's decision to ensure consistency
   */
  challengeMode?: boolean;
}

/**
 * Internal resolved options (with defaults applied)
 */
interface ResolvedValidatorOptions {
  repoPath: string;
  verbose: boolean;
  maxTurns: number;
  onProgress?: ValidationProgressCallback;
  challengeMode: boolean;
}

/**
 * Parsed validation response
 */
interface ParsedValidationResponse {
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
      challengeMode: DEFAULT_CHALLENGE_MODE,
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

    // Use challenge mode if enabled
    if (this.options.challengeMode) {
      return this.validateWithChallenge(issue);
    }

    // Standard single-round validation
    return this.validateSingleRound(issue);
  }

  /**
   * Single round validation (original behavior)
   */
  private async validateSingleRound(issue: RawIssue): Promise<ValidationResult> {
    // Build validation prompt with category-specific rules
    const systemPrompt = this.buildSystemPrompt(issue.category);
    const userPrompt = this.buildUserPrompt(issue);
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const { resultText, tokensUsed } = await this.runQuery(fullPrompt, issue.id);

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
   * Validate with challenge mode (反问确认)
   *
   * Strategy:
   * 1. Round 1: Initial validation
   * 2. Round 2+: Challenge until two consecutive rounds agree or MAX_CHALLENGE_ROUNDS reached
   * 3. If two consecutive rounds agree -> use that result
   * 4. If AI keeps changing -> treat as uncertain (uncertainty suggests real issue worth investigating)
   */
  private async validateWithChallenge(issue: RawIssue): Promise<ValidationResult> {
    let totalTokensUsed = 0;
    const responses: ParsedValidationResponse[] = [];

    // Build base prompts
    const systemPrompt = this.buildSystemPrompt(issue.category);
    const userPrompt = this.buildUserPrompt(issue);

    // Round 1: Initial validation
    if (this.options.verbose) {
      console.log(`[Validator] Issue ${issue.id}: Round 1 - Initial validation`);
    }

    const round1Prompt = `${systemPrompt}\n\n${userPrompt}`;
    const round1Result = await this.runQuery(round1Prompt, issue.id);
    totalTokensUsed += round1Result.tokensUsed;

    const round1Response = this.parseResponse(round1Result.resultText);
    if (!round1Response) {
      return {
        issue: this.createUncertainIssue(issue, '第一轮验证解析失败'),
        tokensUsed: totalTokensUsed,
      };
    }
    responses.push(round1Response);

    if (this.options.verbose) {
      console.log(
        `[Validator] Issue ${issue.id}: Round 1 result: ${round1Response.validation_status}`
      );
    }

    // Challenge rounds (2 to MAX_CHALLENGE_ROUNDS)
    for (let round = 2; round <= MAX_CHALLENGE_ROUNDS; round++) {
      // prevResponse is guaranteed to exist since we pushed round1Response before the loop
      const prevResponse = responses[responses.length - 1]!;
      const prevPrevResponse = responses.length >= 2 ? responses[responses.length - 2] : undefined;

      // Determine if this is a "changed mind" challenge or first challenge
      const isChangedMind =
        prevPrevResponse && prevPrevResponse.validation_status !== prevResponse.validation_status;

      if (this.options.verbose) {
        if (isChangedMind) {
          console.log(
            `[Validator] Issue ${issue.id}: Round ${round} - AI changed mind (${prevPrevResponse!.validation_status} -> ${prevResponse.validation_status})`
          );
        } else {
          console.log(`[Validator] Issue ${issue.id}: Round ${round} - Challenge`);
        }
      }

      const challengePrompt = this.buildChallengePrompt(
        issue,
        prevResponse,
        isChangedMind ? 2 : 1,
        prevPrevResponse
      );
      const result = await this.runQuery(challengePrompt, issue.id);
      totalTokensUsed += result.tokensUsed;

      const response = this.parseResponse(result.resultText);
      if (!response) {
        // Use previous result if parsing fails
        return {
          issue: this.responseToValidatedIssue(
            prevResponse,
            issue,
            `第${round}轮验证解析失败，使用第${round - 1}轮结果`
          ),
          tokensUsed: totalTokensUsed,
        };
      }
      responses.push(response);

      if (this.options.verbose) {
        console.log(
          `[Validator] Issue ${issue.id}: Round ${round} result: ${response.validation_status}`
        );
      }

      // Check if current and previous rounds agree
      if (prevResponse.validation_status === response.validation_status) {
        if (this.options.verbose) {
          console.log(
            `[Validator] Issue ${issue.id}: Rounds ${round - 1} & ${round} agree (${response.validation_status}), validation complete`
          );
        }
        return {
          issue: this.responseToValidatedIssue(response, issue, '两轮验证一致'),
          tokensUsed: totalTokensUsed,
        };
      }
    }

    // AI keeps changing - treat as uncertain but leaning toward confirmed
    // (If AI can't make up its mind, there's likely something worth investigating)
    if (this.options.verbose) {
      console.log(
        `[Validator] Issue ${issue.id}: AI inconsistent across ${MAX_CHALLENGE_ROUNDS} rounds, marking as uncertain (likely valid issue)`
      );
    }

    const detailedReasoning = this.buildInconsistentReasoning(responses);

    return {
      issue: this.createUncertainIssue(issue, detailedReasoning, 0.7),
      tokensUsed: totalTokensUsed,
    };
  }

  /**
   * Build detailed reasoning when AI is inconsistent across rounds
   */
  private buildInconsistentReasoning(responses: ParsedValidationResponse[]): string {
    const roundLabels = ['第一轮', '第二轮', '第三轮'];
    const summaries = responses.map((r, i) => {
      const label = roundLabels[i] || `第${i + 1}轮`;
      const status = r.validation_status;
      // Truncate reasoning to keep it concise
      const reasoning =
        r.grounding_evidence.reasoning.length > 100
          ? r.grounding_evidence.reasoning.substring(0, 100) + '...'
          : r.grounding_evidence.reasoning;
      return `${label}(${status}): ${reasoning}`;
    });

    return `AI判断不一致，建议人工审查:\n${summaries.join('\n')}`;
  }

  /**
   * Run a query and return result text and tokens
   */
  private async runQuery(
    prompt: string,
    issueId: string
  ): Promise<{ resultText: string; tokensUsed: number }> {
    let tokensUsed = 0;
    let resultText = '';

    const queryStream = query({
      prompt,
      options: {
        cwd: this.options.repoPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: this.options.maxTurns,
        settingSources: ['project'],
      },
    });

    let resultSubtype = '';
    for await (const message of queryStream) {
      if (message.type === 'result') {
        const resultMessage = message as SDKResultMessage;
        resultSubtype = resultMessage.subtype;
        if (resultMessage.subtype === 'success') {
          resultText = resultMessage.result;
          tokensUsed = resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;
        } else {
          console.error(`[Validator] Issue ${issueId} ended with: ${resultMessage.subtype}`);
        }
      }
    }

    if (!resultText || resultText.trim() === '') {
      console.error(
        `[Validator] Issue ${issueId} returned empty result (subtype: ${resultSubtype})`
      );
    }

    return { resultText, tokensUsed };
  }

  /**
   * Build challenge prompt for subsequent rounds
   */
  private buildChallengePrompt(
    issue: RawIssue,
    previousResponse: ParsedValidationResponse,
    round: number,
    previousPreviousResponse?: ParsedValidationResponse
  ): string {
    const systemPrompt = this.buildSystemPrompt(issue.category);

    let challengeText: string;

    if (round === 1) {
      // First challenge
      challengeText = `你之前对这个问题的判断是: **${previousResponse.validation_status}**

理由: ${previousResponse.grounding_evidence.reasoning}

**请再次仔细审视代码并确认你的判断。你确定吗？**

请重新检查:
1. 重新阅读 ${issue.file}:${issue.line_start}-${issue.line_end} 的代码
2. 考虑是否有遗漏的上下文
3. 确认你的判断是否正确

如果你的判断有变化，请解释原因。
如果判断不变，请确认并解释为什么你确定。

请输出 JSON 结果:`;
    } else {
      // AI changed its mind, challenge again
      challengeText = `我注意到你改变了判断:
- 第一次判断: **${previousPreviousResponse!.validation_status}**
- 第二次判断: **${previousResponse.validation_status}**

**你改主意了。现在这个答案你确定吗？**

请最后一次仔细审视:
1. 重新阅读 ${issue.file}:${issue.line_start}-${issue.line_end} 的代码
2. 权衡两次判断的理由
3. 给出你最终的、确定的判断

请输出 JSON 结果:`;
    }

    const userPrompt = `关于这个问题:

**Issue ID**: ${issue.id}
**File**: ${issue.file}
**Lines**: ${issue.line_start}-${issue.line_end}
**Category**: ${issue.category}
**Severity**: ${issue.severity}
**Title**: ${issue.title}
**Description**: ${issue.description}

${challengeText}

\`\`\`json
{
  "validation_status": "confirmed" | "rejected" | "uncertain",
  "final_confidence": 0.0-1.0,
  "grounding_evidence": {
    "checked_files": ["..."],
    "checked_symbols": ["..."],
    "related_context": "...",
    "reasoning": "..."
  },
  "rejection_reason": "..." // if rejected
}
\`\`\``;

    return `${systemPrompt}\n\n${userPrompt}`;
  }

  /**
   * Parse response text to ParsedValidationResponse
   */
  private parseResponse(resultText: string): ParsedValidationResponse | null {
    try {
      const jsonStr = extractJSON(resultText, { verbose: this.options.verbose });
      if (!jsonStr) {
        return null;
      }
      return JSON.parse(jsonStr) as ParsedValidationResponse;
    } catch {
      return null;
    }
  }

  /**
   * Convert ParsedValidationResponse to ValidatedIssue
   */
  private responseToValidatedIssue(
    response: ParsedValidationResponse,
    originalIssue: RawIssue,
    note?: string
  ): ValidatedIssue {
    const checkedSymbols = (response.grounding_evidence.checked_symbols || []).map((sym) =>
      typeof sym === 'string' ? { name: sym, type: 'reference' as const, locations: [] } : sym
    );

    const reasoning = note
      ? `${response.grounding_evidence.reasoning} [${note}]`
      : response.grounding_evidence.reasoning;

    return {
      ...originalIssue,
      validation_status: response.validation_status,
      grounding_evidence: {
        ...response.grounding_evidence,
        checked_symbols: checkedSymbols,
        reasoning,
      },
      final_confidence: response.final_confidence,
      rejection_reason: response.rejection_reason,
      revised_description: response.revised_description,
      revised_severity: response.revised_severity,
    };
  }

  /**
   * Create an uncertain validated issue
   */
  private createUncertainIssue(
    originalIssue: RawIssue,
    reason: string,
    confidence?: number
  ): ValidatedIssue {
    return {
      ...originalIssue,
      validation_status: 'uncertain',
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: '',
        reasoning: reason,
      },
      final_confidence: confidence ?? originalIssue.confidence * 0.5,
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
