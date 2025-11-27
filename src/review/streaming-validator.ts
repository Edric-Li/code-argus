/**
 * Streaming Validator
 *
 * Validates issues in a streaming fashion - as issues are discovered by agents,
 * they are immediately queued for validation. Each file gets a dedicated session
 * that processes issues one by one, reusing the session context.
 *
 * Key features:
 * 1. Stream processing - validation starts as soon as issues arrive
 * 2. Session reuse - same file issues share a session (file read only once)
 * 3. Sequential validation per file - one issue at a time for better focus
 * 4. Concurrent sessions - multiple files validated in parallel
 */

import {
  query,
  type SDKResultMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { RawIssue, ValidatedIssue, SymbolLookup, ValidationStatus } from './types.js';
import {
  DEFAULT_VALIDATOR_MAX_TURNS,
  DEFAULT_CHALLENGE_MODE,
  MAX_CHALLENGE_ROUNDS,
  MIN_CONFIDENCE_FOR_VALIDATION,
} from './constants.js';
import { extractJSON } from './utils/json-parser.js';
import { buildValidationSystemPrompt } from './prompts/validation.js';

/**
 * Progress callback for streaming validation (legacy)
 */
export type StreamingValidationProgressCallback = (
  completedCount: number,
  totalCount: number,
  issueId: string,
  status: ValidationStatus
) => void;

/**
 * Detailed progress callbacks for streaming validation
 */
export interface StreamingValidationCallbacks {
  /** Called when an issue is discovered (before validation) */
  onIssueDiscovered?: (issue: RawIssue) => void;
  /** Called when an issue is validated */
  onIssueValidated?: (issue: ValidatedIssue) => void;
  /** Called when an issue is auto-rejected */
  onAutoRejected?: (issue: RawIssue, reason: string) => void;
}

/**
 * Streaming validator options
 */
export interface StreamingValidatorOptions {
  /** Repository path */
  repoPath: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Maximum turns for validation */
  maxTurns?: number;
  /** Progress callback (legacy) */
  onProgress?: StreamingValidationProgressCallback;
  /** Detailed progress callbacks */
  callbacks?: StreamingValidationCallbacks;
  /** Enable challenge mode */
  challengeMode?: boolean;
  /** Maximum concurrent file sessions */
  maxConcurrentSessions?: number;
  /** Session idle timeout in ms (close session if no new issues) */
  sessionIdleTimeoutMs?: number;
}

/**
 * Resolved options with defaults
 */
interface ResolvedOptions {
  repoPath: string;
  verbose: boolean;
  maxTurns: number;
  onProgress?: StreamingValidationProgressCallback;
  callbacks?: StreamingValidationCallbacks;
  challengeMode: boolean;
  maxConcurrentSessions: number;
  sessionIdleTimeoutMs: number;
}

/**
 * Parsed validation response
 */
interface ParsedValidationResponse {
  validation_status: 'confirmed' | 'rejected' | 'uncertain';
  final_confidence: number;
  grounding_evidence: {
    checked_files: string[];
    checked_symbols: SymbolLookup[];
    related_context: string;
    reasoning: string;
  };
  rejection_reason?: string;
  revised_description?: string;
  revised_severity?: 'critical' | 'error' | 'warning' | 'suggestion';
}

/**
 * File validation session state
 */
interface FileSession {
  /** File path */
  file: string;
  /** Issue queue waiting to be validated */
  queue: RawIssue[];
  /** Currently processing */
  isProcessing: boolean;
  /** Session is closed */
  isClosed: boolean;
  /** Tokens used by this session */
  tokensUsed: number;
  /** Validated issues from this session */
  results: ValidatedIssue[];
  /** Idle timeout handle */
  idleTimeout?: ReturnType<typeof globalThis.setTimeout>;
  /** Promise that resolves when session finishes all queued work */
  processingPromise?: Promise<void>;
  /** Function to signal new issue added */
  notifyNewIssue?: () => void;
}

/**
 * Streaming Validator
 *
 * Manages file-based validation sessions that process issues as they arrive.
 */
export class StreamingValidator {
  private options: ResolvedOptions;
  private sessions: Map<string, FileSession> = new Map();
  private completedCount = 0;
  private totalEnqueued = 0;
  private allAgentsComplete = false;

  constructor(options: StreamingValidatorOptions) {
    this.options = {
      verbose: options.verbose ?? false,
      maxTurns: options.maxTurns ?? DEFAULT_VALIDATOR_MAX_TURNS,
      challengeMode: options.challengeMode ?? DEFAULT_CHALLENGE_MODE,
      maxConcurrentSessions: options.maxConcurrentSessions ?? 5,
      sessionIdleTimeoutMs: options.sessionIdleTimeoutMs ?? 30000, // 30s default
      repoPath: options.repoPath,
      onProgress: options.onProgress,
      callbacks: options.callbacks,
    };
  }

  /**
   * Enqueue an issue for validation
   *
   * Called by agents as they discover issues. The issue will be:
   * 1. Filtered by confidence (auto-reject if too low)
   * 2. Added to the file's session queue
   * 3. Processed when the session is ready
   */
  enqueue(issue: RawIssue): ValidatedIssue | null {
    // Notify issue discovered
    this.options.callbacks?.onIssueDiscovered?.(issue);

    // Confidence filter - auto-reject low confidence non-critical issues
    if (issue.confidence < MIN_CONFIDENCE_FOR_VALIDATION && issue.severity !== 'critical') {
      const rejected = this.createAutoRejectedIssue(issue);
      this.completedCount++;
      this.totalEnqueued++;

      // Notify via callbacks
      this.options.callbacks?.onAutoRejected?.(
        issue,
        `置信度 ${issue.confidence} < ${MIN_CONFIDENCE_FOR_VALIDATION}`
      );

      if (this.options.onProgress) {
        this.options.onProgress(this.completedCount, this.totalEnqueued, issue.id, 'rejected');
      }

      if (this.options.verbose) {
        console.log(
          `[StreamingValidator] Auto-rejected ${issue.id}: confidence ${issue.confidence} < ${MIN_CONFIDENCE_FOR_VALIDATION}`
        );
      }

      return rejected;
    }

    this.totalEnqueued++;

    // Get or create session for this file
    const session = this.getOrCreateSession(issue.file);

    // Add to queue
    session.queue.push(issue);

    if (this.options.verbose) {
      console.log(
        `[StreamingValidator] Enqueued ${issue.id} to ${issue.file} (queue size: ${session.queue.length})`
      );
    }

    // Clear idle timeout if set
    if (session.idleTimeout) {
      globalThis.clearTimeout(session.idleTimeout);
      session.idleTimeout = undefined;
    }

    // Notify session if it's waiting for new issues
    if (session.notifyNewIssue) {
      session.notifyNewIssue();
    }

    // Start processing if not already
    if (!session.isProcessing && !session.isClosed) {
      this.startSessionProcessing(session);
    }

    return null; // Will be available later via flush()
  }

  /**
   * Signal that all agents have completed
   *
   * After this, sessions will close when their queues are empty
   * instead of waiting for new issues.
   */
  markAgentsComplete(): void {
    this.allAgentsComplete = true;

    if (this.options.verbose) {
      console.log('[StreamingValidator] All agents complete, sessions will close when idle');
    }

    // Notify all waiting sessions
    for (const session of this.sessions.values()) {
      if (session.notifyNewIssue) {
        session.notifyNewIssue();
      }
    }
  }

  /**
   * Wait for all validation to complete and return results
   */
  async flush(): Promise<{ issues: ValidatedIssue[]; tokensUsed: number }> {
    this.markAgentsComplete();

    // Wait for all sessions to complete
    const sessionPromises = Array.from(this.sessions.values())
      .filter((s) => s.processingPromise)
      .map((s) => s.processingPromise);

    await Promise.all(sessionPromises);

    // Collect all results
    const allIssues: ValidatedIssue[] = [];
    let totalTokens = 0;

    for (const session of this.sessions.values()) {
      allIssues.push(...session.results);
      totalTokens += session.tokensUsed;
    }

    if (this.options.verbose) {
      console.log(
        `[StreamingValidator] Flush complete: ${allIssues.length} issues, ${totalTokens} tokens`
      );
    }

    return {
      issues: allIssues,
      tokensUsed: totalTokens,
    };
  }

  /**
   * Get current stats
   */
  getStats(): { completed: number; total: number; activeSessions: number } {
    return {
      completed: this.completedCount,
      total: this.totalEnqueued,
      activeSessions: Array.from(this.sessions.values()).filter((s) => s.isProcessing).length,
    };
  }

  // ============ Private Methods ============

  private getOrCreateSession(file: string): FileSession {
    let session = this.sessions.get(file);
    if (!session) {
      session = {
        file,
        queue: [],
        isProcessing: false,
        isClosed: false,
        tokensUsed: 0,
        results: [],
      };
      this.sessions.set(file, session);
    }
    return session;
  }

  private startSessionProcessing(session: FileSession): void {
    if (session.isProcessing || session.isClosed) return;

    session.isProcessing = true;
    session.processingPromise = this.runSession(session);
  }

  /**
   * Run a file validation session
   *
   * This session will:
   * 1. Process issues one by one from the queue
   * 2. Reuse the same Claude session for all issues (file context preserved)
   * 3. Wait for new issues if queue is empty (unless agents are complete)
   * 4. Close when agents complete and queue is empty
   */
  private async runSession(session: FileSession): Promise<void> {
    if (this.options.verbose) {
      console.log(`[StreamingValidator] Starting session for ${session.file}`);
    }

    // Message queue for multi-turn conversation
    const messageQueue: SDKUserMessage[] = [];
    let resolveNextMessage: ((msg: SDKUserMessage | null) => void) | null = null;
    let sessionId = '';

    // Track current issue being validated
    let currentIssue: RawIssue | null = null;
    let currentRound = 0;
    let currentResponses: ParsedValidationResponse[] = [];

    // Promise to wait for new issues
    const waitForNewIssue = (): Promise<boolean> => {
      return new Promise((resolve) => {
        // Check if queue has items
        if (session.queue.length > 0) {
          resolve(true);
          return;
        }

        // If agents are complete and queue is empty, we're done
        if (this.allAgentsComplete) {
          resolve(false);
          return;
        }

        // Set up notification callback
        session.notifyNewIssue = () => {
          session.notifyNewIssue = undefined;
          if (session.queue.length > 0) {
            resolve(true);
          } else if (this.allAgentsComplete) {
            resolve(false);
          }
          // Otherwise keep waiting
        };

        // Set idle timeout
        session.idleTimeout = globalThis.setTimeout(() => {
          if (this.options.verbose) {
            console.log(`[StreamingValidator] Session ${session.file} idle timeout`);
          }
          session.notifyNewIssue = undefined;
          resolve(false);
        }, this.options.sessionIdleTimeoutMs);
      });
    };

    // Get next issue from queue (or wait for one)
    const getNextIssue = async (): Promise<RawIssue | null> => {
      if (session.queue.length > 0) {
        return session.queue.shift()!;
      }

      const hasMore = await waitForNewIssue();
      if (hasMore && session.queue.length > 0) {
        return session.queue.shift()!;
      }

      return null;
    };

    // Build prompt for an issue
    const buildIssuePrompt = (issue: RawIssue, isFirst: boolean): string => {
      const systemPrompt = buildValidationSystemPrompt(issue.category);
      const userPrompt = this.buildUserPrompt(issue);

      if (isFirst) {
        // First issue: include full system prompt
        return `${systemPrompt}\n\n${userPrompt}`;
      } else {
        // Subsequent issues: just the issue details
        return `现在请验证下一个问题（同一文件，你已经读取过代码）：\n\n${userPrompt}`;
      }
    };

    // Message generator for SDK
    async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const msg = await new Promise<SDKUserMessage | null>((resolve) => {
          if (messageQueue.length > 0) {
            resolve(messageQueue.shift()!);
          } else {
            resolveNextMessage = resolve;
          }
        });

        if (msg === null) {
          return;
        }
        yield msg;
      }
    }

    // Send a message to the session
    const sendMessage = (content: string) => {
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

    // End the session
    const endSession = () => {
      if (resolveNextMessage) {
        const resolve = resolveNextMessage;
        resolveNextMessage = null;
        resolve(null);
      }
      session.isClosed = true;
    };

    // Complete current issue and move to next
    const completeCurrentIssue = (validatedIssue: ValidatedIssue) => {
      session.results.push(validatedIssue);
      this.completedCount++;

      // Notify via callbacks
      this.options.callbacks?.onIssueValidated?.(validatedIssue);

      if (this.options.onProgress) {
        this.options.onProgress(
          this.completedCount,
          this.totalEnqueued,
          validatedIssue.id,
          validatedIssue.validation_status
        );
      }

      if (this.options.verbose) {
        console.log(
          `[StreamingValidator] Completed ${validatedIssue.id}: ${validatedIssue.validation_status}`
        );
      }

      currentIssue = null;
      currentRound = 0;
      currentResponses = [];
    };

    // Start processing - get first issue
    currentIssue = await getNextIssue();
    if (!currentIssue) {
      session.isProcessing = false;
      session.isClosed = true;
      return;
    }

    // Send first message to start the session
    const firstPrompt = buildIssuePrompt(currentIssue, true);
    currentRound = 1;

    // Start the query
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

    // Send first message after query starts
    sendMessage(firstPrompt);

    let lastAssistantText = '';

    try {
      for await (const message of queryStream) {
        // Capture session ID
        if (message.session_id && !sessionId) {
          sessionId = message.session_id;
        }

        // Collect assistant text
        if (message.type === 'assistant') {
          const assistantMsg = message as SDKAssistantMessage;
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
            session.tokensUsed +=
              resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;

            const responseText = resultMessage.result || lastAssistantText;
            const response = this.parseResponse(responseText);

            if (!response) {
              // Parse failed
              if (currentRound === 1) {
                completeCurrentIssue(this.createUncertainIssue(currentIssue!, '验证响应解析失败'));
              } else {
                // Use previous response
                const prevResponse = currentResponses[currentResponses.length - 1]!;
                completeCurrentIssue(
                  this.responseToValidatedIssue(prevResponse, currentIssue!, '后续轮次解析失败')
                );
              }
            } else {
              currentResponses.push(response);

              if (this.options.verbose) {
                console.log(
                  `[StreamingValidator] ${currentIssue!.id} Round ${currentRound}: ${response.validation_status}`
                );
              }

              // Check if challenge mode should continue (smart challenge strategy)
              let shouldContinueChallenge = false;
              const maxRoundsForThisIssue = this.getMaxRoundsForIssue(currentIssue!);

              if (this.options.challengeMode && currentRound < maxRoundsForThisIssue) {
                if (currentRound >= 2) {
                  const prevResponse = currentResponses[currentResponses.length - 2]!;
                  if (prevResponse.validation_status !== response.validation_status) {
                    // Responses differ, continue challenging
                    shouldContinueChallenge = true;
                  }
                  // If they agree, we're done with this issue
                } else {
                  // Round 1 complete, do challenge round (only if maxRounds > 1)
                  shouldContinueChallenge = maxRoundsForThisIssue > 1;
                }
              }

              if (shouldContinueChallenge) {
                // Send challenge
                currentRound++;

                const challengePrompt = this.buildChallengePrompt(
                  currentIssue!,
                  response,
                  currentRound,
                  currentResponses.length >= 2
                    ? currentResponses[currentResponses.length - 2]
                    : undefined
                );
                sendMessage(challengePrompt);
              } else {
                // Issue validation complete
                let validatedIssue: ValidatedIssue;

                if (currentRound >= maxRoundsForThisIssue && currentResponses.length > 1) {
                  // Use majority vote when max rounds reached with multiple responses
                  validatedIssue = this.getFinalDecisionFromResponses(
                    currentResponses,
                    currentIssue!
                  );
                } else {
                  const note =
                    currentRound >= 2
                      ? '两轮验证一致'
                      : maxRoundsForThisIssue === 1
                        ? '单轮验证'
                        : undefined;
                  validatedIssue = this.responseToValidatedIssue(response, currentIssue!, note);
                }

                completeCurrentIssue(validatedIssue);

                // Get next issue
                const nextIssue = await getNextIssue();
                if (!nextIssue) {
                  // No more issues, end session
                  endSession();
                } else {
                  // Start validating next issue in same session
                  currentIssue = nextIssue;
                  currentRound = 1;
                  currentResponses = [];

                  const nextPrompt = buildIssuePrompt(nextIssue, false);
                  sendMessage(nextPrompt);
                }
              }
            }
          } else {
            // Error in result
            console.error(
              `[StreamingValidator] Session ${session.file} error: ${resultMessage.subtype}`
            );

            if (currentIssue) {
              if (currentResponses.length > 0) {
                completeCurrentIssue(
                  this.responseToValidatedIssue(
                    currentResponses[currentResponses.length - 1]!,
                    currentIssue,
                    '验证中断'
                  )
                );
              } else {
                completeCurrentIssue(this.createUncertainIssue(currentIssue, '验证失败'));
              }
            }

            endSession();
          }
        }
      }
    } catch (error) {
      console.error(`[StreamingValidator] Session ${session.file} exception:`, error);

      if (currentIssue) {
        if (currentResponses.length > 0) {
          completeCurrentIssue(
            this.responseToValidatedIssue(
              currentResponses[currentResponses.length - 1]!,
              currentIssue,
              '验证异常'
            )
          );
        } else {
          completeCurrentIssue(this.createUncertainIssue(currentIssue, '验证异常'));
        }
      }

      // Complete remaining queued issues as uncertain
      while (session.queue.length > 0) {
        const issue = session.queue.shift()!;
        completeCurrentIssue(this.createUncertainIssue(issue, '会话异常终止'));
      }
    }

    session.isProcessing = false;
    session.isClosed = true;

    if (this.options.verbose) {
      console.log(
        `[StreamingValidator] Session ${session.file} closed: ${session.results.length} issues, ${session.tokensUsed} tokens`
      );
    }
  }

  // ============ Helper Methods ============

  /**
   * Get maximum challenge rounds for an issue based on severity and confidence
   *
   * Smart challenge strategy:
   * - Critical issues: Full 5 rounds (most thorough)
   * - Error issues: 3 rounds
   * - Warning issues with low confidence: 2 rounds
   * - Warning issues with high confidence (>0.85): 1 round only
   * - Suggestion issues: 1 round only
   */
  private getMaxRoundsForIssue(issue: RawIssue): number {
    // Critical issues need thorough validation
    if (issue.severity === 'critical') {
      return MAX_CHALLENGE_ROUNDS; // 5 rounds
    }

    // Error severity: moderate challenge
    if (issue.severity === 'error') {
      return 3;
    }

    // High confidence issues don't need much challenge
    if (issue.confidence > 0.85) {
      return 1;
    }

    // Warning with lower confidence: light challenge
    if (issue.severity === 'warning') {
      return 2;
    }

    // Suggestions: single pass
    return 1;
  }

  private buildUserPrompt(issue: RawIssue): string {
    return `请验证以下问题：

**问题 ID**: ${issue.id}
**文件**: ${issue.file}
**行号**: ${issue.line_start}-${issue.line_end}
**类型**: ${issue.category}
**严重程度**: ${issue.severity}
**标题**: ${issue.title}
**描述**: ${issue.description}
${issue.suggestion ? `**建议**: ${issue.suggestion}` : ''}
${issue.code_snippet ? `**代码片段**:\n\`\`\`\n${issue.code_snippet}\n\`\`\`` : ''}
**初始置信度**: ${issue.confidence}

请：
1. 读取实际代码文件 ${issue.file}:${issue.line_start}-${issue.line_end}
2. 检查是否存在缓解因素（错误处理、测试覆盖等）
3. 做出验证决定

以 JSON 格式返回验证结果。`;
  }

  private buildChallengePrompt(
    _issue: RawIssue,
    prevResponse: ParsedValidationResponse,
    round: number,
    prevPrevResponse?: ParsedValidationResponse
  ): string {
    const prevStatus = prevResponse.validation_status;

    if (round === 2) {
      return `你刚才判断这个问题为 "${prevStatus}"。

我需要你再次确认：**你确定吗？**

请重新审视代码和你的分析，确保没有遗漏任何重要因素。以相同的 JSON 格式给出你的最终判断。`;
    }

    if (round === 3) {
      return `你的判断从 "${prevPrevResponse?.validation_status}" 变成了 "${prevStatus}"。

请提供**更具体的代码证据**来支持你的判断。指出具体的代码行和逻辑。以 JSON 格式回复。`;
    }

    if (round === 4) {
      return `现在请考虑**反面论点**：

如果你判断为 "${prevStatus}"，请思考为什么有人可能会得出相反的结论。考虑这些反面论点后，你的最终判断是什么？

以 JSON 格式回复。`;
    }

    // Round 5
    return `这是**最后一轮**。

综合之前所有的分析和考量，请给出你的最终判断。不要犹豫，明确回答 confirmed、rejected 或 uncertain。

以 JSON 格式回复。`;
  }

  private parseResponse(text: string): ParsedValidationResponse | null {
    try {
      const json = extractJSON(text);
      if (!json) return null;

      const parsed = JSON.parse(json);

      // Validate required fields
      if (
        !parsed.validation_status ||
        !['confirmed', 'rejected', 'uncertain'].includes(parsed.validation_status)
      ) {
        return null;
      }

      // Parse checked_symbols - convert strings to SymbolLookup objects
      const rawSymbols = parsed.grounding_evidence?.checked_symbols ?? [];
      const checkedSymbols: SymbolLookup[] = rawSymbols.map((s: string | SymbolLookup) => {
        if (typeof s === 'string') {
          return { name: s, type: 'reference' as const, locations: [] };
        }
        return s;
      });

      // Validate revised_severity if present
      const validSeverities = ['critical', 'error', 'warning', 'suggestion'];
      const revisedSeverity =
        parsed.revised_severity && validSeverities.includes(parsed.revised_severity)
          ? (parsed.revised_severity as 'critical' | 'error' | 'warning' | 'suggestion')
          : undefined;

      return {
        validation_status: parsed.validation_status,
        final_confidence: parsed.final_confidence ?? 0.5,
        grounding_evidence: {
          checked_files: parsed.grounding_evidence?.checked_files ?? [],
          checked_symbols: checkedSymbols,
          related_context: parsed.grounding_evidence?.related_context ?? '',
          reasoning: parsed.grounding_evidence?.reasoning ?? parsed.reasoning ?? '',
        },
        rejection_reason: parsed.rejection_reason,
        revised_description: parsed.revised_description,
        revised_severity: revisedSeverity,
      };
    } catch {
      return null;
    }
  }

  private responseToValidatedIssue(
    response: ParsedValidationResponse,
    issue: RawIssue,
    _note?: string
  ): ValidatedIssue {
    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category,
      severity: response.revised_severity ?? issue.severity,
      title: issue.title,
      description: response.revised_description ?? issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence,
      source_agent: issue.source_agent,
      validation_status: response.validation_status,
      grounding_evidence: response.grounding_evidence,
      final_confidence: response.final_confidence,
      rejection_reason: response.rejection_reason,
    };
  }

  private createUncertainIssue(issue: RawIssue, reason: string): ValidatedIssue {
    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category,
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence,
      source_agent: issue.source_agent,
      validation_status: 'uncertain',
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: reason,
        reasoning: reason,
      },
      final_confidence: issue.confidence * 0.5,
    };
  }

  private createAutoRejectedIssue(issue: RawIssue): ValidatedIssue {
    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category,
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence,
      source_agent: issue.source_agent,
      validation_status: 'rejected',
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: '置信度过低，自动跳过验证',
        reasoning: `置信度 ${issue.confidence} 低于阈值 ${MIN_CONFIDENCE_FOR_VALIDATION}，自动拒绝`,
      },
      final_confidence: issue.confidence,
      rejection_reason: `置信度过低 (${issue.confidence} < ${MIN_CONFIDENCE_FOR_VALIDATION})`,
    };
  }

  private getFinalDecisionFromResponses(
    responses: ParsedValidationResponse[],
    issue: RawIssue
  ): ValidatedIssue {
    // Count votes
    const votes = { confirmed: 0, rejected: 0, uncertain: 0 };
    for (const r of responses) {
      votes[r.validation_status]++;
    }

    // Find majority
    let finalStatus: 'confirmed' | 'rejected' | 'uncertain' = 'uncertain';
    let maxVotes = 0;

    for (const [status, count] of Object.entries(votes)) {
      if (count > maxVotes) {
        maxVotes = count;
        finalStatus = status as 'confirmed' | 'rejected' | 'uncertain';
      }
    }

    // Use last response's details
    const lastResponse = responses[responses.length - 1]!;

    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category,
      severity: lastResponse.revised_severity ?? issue.severity,
      title: issue.title,
      description: lastResponse.revised_description ?? issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence,
      source_agent: issue.source_agent,
      validation_status: finalStatus,
      grounding_evidence: {
        ...lastResponse.grounding_evidence,
        reasoning: `多轮投票结果: confirmed=${votes.confirmed}, rejected=${votes.rejected}, uncertain=${votes.uncertain}. ${lastResponse.grounding_evidence.reasoning}`,
      },
      final_confidence:
        finalStatus === 'uncertain'
          ? 0.5
          : responses
              .filter((r) => r.validation_status === finalStatus)
              .reduce((sum, r) => sum + r.final_confidence, 0) / maxVotes,
      rejection_reason: finalStatus === 'rejected' ? lastResponse.rejection_reason : undefined,
    };
  }
}

/**
 * Create a streaming validator instance
 */
export function createStreamingValidator(options: StreamingValidatorOptions): StreamingValidator {
  return new StreamingValidator(options);
}
