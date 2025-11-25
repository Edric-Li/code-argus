/**
 * Single Issue Validator
 *
 * Validates individual issues by reading actual code and grounding claims in evidence.
 */

import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RawIssue, ValidatedIssue, SymbolLookup } from './types.js';
import { DEFAULT_VALIDATOR_MAX_TURNS } from './constants.js';
import { extractJSON } from './utils/json-parser.js';

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
  private options: Required<ValidatorOptions>;

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

    // Build validation prompt
    const systemPrompt = this.buildSystemPrompt();
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
    for await (const message of queryStream) {
      if (message.type === 'result') {
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === 'success') {
          resultText = resultMessage.result;
          tokensUsed = resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;
        } else {
          if (this.options.verbose) {
            console.error(`[Validator] Validation error:`, resultMessage.subtype);
          }
        }
      }
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
   * Validate multiple issues concurrently
   */
  async validateBatch(
    issues: RawIssue[],
    concurrency = 3
  ): Promise<{ issues: ValidatedIssue[]; tokensUsed: number }> {
    if (issues.length === 0) {
      return { issues: [], tokensUsed: 0 };
    }

    if (this.options.verbose) {
      console.log(`[Validator] Validating ${issues.length} issues with concurrency ${concurrency}`);
    }

    const results: ValidationResult[] = [];
    let totalTokens = 0;

    // Process in batches
    for (let i = 0; i < issues.length; i += concurrency) {
      const batch = issues.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map((issue) => this.validate(issue)));

      results.push(...batchResults);
      totalTokens += batchResults.reduce((sum, r) => sum + r.tokensUsed, 0);
    }

    return {
      issues: results.map((r) => r.issue),
      tokensUsed: totalTokens,
    };
  }

  /**
   * Build system prompt for validator
   */
  private buildSystemPrompt(): string {
    return `You are an expert code reviewer specializing in validating issues discovered by other agents.
Your job is to verify each issue by reading the actual code and grounding claims in evidence.

**CRITICAL REQUIREMENTS**:
1. **USE SEQUENTIAL THINKING**: Before validating, use the mcp__sequential-thinking__sequentialthinking tool to plan your validation strategy
2. All explanations in "related_context" and "reasoning" must be in Chinese
3. **OUTPUT ONLY JSON**: Your final response must be ONLY the JSON object, with no explanatory text before or after

**Validation workflow**:
1. Use sequential-thinking to understand what needs to be verified
2. Use Read tool to examine the actual code at the reported location
3. Use Grep/Glob if you need to find related code (error handlers, tests, etc.)
4. Analyze the evidence and make a decision:
   - **confirmed**: The issue exists as described
   - **rejected**: The issue does not exist or is incorrect
   - **uncertain**: Cannot determine with confidence
5. Output your result as ONLY a JSON object (no markdown code blocks, no explanatory text)

**Required output format** (pure JSON only):
{
  "validation_status": "confirmed" | "rejected" | "uncertain",
  "final_confidence": 0.0-1.0,
  "grounding_evidence": {
    "checked_files": ["file1.ts", "file2.ts"],
    "checked_symbols": [
      {"name": "functionName", "type": "definition", "locations": ["file.ts:10"]}
    ],
    "related_context": "相关代码的中文说明",
    "reasoning": "详细的验证推理过程（中文）"
  },
  "rejection_reason": "如果rejected，说明原因（中文）",
  "revised_description": "如果需要修正描述（中文）",
  "revised_severity": "critical" | "error" | "warning" | "suggestion"
}

**IMPORTANT**: Do not wrap the JSON in markdown code blocks. Do not add any text before or after the JSON. Output ONLY the JSON object.`;
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

Output your result as JSON.`;
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
      console.error('[Validator] Failed to parse validation result:', error);
      console.error('[Validator] Result text:', resultText.substring(0, 500));

      // Return as pending if parsing fails
      return {
        ...originalIssue,
        validation_status: 'pending',
        grounding_evidence: {
          checked_files: [],
          checked_symbols: [],
          related_context: '',
          reasoning: 'Validation failed: Unable to parse result',
        },
        final_confidence: originalIssue.confidence,
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
