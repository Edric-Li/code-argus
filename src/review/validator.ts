/**
 * Single Issue Validator
 *
 * Validates individual issues by reading actual code and grounding claims in evidence.
 *
 * Performance optimizations:
 * 1. Session reuse for challenge mode - multiple challenge rounds in a single session
 * 2. File-based grouping - issues from the same file are validated together in one session
 *    This avoids redundant file reads since the Agent only needs to read each file once.
 */

import {
  query,
  type SDKResultMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { RawIssue, ValidatedIssue, SymbolLookup, IssueCategory } from './types.js';
import {
  DEFAULT_VALIDATOR_MAX_TURNS,
  DEFAULT_CHALLENGE_MODE,
  MAX_CHALLENGE_ROUNDS,
  MAX_ISSUES_PER_GROUP,
} from './constants.js';
import { extractJSON } from './utils/json-parser.js';
import { withConcurrency } from '../utils/index.js';
import { buildValidationSystemPrompt } from './prompts/validation.js';

/**
 * Issue group for batch validation
 */
interface IssueGroup {
  /** Primary file for this group */
  file: string;
  /** Issues in this group */
  issues: RawIssue[];
}

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
  /**
   * Maximum issues per validation group
   * Issues from the same file are grouped together, but limited to this number.
   * Default: 5
   */
  maxIssuesPerGroup?: number;
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
  maxIssuesPerGroup: number;
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
 * Validates issues by reading code and collecting evidence.
 * Supports both single-issue and grouped validation for performance.
 */
export class IssueValidator {
  private options: ResolvedValidatorOptions;

  constructor(options: ValidatorOptions) {
    this.options = {
      verbose: false,
      maxTurns: DEFAULT_VALIDATOR_MAX_TURNS,
      challengeMode: DEFAULT_CHALLENGE_MODE,
      maxIssuesPerGroup: MAX_ISSUES_PER_GROUP,
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
   * Validate with challenge mode (反问确认) - Session Reuse Optimized
   *
   * Strategy:
   * 1. Round 1: Initial validation (Agent reads code, uses tools)
   * 2. Round 2+: Challenge within SAME session (no redundant tool calls!)
   * 3. If two consecutive rounds agree -> use that result
   * 4. If AI keeps changing -> treat as uncertain (uncertainty suggests real issue worth investigating)
   *
   * Performance: By reusing the session, Round 2+ don't need to re-read files
   * since the context is preserved in conversation history.
   */
  private async validateWithChallenge(issue: RawIssue): Promise<ValidationResult> {
    const responses: ParsedValidationResponse[] = [];

    // Build initial prompt
    const systemPrompt = this.buildSystemPrompt(issue.category);
    const userPrompt = this.buildUserPrompt(issue);
    const initialPrompt = `${systemPrompt}\n\n${userPrompt}`;

    if (this.options.verbose) {
      console.log(`[Validator] Issue ${issue.id}: Starting session-reuse challenge mode`);
    }

    // Create message queue for multi-turn conversation
    const messageQueue: SDKUserMessage[] = [];
    let resolveNextMessage: ((msg: SDKUserMessage | null) => void) | null = null;
    let sessionId = '';

    // Async generator that yields messages on demand
    async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
      // First message is the initial validation prompt
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: initialPrompt },
        parent_tool_use_id: null,
        session_id: sessionId,
      };

      // Subsequent messages come from the queue
      while (true) {
        const msg = await new Promise<SDKUserMessage | null>((resolve) => {
          // Check if there's already a message in queue
          if (messageQueue.length > 0) {
            resolve(messageQueue.shift()!);
          } else {
            // Wait for next message
            resolveNextMessage = resolve;
          }
        });

        if (msg === null) {
          // End of conversation
          return;
        }
        yield msg;
      }
    }

    // Helper to send a follow-up message
    const sendFollowUp = (content: string) => {
      const msg: SDKUserMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
      if (resolveNextMessage) {
        const resolve = resolveNextMessage;
        resolveNextMessage = null;
        resolve(msg);
      } else {
        messageQueue.push(msg);
      }
    };

    // Helper to end the conversation
    const endConversation = () => {
      if (resolveNextMessage) {
        const resolve = resolveNextMessage;
        resolveNextMessage = null;
        resolve(null);
      }
    };

    // Start the query with message generator
    const queryStream = query({
      prompt: messageGenerator(),
      options: {
        cwd: this.options.repoPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: this.options.maxTurns,
        settingSources: ['project'],
      },
    });

    let totalTokensUsed = 0;
    let currentRound = 1;
    let lastAssistantText = '';

    try {
      for await (const message of queryStream) {
        // Capture session ID from first message
        if (message.session_id && !sessionId) {
          sessionId = message.session_id;
        }

        // Collect assistant responses
        if (message.type === 'assistant') {
          const assistantMsg = message as SDKAssistantMessage;
          // Extract text from assistant message
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              lastAssistantText = block.text;
            }
          }
        }

        // Handle result (end of a turn)
        if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;

          if (resultMessage.subtype === 'success') {
            totalTokensUsed = resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;

            // Parse the response
            const responseText = resultMessage.result || lastAssistantText;
            const response = this.parseResponse(responseText);

            if (!response) {
              if (currentRound === 1) {
                endConversation();
                return {
                  issue: this.createUncertainIssue(issue, '第一轮验证解析失败'),
                  tokensUsed: totalTokensUsed,
                };
              } else {
                // Use previous result
                const prevResponse = responses[responses.length - 1]!;
                endConversation();
                return {
                  issue: this.responseToValidatedIssue(
                    prevResponse,
                    issue,
                    `第${currentRound}轮验证解析失败，使用第${currentRound - 1}轮结果`
                  ),
                  tokensUsed: totalTokensUsed,
                };
              }
            }

            responses.push(response);

            if (this.options.verbose) {
              console.log(
                `[Validator] Issue ${issue.id}: Round ${currentRound} result: ${response.validation_status}`
              );
            }

            // Check if we should continue challenging
            if (currentRound >= 2) {
              const prevResponse = responses[responses.length - 2]!;
              if (prevResponse.validation_status === response.validation_status) {
                // Two consecutive rounds agree - we're done
                if (this.options.verbose) {
                  console.log(
                    `[Validator] Issue ${issue.id}: Rounds ${currentRound - 1} & ${currentRound} agree (${response.validation_status})`
                  );
                }
                endConversation();
                return {
                  issue: this.responseToValidatedIssue(response, issue, '两轮验证一致'),
                  tokensUsed: totalTokensUsed,
                };
              }
            }

            // Check if we've reached max rounds
            if (currentRound >= MAX_CHALLENGE_ROUNDS) {
              if (this.options.verbose) {
                console.log(
                  `[Validator] Issue ${issue.id}: AI inconsistent across ${MAX_CHALLENGE_ROUNDS} rounds, using majority vote`
                );
              }
              endConversation();
              // Use majority vote to decide final result
              return {
                issue: this.getFinalDecisionFromResponses(responses, issue),
                tokensUsed: totalTokensUsed,
              };
            }

            // Send challenge for next round (within same session - no new file reads!)
            currentRound++;
            const prevResponse = responses[responses.length - 1]!;
            const prevPrevResponse =
              responses.length >= 2 ? responses[responses.length - 2] : undefined;

            if (this.options.verbose) {
              console.log(
                `[Validator] Issue ${issue.id}: Round ${currentRound} - Challenging in same session`
              );
            }

            // Build challenge prompt (simpler - no need to repeat system prompt or issue details)
            // Pass currentRound directly to get the appropriate progressive challenge
            const challengeContent = this.buildInSessionChallengePrompt(
              issue,
              prevResponse,
              currentRound,
              prevPrevResponse
            );
            sendFollowUp(challengeContent);
          } else {
            // Error during execution
            console.error(`[Validator] Issue ${issue.id} ended with: ${resultMessage.subtype}`);
            endConversation();

            if (responses.length > 0) {
              return {
                issue: this.responseToValidatedIssue(
                  responses[responses.length - 1]!,
                  issue,
                  '验证过程中断'
                ),
                tokensUsed: totalTokensUsed,
              };
            }
            return {
              issue: this.createUncertainIssue(issue, '验证过程失败'),
              tokensUsed: totalTokensUsed,
            };
          }
        }
      }
    } catch (error) {
      console.error(`[Validator] Issue ${issue.id}: Session error:`, error);
      endConversation();

      if (responses.length > 0) {
        return {
          issue: this.responseToValidatedIssue(
            responses[responses.length - 1]!,
            issue,
            '验证会话异常'
          ),
          tokensUsed: totalTokensUsed,
        };
      }
      return {
        issue: this.createUncertainIssue(issue, '验证会话异常'),
        tokensUsed: totalTokensUsed,
      };
    }

    // Should not reach here normally
    endConversation();
    if (responses.length > 0) {
      return {
        issue: this.responseToValidatedIssue(responses[responses.length - 1]!, issue),
        tokensUsed: totalTokensUsed,
      };
    }
    return {
      issue: this.createUncertainIssue(issue, '验证未完成'),
      tokensUsed: totalTokensUsed,
    };
  }

  /**
   * Build in-session challenge prompt (simpler, no need to repeat context)
   *
   * Since we're in the same session, the AI already has:
   * - The issue details
   * - Files it has read
   * - Previous analysis context
   *
   * So we just need to challenge the decision.
   *
   * Progressive challenge strategy (5 rounds):
   * - Round 2: Simple confirmation "你确定吗？"
   * - Round 3: Request specific evidence "请提供更具体的代码证据"
   * - Round 4: Devil's advocate "请考虑反面论点"
   * - Round 5: Final decision "最后一轮，给出最终判断"
   */
  private buildInSessionChallengePrompt(
    _issue: RawIssue,
    previousResponse: ParsedValidationResponse,
    round: number,
    previousPreviousResponse?: ParsedValidationResponse
  ): string {
    const prevStatus = previousResponse.validation_status;

    switch (round) {
      case 2:
        // Round 2: Simple confirmation
        return `你刚才的判断是 **${prevStatus}**。

**请再次仔细审视并确认你的判断。你确定吗？**

基于你已经阅读的代码和上下文，重新考虑:
1. 是否有遗漏的上下文？
2. 你的判断是否正确？

如果判断有变化，请解释原因。如果判断不变，请确认并解释为什么你确定。

请输出 JSON 结果。`;

      case 3: {
        // Round 3: Request specific evidence
        const changeNote = previousPreviousResponse
          ? `你改变了判断: **${previousPreviousResponse.validation_status}** → **${prevStatus}**`
          : `你的判断是 **${prevStatus}**`;
        return `${changeNote}

**请提供更具体的代码证据来支持你当前的判断：**
1. 指出具体的代码行号
2. 说明为什么这些代码构成/不构成问题
3. 如果有相关的上下文（如错误处理、测试覆盖），请一并说明

请输出 JSON 结果。`;
      }

      case 4: {
        // Round 4: Devil's advocate
        const oppositeView =
          prevStatus === 'confirmed'
            ? '这个问题可能**不存在**的原因（如：已有防护措施、边界条件不可达、类型系统保证等）'
            : '这个问题可能**确实存在**的原因（如：缺少校验、边界情况未处理、潜在风险等）';
        return `你再次改变了判断。

**请扮演魔鬼代言人，认真考虑${oppositeView}。**

在充分考虑反面论点后，给出你经过深思熟虑的判断。

请输出 JSON 结果。`;
      }

      case 5:
      default:
        // Round 5: Final decision
        return `你在多轮验证中反复改变判断。

**这是最后一轮。请基于你已读取的所有代码证据，给出你最终的、不可更改的判断。**

注意：
- 如果证据充分支持问题存在，请判定 confirmed
- 如果证据明确表明问题不存在，请判定 rejected
- 如果你仍然无法确定，请明确输出 uncertain

请输出 JSON 结果。`;
    }
  }

  /**
   * Build detailed reasoning when AI is inconsistent across rounds
   */
  private buildInconsistentReasoning(responses: ParsedValidationResponse[]): string {
    const roundLabels = ['第一轮', '第二轮', '第三轮', '第四轮', '第五轮'];
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
   * Get final decision from multiple inconsistent responses using majority vote
   *
   * Decision rules:
   * 1. If any two consecutive rounds agree -> use that result (handled elsewhere)
   * 2. After MAX_CHALLENGE_ROUNDS with inconsistency -> majority vote:
   *    - 3+ confirmed -> confirmed (with reduced confidence)
   *    - 3+ rejected -> rejected (with reduced confidence)
   *    - Otherwise -> uncertain (recommend manual review)
   */
  private getFinalDecisionFromResponses(
    responses: ParsedValidationResponse[],
    originalIssue: RawIssue
  ): ValidatedIssue {
    // Count occurrences of each status
    const counts = {
      confirmed: 0,
      rejected: 0,
      uncertain: 0,
    };

    for (const r of responses) {
      counts[r.validation_status]++;
    }

    // Majority vote
    const total = responses.length;
    const majorityThreshold = Math.ceil(total / 2);
    let finalStatus: 'confirmed' | 'rejected' | 'uncertain';
    let confidencePenalty = 0.3; // Reduce confidence due to inconsistency

    if (counts.confirmed >= majorityThreshold) {
      finalStatus = 'confirmed';
    } else if (counts.rejected >= majorityThreshold) {
      finalStatus = 'rejected';
    } else {
      finalStatus = 'uncertain';
      confidencePenalty = 0.4; // Higher penalty for truly uncertain cases
    }

    const lastResponse = responses[responses.length - 1]!;
    const detailedReasoning = this.buildInconsistentReasoning(responses);

    // Build vote summary
    const voteSummary = `[多数投票: ${counts.confirmed}确认/${counts.rejected}拒绝/${counts.uncertain}不确定]`;

    // Merge checked files and symbols from all rounds
    const allCheckedFiles = [
      ...new Set(responses.flatMap((r) => r.grounding_evidence.checked_files)),
    ];
    const allCheckedSymbols = responses
      .flatMap((r) => r.grounding_evidence.checked_symbols)
      .filter(
        (sym, idx, arr) =>
          arr.findIndex(
            (s) =>
              (typeof s === 'string' ? s : s.name) === (typeof sym === 'string' ? sym : sym.name)
          ) === idx
      )
      .map((sym) =>
        typeof sym === 'string' ? { name: sym, type: 'reference' as const, locations: [] } : sym
      );

    return {
      ...originalIssue,
      validation_status: finalStatus,
      grounding_evidence: {
        checked_files: allCheckedFiles,
        checked_symbols: allCheckedSymbols,
        related_context: lastResponse.grounding_evidence.related_context,
        reasoning: `${voteSummary} ${detailedReasoning}`,
      },
      final_confidence: Math.max(0.3, lastResponse.final_confidence - confidencePenalty),
      rejection_reason: finalStatus === 'rejected' ? lastResponse.rejection_reason : undefined,
    };
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
   * Group issues by file for batch validation
   *
   * Issues from the same file are grouped together (up to maxIssuesPerGroup).
   * This optimizes validation by allowing the Agent to read each file only once.
   */
  private groupIssuesByFile(issues: RawIssue[]): IssueGroup[] {
    const groups: IssueGroup[] = [];
    const issuesByFile = new Map<string, RawIssue[]>();

    // Group by file
    for (const issue of issues) {
      const existing = issuesByFile.get(issue.file) || [];
      existing.push(issue);
      issuesByFile.set(issue.file, existing);
    }

    // Split into groups respecting maxIssuesPerGroup
    for (const [file, fileIssues] of issuesByFile) {
      // Sort by line number for better context flow
      fileIssues.sort((a, b) => a.line_start - b.line_start);

      // Split into chunks
      for (let i = 0; i < fileIssues.length; i += this.options.maxIssuesPerGroup) {
        const chunk = fileIssues.slice(i, i + this.options.maxIssuesPerGroup);
        groups.push({ file, issues: chunk });
      }
    }

    return groups;
  }

  /**
   * Validate a group of issues in a single session
   *
   * All issues in the group are validated together, with the Agent reading
   * the file once and validating each issue. Challenge mode applies to
   * all issues in the group together.
   */
  private async validateGroup(group: IssueGroup): Promise<ValidationResult[]> {
    const { file, issues } = group;

    if (this.options.verbose) {
      console.log(`[Validator] Validating group: ${file} (${issues.length} issues)`);
    }

    // For single issue, use existing method
    if (issues.length === 1) {
      const result = await this.validate(issues[0]!);
      return [result];
    }

    // Build prompt for multiple issues
    const systemPrompt = this.buildGroupSystemPrompt(issues);
    const userPrompt = this.buildGroupUserPrompt(issues);
    const initialPrompt = `${systemPrompt}\n\n${userPrompt}`;

    if (this.options.verbose) {
      console.log(
        `[Validator] Group ${file}: Starting session-reuse validation for ${issues.length} issues`
      );
    }

    // Use session reuse pattern for challenge mode
    if (this.options.challengeMode) {
      return this.validateGroupWithChallenge(issues, initialPrompt);
    }

    // Single round validation
    const { resultText, tokensUsed } = await this.runQuery(initialPrompt, `group:${file}`);
    const results = this.parseGroupResponse(resultText, issues);

    return results.map((result, idx) => ({
      issue: result,
      tokensUsed: idx === 0 ? tokensUsed : 0, // Only count tokens once
    }));
  }

  /**
   * Validate a group with challenge mode (session reuse)
   */
  private async validateGroupWithChallenge(
    issues: RawIssue[],
    initialPrompt: string
  ): Promise<ValidationResult[]> {
    const groupId = issues.map((i) => i.id).join(',');
    const allResponses: ParsedValidationResponse[][] = []; // responses per round

    // Create message queue for multi-turn conversation
    const messageQueue: SDKUserMessage[] = [];
    let resolveNextMessage: ((msg: SDKUserMessage | null) => void) | null = null;
    let sessionId = '';

    // Async generator that yields messages on demand
    async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: initialPrompt },
        parent_tool_use_id: null,
        session_id: sessionId,
      };

      while (true) {
        const msg = await new Promise<SDKUserMessage | null>((resolve) => {
          if (messageQueue.length > 0) {
            resolve(messageQueue.shift()!);
          } else {
            resolveNextMessage = resolve;
          }
        });

        if (msg === null) return;
        yield msg;
      }
    }

    const sendFollowUp = (content: string) => {
      const msg: SDKUserMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
      if (resolveNextMessage) {
        const resolve = resolveNextMessage;
        resolveNextMessage = null;
        resolve(msg);
      } else {
        messageQueue.push(msg);
      }
    };

    const endConversation = () => {
      if (resolveNextMessage) {
        const resolve = resolveNextMessage;
        resolveNextMessage = null;
        resolve(null);
      }
    };

    const queryStream = query({
      prompt: messageGenerator(),
      options: {
        cwd: this.options.repoPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: this.options.maxTurns,
        settingSources: ['project'],
      },
    });

    let totalTokensUsed = 0;
    let currentRound = 1;
    let lastAssistantText = '';

    try {
      for await (const message of queryStream) {
        if (message.session_id && !sessionId) {
          sessionId = message.session_id;
        }

        if (message.type === 'assistant') {
          const assistantMsg = message as SDKAssistantMessage;
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              lastAssistantText = block.text;
            }
          }
        }

        if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;

          if (resultMessage.subtype === 'success') {
            totalTokensUsed = resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;
            const responseText = resultMessage.result || lastAssistantText;

            // Parse group response
            const roundResponses = this.parseGroupResponseRaw(responseText, issues);
            if (roundResponses.length === 0) {
              // Parsing failed
              if (currentRound === 1) {
                endConversation();
                return issues.map((issue, idx) => ({
                  issue: this.createUncertainIssue(issue, '第一轮验证解析失败'),
                  tokensUsed: idx === 0 ? totalTokensUsed : 0,
                }));
              } else {
                // Use previous round results
                const prevResponses = allResponses[allResponses.length - 1]!;
                endConversation();
                return issues.map((issue, idx) => ({
                  issue: prevResponses[idx]
                    ? this.responseToValidatedIssue(
                        prevResponses[idx]!,
                        issue,
                        `第${currentRound}轮解析失败`
                      )
                    : this.createUncertainIssue(issue, `第${currentRound}轮解析失败`),
                  tokensUsed: idx === 0 ? totalTokensUsed : 0,
                }));
              }
            }

            allResponses.push(roundResponses);

            if (this.options.verbose) {
              const statuses = roundResponses.map((r) => r.validation_status).join(', ');
              console.log(`[Validator] Group round ${currentRound}: ${statuses}`);
            }

            // Check if we should continue challenging
            if (currentRound >= 2) {
              const prevResponses = allResponses[allResponses.length - 2]!;
              const allAgree = roundResponses.every(
                (r, idx) => prevResponses[idx]?.validation_status === r.validation_status
              );

              if (allAgree) {
                if (this.options.verbose) {
                  console.log(
                    `[Validator] Group rounds ${currentRound - 1} & ${currentRound} agree`
                  );
                }
                endConversation();
                return issues.map((issue, idx) => ({
                  issue: this.responseToValidatedIssue(roundResponses[idx]!, issue, '两轮验证一致'),
                  tokensUsed: idx === 0 ? totalTokensUsed : 0,
                }));
              }
            }

            if (currentRound >= MAX_CHALLENGE_ROUNDS) {
              if (this.options.verbose) {
                console.log(
                  `[Validator] Group inconsistent across ${MAX_CHALLENGE_ROUNDS} rounds, using majority vote`
                );
              }
              endConversation();
              // Use majority vote for each issue in the group
              return issues.map((issue, idx) => {
                const issueResponses = allResponses
                  .map((round) => round[idx])
                  .filter(Boolean) as ParsedValidationResponse[];
                if (issueResponses.length > 0) {
                  return {
                    issue: this.getFinalDecisionFromResponses(issueResponses, issue),
                    tokensUsed: idx === 0 ? totalTokensUsed : 0,
                  };
                }
                return {
                  issue: this.createUncertainIssue(issue, 'AI判断不一致', 0.7),
                  tokensUsed: idx === 0 ? totalTokensUsed : 0,
                };
              });
            }

            // Send challenge
            currentRound++;
            const challengePrompt = this.buildGroupChallengePrompt(
              issues,
              roundResponses,
              currentRound
            );
            sendFollowUp(challengePrompt);
          } else {
            console.error(`[Validator] Group ${groupId} ended with: ${resultMessage.subtype}`);
            endConversation();

            if (allResponses.length > 0) {
              const lastResponses = allResponses[allResponses.length - 1]!;
              return issues.map((issue, idx) => ({
                issue: lastResponses[idx]
                  ? this.responseToValidatedIssue(lastResponses[idx]!, issue, '验证中断')
                  : this.createUncertainIssue(issue, '验证中断'),
                tokensUsed: idx === 0 ? totalTokensUsed : 0,
              }));
            }
            return issues.map((issue, idx) => ({
              issue: this.createUncertainIssue(issue, '验证失败'),
              tokensUsed: idx === 0 ? totalTokensUsed : 0,
            }));
          }
        }
      }
    } catch (error) {
      console.error(`[Validator] Group ${groupId} error:`, error);
      endConversation();

      if (allResponses.length > 0) {
        const lastResponses = allResponses[allResponses.length - 1]!;
        return issues.map((issue, idx) => ({
          issue: lastResponses[idx]
            ? this.responseToValidatedIssue(lastResponses[idx]!, issue, '验证异常')
            : this.createUncertainIssue(issue, '验证异常'),
          tokensUsed: idx === 0 ? totalTokensUsed : 0,
        }));
      }
      return issues.map((issue, idx) => ({
        issue: this.createUncertainIssue(issue, '验证异常'),
        tokensUsed: idx === 0 ? totalTokensUsed : 0,
      }));
    }

    // Should not reach here
    endConversation();
    return issues.map((issue, idx) => ({
      issue: this.createUncertainIssue(issue, '验证未完成'),
      tokensUsed: idx === 0 ? totalTokensUsed : 0,
    }));
  }

  /**
   * Build system prompt for group validation
   */
  private buildGroupSystemPrompt(issues: RawIssue[]): string {
    // Use the most common category, or first issue's category
    const categories = issues.map((i) => i.category);
    const primaryCategory =
      categories.sort(
        (a, b) =>
          categories.filter((c) => c === b).length - categories.filter((c) => c === a).length
      )[0] || 'logic';

    return buildValidationSystemPrompt(primaryCategory);
  }

  /**
   * Build user prompt for group validation
   */
  private buildGroupUserPrompt(issues: RawIssue[]): string {
    const issueDescriptions = issues
      .map(
        (issue, idx) => `
### Issue ${idx + 1}: ${issue.id}
- **File**: ${issue.file}
- **Lines**: ${issue.line_start}-${issue.line_end}
- **Category**: ${issue.category}
- **Severity**: ${issue.severity}
- **Title**: ${issue.title}
- **Description**: ${issue.description}
${issue.suggestion ? `- **Suggestion**: ${issue.suggestion}` : ''}
${issue.code_snippet ? `- **Code Snippet**:\n\`\`\`\n${issue.code_snippet}\n\`\`\`` : ''}
- **Initial Confidence**: ${issue.confidence}
`
      )
      .join('\n');

    return `Please validate the following ${issues.length} issues from file **${issues[0]!.file}**:

${issueDescriptions}

**Instructions**:
1. Read the file ${issues[0]!.file} to understand the context
2. Validate each issue by checking the actual code
3. For each issue, determine if it should be confirmed, rejected, or uncertain

**Output format**: Return a JSON array with validation results for ALL ${issues.length} issues:

\`\`\`json
{
  "validations": [
    {
      "issue_id": "${issues[0]!.id}",
      "validation_status": "confirmed" | "rejected" | "uncertain",
      "final_confidence": 0.0-1.0,
      "grounding_evidence": {
        "checked_files": ["..."],
        "checked_symbols": ["..."],
        "related_context": "简短说明",
        "reasoning": "验证结论"
      },
      "rejection_reason": "如果rejected"
    }
    // ... results for all ${issues.length} issues
  ]
}
\`\`\``;
  }

  /**
   * Build challenge prompt for group validation
   *
   * Progressive challenge strategy (5 rounds):
   * - Round 2: Simple confirmation
   * - Round 3: Request specific evidence
   * - Round 4: Devil's advocate
   * - Round 5: Final decision
   */
  private buildGroupChallengePrompt(
    issues: RawIssue[],
    previousResponses: ParsedValidationResponse[],
    round: number
  ): string {
    const summaries = issues
      .map((issue, idx) => {
        const resp = previousResponses[idx];
        return `- ${issue.id}: ${resp?.validation_status || 'unknown'}`;
      })
      .join('\n');

    const issueCount = issues.length;

    switch (round) {
      case 2:
        // Round 2: Simple confirmation
        return `你刚才的判断是:
${summaries}

**请再次仔细审视并确认你的判断。你确定吗？**

基于你已经阅读的代码，重新考虑每个问题。如果判断有变化，请解释原因。

请输出 JSON 结果（包含所有 ${issueCount} 个问题的验证结果）。`;

      case 3:
        // Round 3: Request specific evidence
        return `你改变了部分判断。

**请为每个问题提供更具体的代码证据：**
1. 指出具体的代码行号
2. 说明为什么这些代码构成/不构成问题

请输出 JSON 结果（包含所有 ${issueCount} 个问题的验证结果）。`;

      case 4:
        // Round 4: Devil's advocate
        return `你再次改变了判断。

**请扮演魔鬼代言人：**
- 对于你判定为 confirmed 的问题，考虑它可能不存在的原因
- 对于你判定为 rejected 的问题，考虑它可能确实存在的原因

在充分考虑反面论点后，给出你经过深思熟虑的判断。

请输出 JSON 结果（包含所有 ${issueCount} 个问题的验证结果）。`;

      case 5:
      default:
        // Round 5: Final decision
        return `你在多轮验证中反复改变判断。

**这是最后一轮。请基于你已读取的所有代码证据，给出你最终的、不可更改的判断。**

注意：
- 如果证据充分支持问题存在，请判定 confirmed
- 如果证据明确表明问题不存在，请判定 rejected
- 如果你仍然无法确定，请明确输出 uncertain

请输出 JSON 结果（包含所有 ${issueCount} 个问题的验证结果）。`;
    }
  }

  /**
   * Parse group response to get raw ParsedValidationResponse array
   */
  private parseGroupResponseRaw(
    resultText: string,
    issues: RawIssue[]
  ): ParsedValidationResponse[] {
    try {
      const jsonStr = extractJSON(resultText, { verbose: this.options.verbose });
      if (!jsonStr) return [];

      const parsed = JSON.parse(jsonStr) as {
        validations?: Array<{
          issue_id: string;
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
        }>;
      };

      if (!parsed.validations || !Array.isArray(parsed.validations)) {
        return [];
      }

      // Map results back to issues in order
      const results: ParsedValidationResponse[] = [];
      for (const issue of issues) {
        const validation = parsed.validations.find((v) => v.issue_id === issue.id);
        if (validation) {
          results.push({
            validation_status: validation.validation_status,
            final_confidence: validation.final_confidence,
            grounding_evidence: validation.grounding_evidence,
            rejection_reason: validation.rejection_reason,
            revised_description: validation.revised_description,
            revised_severity: validation.revised_severity,
          });
        } else {
          // Issue not found in response, mark as uncertain
          results.push({
            validation_status: 'uncertain',
            final_confidence: issue.confidence * 0.5,
            grounding_evidence: {
              checked_files: [],
              checked_symbols: [],
              related_context: '',
              reasoning: '验证结果中未找到该问题',
            },
          });
        }
      }

      return results;
    } catch (error) {
      if (this.options.verbose) {
        console.error('[Validator] Failed to parse group response:', error);
      }
      return [];
    }
  }

  /**
   * Parse group response to validated issues
   */
  private parseGroupResponse(resultText: string, issues: RawIssue[]): ValidatedIssue[] {
    const responses = this.parseGroupResponseRaw(resultText, issues);

    if (responses.length === 0) {
      return issues.map((issue) => this.createUncertainIssue(issue, '验证解析失败'));
    }

    return issues.map((issue, idx) => {
      const response = responses[idx];
      if (response) {
        return this.responseToValidatedIssue(response, issue);
      }
      return this.createUncertainIssue(issue, '验证结果缺失');
    });
  }

  /**
   * Validate multiple issues using file-based grouping
   *
   * Issues are grouped by file (up to maxIssuesPerGroup per group).
   * Each group is validated in a single Agent session, reducing
   * the number of sessions and file reads.
   */
  async validateBatch(
    issues: RawIssue[],
    concurrency = 5
  ): Promise<{ issues: ValidatedIssue[]; tokensUsed: number }> {
    if (issues.length === 0) {
      return { issues: [], tokensUsed: 0 };
    }

    // Group issues by file
    const groups = this.groupIssuesByFile(issues);

    if (this.options.verbose) {
      console.log(
        `[Validator] Validating ${issues.length} issues in ${groups.length} groups (max ${this.options.maxIssuesPerGroup}/group, concurrency ${concurrency})`
      );
      for (const group of groups) {
        console.log(`  - ${group.file}: ${group.issues.length} issues`);
      }
    }

    // Track progress
    let completedIssues = 0;
    const totalIssues = issues.length;

    // Create task functions for each group
    const tasks = groups.map((group) => async () => {
      const results = await this.validateGroup(group);

      // Update progress for each issue in the group
      for (const result of results) {
        completedIssues++;
        if (this.options.onProgress) {
          this.options.onProgress(completedIssues, totalIssues, result.issue.id);
        }
      }

      return results;
    });

    // Run groups concurrently
    const groupResults = await withConcurrency(tasks, concurrency);

    // Flatten results and calculate total tokens
    const allResults = groupResults.flat();
    const totalTokens = allResults.reduce((sum, r) => sum + r.tokensUsed, 0);

    // Restore original order
    const issueIdToResult = new Map<string, ValidatedIssue>();
    for (const result of allResults) {
      issueIdToResult.set(result.issue.id, result.issue);
    }

    const orderedIssues = issues.map(
      (issue) => issueIdToResult.get(issue.id) || this.createUncertainIssue(issue, '验证结果丢失')
    );

    if (this.options.verbose) {
      console.log(`[Validator] All ${issues.length} issues validated in ${groups.length} groups`);
    }

    return {
      issues: orderedIssues,
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
