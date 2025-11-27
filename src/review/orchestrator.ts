/**
 * Review Orchestrator
 *
 * Coordinates the multi-agent code review process using Claude Agent SDK.
 */

import {
  query,
  type SDKResultMessage,
  type SDKAssistantMessage,
  type SDKToolProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ReviewContext,
  ReviewReport,
  OrchestratorOptions,
  OrchestratorInput,
  AgentResult,
  RawIssue,
  ValidatedIssue,
  AgentType,
  ChecklistItem,
} from './types.js';
import { createStandards } from './standards/index.js';
import { buildBaseSystemPrompt, parseAgentResponse } from './prompts/index.js';
import { buildSpecialistPrompt, standardsToText } from './prompts/specialist.js';
import { aggregate } from './aggregator.js';
import { calculateMetrics, generateReport } from './report.js';
import {
  getDiffWithOptions,
  fetchRemote,
  createWorktreeForReview,
  removeWorktree,
  type WorktreeInfo,
} from '../git/diff.js';
import { parseDiff, type DiffFile } from '../git/parser.js';
import { selectAgents, type AgentSelectionResult } from './agent-selector.js';
import { LocalDiffAnalyzer } from '../analyzer/local-analyzer.js';
import { StatusServer } from '../monitor/status-server.js';
import { createValidator } from './validator.js';
import { createDeduplicator } from './deduplicator.js';
import {
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_MAX_THINKING_TOKENS,
  MIN_CONFIDENCE_FOR_VALIDATION,
} from './constants.js';
import {
  createProgressPrinter,
  nullProgressPrinter,
  type IProgressPrinter,
} from '../cli/progress.js';

/**
 * Default orchestrator options
 */
const DEFAULT_OPTIONS: Required<OrchestratorOptions> = {
  maxConcurrency: 4,
  verbose: false,
  agents: ['security-reviewer', 'logic-reviewer', 'style-reviewer', 'performance-reviewer'],
  skipValidation: false,
  monitor: false,
  monitorPort: 3456,
  monitorStopDelay: 5000,
  showProgress: true,
  smartAgentSelection: true,
  disableSelectionLLM: false,
  rulesDirs: [],
  customAgentsDirs: [],
  disableCustomAgentLLM: false,
};

/**
 * Review Orchestrator
 *
 * Coordinates multiple specialized agents to perform comprehensive code review.
 */
export class ReviewOrchestrator {
  private options: Required<OrchestratorOptions>;
  private statusServer?: StatusServer;
  private progress: IProgressPrinter;

  constructor(options?: OrchestratorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.progress = this.options.showProgress ? createProgressPrinter() : nullProgressPrinter;
  }

  /**
   * Execute the complete review process
   */
  async review(input: OrchestratorInput): Promise<ReviewReport> {
    const startTime = Date.now();
    let tokensUsed = 0;
    let worktreeInfo: WorktreeInfo | null = null;

    // Start status server if monitoring is enabled
    if (this.options.monitor) {
      this.statusServer = new StatusServer(this.options.monitorPort);
      await this.statusServer.start();
    }

    try {
      const totalPhases = this.options.skipValidation ? 4 : 5;
      let currentPhase = 0;

      // Phase 1: Build review context
      currentPhase++;
      this.progress.phase(currentPhase, totalPhases, '构建审查上下文...');
      if (this.options.verbose) {
        console.log('[Orchestrator] Building review context...');
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Context Building',
        message: '正在构建审查上下文...',
      });

      const { context, diffFiles } = await this.buildContext(input);
      this.progress.success(`上下文构建完成 (${context.fileAnalyses.length} 个文件)`);

      // Smart agent selection (if enabled)
      let agentsToRun = this.options.agents;
      let selectionResult: AgentSelectionResult | null = null;

      if (this.options.smartAgentSelection) {
        this.progress.progress('智能选择 Agents...');
        if (this.options.verbose) {
          console.log('[Orchestrator] Running smart agent selection...');
        }
        this.sendStatus({
          type: 'phase',
          phase: 'Agent Selection',
          message: '正在智能选择需要运行的 Agents...',
        });

        selectionResult = await selectAgents(diffFiles, {
          verbose: this.options.verbose,
          disableLLM: this.options.disableSelectionLLM,
        });

        agentsToRun = selectionResult.agents;

        const skippedAgents = this.options.agents.filter((a) => !agentsToRun.includes(a));

        // Show selection summary
        if (skippedAgents.length > 0) {
          this.progress.success(
            `智能选择完成: 运行 ${agentsToRun.length} 个, 跳过 ${skippedAgents.length} 个`
          );
        } else {
          this.progress.success(`智能选择完成: 运行全部 ${agentsToRun.length} 个 Agents`);
        }

        // Always show agent selection reasons (not just in verbose mode)
        for (const agent of agentsToRun) {
          const reason = selectionResult.reasons[agent] || '默认选择';
          this.progress.info(`  ✓ ${agent}: ${reason}`);
        }
        for (const agent of skippedAgents) {
          const reason = selectionResult.reasons[agent] || '不需要';
          this.progress.info(`  ✗ ${agent}: ${reason}`);
        }

        if (this.options.verbose) {
          console.log('[Orchestrator] Agent selection details:', {
            usedLLM: selectionResult.usedLLM,
            confidence: selectionResult.confidence,
          });
        }
      }

      // Create worktree for review
      this.progress.progress(`创建 worktree: ${input.sourceBranch}...`);
      if (this.options.verbose) {
        console.log(`[Orchestrator] Creating worktree for source branch: ${input.sourceBranch}`);
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Worktree',
        message: `正在创建 worktree: ${input.sourceBranch}...`,
      });
      worktreeInfo = createWorktreeForReview(input.repoPath, input.sourceBranch);
      this.progress.success(`Worktree 已创建: ${worktreeInfo.worktreePath}`);
      if (this.options.verbose) {
        console.log(`[Orchestrator] Worktree created at: ${worktreeInfo.worktreePath}`);
      }

      // Phase 2: Run specialist agents
      currentPhase++;
      this.progress.phase(currentPhase, totalPhases, `运行 ${agentsToRun.length} 个 Agents...`);
      if (this.options.verbose) {
        console.log('[Orchestrator] Running specialist agents with streaming validation...');
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Agent Execution & Validation',
        message: '正在运行专业审查 Agents 并实时验证...',
      });

      const { validatedIssues, checklists, tokens_used } =
        await this.runAgentsWithStreamingValidation(context, agentsToRun);
      tokensUsed += tokens_used;

      if (this.options.verbose) {
        console.log(`[Orchestrator] Total validated issues: ${validatedIssues.length}`);
      }

      // Phase 3: Aggregate results
      currentPhase++;
      this.progress.phase(currentPhase, totalPhases, '聚合结果...');
      if (this.options.verbose) {
        console.log('[Orchestrator] Aggregating results...');
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Aggregation',
        message: '正在聚合结果...',
      });

      const aggregationResult = aggregate(validatedIssues, checklists);
      const aggregatedIssues = aggregationResult.issues;
      const aggregatedChecklist = aggregationResult.checklist;

      this.progress.success(
        `聚合完成: ${aggregationResult.stats.total_input} → ${aggregationResult.stats.after_filter} 个问题`
      );

      if (this.options.verbose) {
        console.log(
          `[Orchestrator] Aggregation: filtered to ${aggregationResult.stats.after_filter} issues`
        );
      }

      // Phase 4: Generate report
      currentPhase++;
      this.progress.phase(currentPhase, totalPhases, '生成报告...');
      this.sendStatus({
        type: 'phase',
        phase: 'Report Generation',
        message: '正在生成报告...',
      });

      const metrics = calculateMetrics(validatedIssues, aggregatedIssues);
      const metadata = {
        review_time_ms: Date.now() - startTime,
        tokens_used: tokensUsed,
        agents_used: agentsToRun,
      };

      const report = generateReport(
        aggregatedIssues,
        aggregatedChecklist,
        metrics,
        context,
        metadata,
        'zh' // Language will be set when formatting the report
      );

      this.progress.success('报告生成完成');

      if (this.options.verbose) {
        console.log(`[Orchestrator] Review completed in ${report.metadata.review_time_ms}ms`);
      }

      this.sendStatus({
        type: 'complete',
        message: `审查完成! 发现 ${aggregatedIssues.length} 个问题`,
        details: {
          issues: aggregatedIssues.length,
          time_ms: report.metadata.review_time_ms,
          tokens_used: tokensUsed,
        },
      });

      // Final summary
      this.progress.complete(aggregatedIssues.length, report.metadata.review_time_ms);

      return report;
    } catch (error) {
      this.sendStatus({
        type: 'error',
        message: `审查失败: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    } finally {
      // Clean up worktree
      if (worktreeInfo) {
        this.progress.progress('清理 worktree...');
        if (this.options.verbose) {
          console.log(`[Orchestrator] Removing worktree: ${worktreeInfo.worktreePath}`);
        }
        this.sendStatus({
          type: 'phase',
          phase: 'Cleanup',
          message: '正在清理 worktree...',
        });
        try {
          removeWorktree(worktreeInfo);
          this.progress.success('Worktree 已清理');
        } catch (cleanupError) {
          console.error('[Orchestrator] Failed to clean up worktree:', cleanupError);
        }
      }

      // Stop status server after review
      if (this.statusServer) {
        if (this.options.monitorStopDelay > 0) {
          await new Promise((resolve) =>
            globalThis.setTimeout(resolve, this.options.monitorStopDelay)
          );
        }
        await this.statusServer.stop();
      }
    }
  }

  /**
   * Build the review context from input
   *
   * Optimized: DiffAnalyzer + Standards run in parallel
   */
  private async buildContext(
    input: OrchestratorInput
  ): Promise<{ context: ReviewContext; diffFiles: DiffFile[] }> {
    const { sourceBranch, targetBranch, repoPath } = input;
    const remote = 'origin';

    // Step 1: Fetch remote refs
    this.progress.progress('获取远程 refs...');
    if (this.options.verbose) {
      console.log('[Orchestrator] Fetching remote refs...');
    }
    fetchRemote(repoPath, remote);
    this.progress.success('获取远程 refs 完成');

    // Step 2: Get diff
    this.progress.progress(`获取 diff: ${remote}/${targetBranch}...${remote}/${sourceBranch}`);
    const diffResult = getDiffWithOptions({
      sourceBranch,
      targetBranch,
      repoPath,
      skipFetch: true,
    });
    const diffSizeKB = Math.round(diffResult.diff.length / 1024);
    this.progress.success(`获取 diff 完成 (${diffSizeKB} KB)`);

    // Step 3: Parse diff
    this.progress.progress('解析 diff...');
    const diffFiles = parseDiff(diffResult.diff);
    this.progress.success(`解析完成 (${diffFiles.length} 个文件)`);

    // Step 4: Local diff analysis (fast, no LLM)
    this.progress.progress('分析变更...');
    const analyzer = new LocalDiffAnalyzer();
    const analysisResult = analyzer.analyze(diffFiles);
    this.progress.success(`分析完成 (${analysisResult.changes.length} 个变更)`);

    // Step 5: Extract project standards
    this.progress.progress('提取项目标准...');
    if (this.options.verbose) {
      console.log('[Orchestrator] Extracting project standards...');
    }
    const standards = await createStandards(repoPath);
    this.progress.success('项目标准提取完成');

    return {
      context: {
        repoPath,
        diff: diffResult,
        fileAnalyses: analysisResult.changes,
        standards,
      },
      diffFiles,
    };
  }

  /**
   * Run specialist agents with deduplication before validation
   *
   * Optimized Flow:
   * 1. Run all agents in parallel
   * 2. Collect all raw issues from all agents
   * 3. Deduplicate all issues once (before validation)
   * 4. Validate only unique issues (saves validation calls on duplicates)
   */
  private async runAgentsWithStreamingValidation(
    context: ReviewContext,
    agentsToRun: AgentType[] = this.options.agents
  ): Promise<{
    validatedIssues: ValidatedIssue[];
    checklists: ChecklistItem[];
    tokens_used: number;
  }> {
    const standardsText = standardsToText(context.standards);
    let totalTokens = 0;
    const allRawIssues: RawIssue[] = [];
    const allChecklists: ChecklistItem[] = [];

    // Show agents starting
    for (const agentType of agentsToRun) {
      this.progress.agent(agentType, 'running');
    }

    // Run all agents in parallel with timing
    if (this.options.verbose) {
      console.log(`[Orchestrator] Running ${agentsToRun.length} agents in parallel...`);
    }

    // Wrap each agent to capture its own timing
    const agentPromises = agentsToRun.map(async (agentType) => {
      const startTime = Date.now();
      try {
        const result = await this.runSingleAgent(agentType as AgentType, context, standardsText);
        const elapsed = Date.now() - startTime;
        return { agentType, result, elapsed, success: true as const };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        return { agentType, error, elapsed, success: false as const };
      }
    });

    const results = await Promise.all(agentPromises);

    // Step 1: Collect all issues from all agents
    for (const res of results) {
      const elapsedStr =
        res.elapsed < 1000 ? `${res.elapsed}ms` : `${(res.elapsed / 1000).toFixed(1)}s`;

      if (res.success) {
        const agentResult = res.result;
        totalTokens += agentResult.tokens_used;
        allChecklists.push(...agentResult.checklist);
        allRawIssues.push(...agentResult.issues);

        this.progress.agent(
          res.agentType,
          'completed',
          `${agentResult.issues.length} issues, ${elapsedStr}`
        );

        if (this.options.verbose) {
          console.log(
            `[Orchestrator] Agent ${res.agentType}: found ${agentResult.issues.length} issues in ${elapsedStr}`
          );
        }
      } else {
        this.progress.agent(res.agentType, 'error', `failed, ${elapsedStr}`);
        if (this.options.verbose) {
          console.error(`[Orchestrator] Agent ${res.agentType} failed:`, res.error);
        }
      }
    }

    this.progress.info(`共发现 ${allRawIssues.length} 个原始问题`);

    if (this.options.verbose) {
      console.log(`[Orchestrator] Total raw issues from all agents: ${allRawIssues.length}`);
    }

    // Early exit if no issues found
    if (allRawIssues.length === 0) {
      return {
        validatedIssues: [],
        checklists: allChecklists,
        tokens_used: totalTokens,
      };
    }

    // Step 2: Deduplicate all issues BEFORE validation (key optimization!)
    this.progress.progress('去重中...');
    this.sendStatus({
      type: 'phase',
      phase: 'Deduplication',
      message: `正在去重 ${allRawIssues.length} 个问题...`,
    });

    const deduplicator = createDeduplicator({
      verbose: this.options.verbose,
    });

    // Convert raw issues to "pseudo-validated" for deduplication
    const pseudoValidatedIssues: ValidatedIssue[] = allRawIssues.map((issue) => ({
      ...issue,
      validation_status: 'pending' as const,
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: '',
        reasoning: 'Pending validation',
      },
      final_confidence: issue.confidence,
    }));

    const deduplicationResult = await deduplicator.deduplicate(pseudoValidatedIssues);
    totalTokens += deduplicationResult.tokensUsed;

    const uniqueIssues = deduplicationResult.uniqueIssues;

    this.progress.success(`去重完成: ${allRawIssues.length} → ${uniqueIssues.length} 个唯一问题`);

    if (this.options.verbose) {
      console.log(
        `[Orchestrator] Deduplication: ${allRawIssues.length} → ${uniqueIssues.length} unique issues (removed ${deduplicationResult.duplicateGroups.length} duplicate groups)`
      );
    }

    this.sendStatus({
      type: 'progress',
      message: `去重完成: ${allRawIssues.length} → ${uniqueIssues.length} 个唯一问题`,
      details: {
        before: allRawIssues.length,
        after: uniqueIssues.length,
        removed: deduplicationResult.duplicateGroups.length,
      },
    });

    // Step 3: Filter out low-confidence issues (skip validation for them)
    const highConfidenceIssues = uniqueIssues.filter(
      (issue) => issue.confidence >= MIN_CONFIDENCE_FOR_VALIDATION || issue.severity === 'critical'
    );

    const lowConfidenceIssues: ValidatedIssue[] = uniqueIssues
      .filter(
        (issue) => issue.confidence < MIN_CONFIDENCE_FOR_VALIDATION && issue.severity !== 'critical'
      )
      .map((issue) => ({
        ...issue,
        validation_status: 'rejected' as const,
        grounding_evidence: {
          checked_files: [],
          checked_symbols: [],
          related_context: '置信度过低，自动跳过验证',
          reasoning: `置信度 ${issue.confidence} 低于阈值 ${MIN_CONFIDENCE_FOR_VALIDATION}，自动拒绝`,
        },
        final_confidence: issue.confidence,
        rejection_reason: `置信度过低 (${issue.confidence} < ${MIN_CONFIDENCE_FOR_VALIDATION})`,
      }));

    if (lowConfidenceIssues.length > 0) {
      this.progress.info(
        `跳过 ${lowConfidenceIssues.length} 个低置信度问题 (< ${MIN_CONFIDENCE_FOR_VALIDATION})`
      );
      if (this.options.verbose) {
        console.log(
          `[Orchestrator] Skipping validation for ${lowConfidenceIssues.length} low-confidence issues`
        );
      }
    }

    // Step 4: Validate only high-confidence issues
    if (this.options.skipValidation) {
      if (this.options.verbose) {
        console.log('[Orchestrator] Validation skipped');
      }
      return {
        validatedIssues: [...highConfidenceIssues, ...lowConfidenceIssues],
        checklists: allChecklists,
        tokens_used: totalTokens,
      };
    }

    // Early exit if no high-confidence issues to validate
    if (highConfidenceIssues.length === 0) {
      if (this.options.verbose) {
        console.log('[Orchestrator] No high-confidence issues to validate');
      }
      return {
        validatedIssues: lowConfidenceIssues,
        checklists: allChecklists,
        tokens_used: totalTokens,
      };
    }

    this.progress.progress(
      `验证中: 0/${highConfidenceIssues.length} (跳过 ${lowConfidenceIssues.length} 个低置信度)`
    );
    this.sendStatus({
      type: 'phase',
      phase: 'Validation',
      message: `正在验证 ${highConfidenceIssues.length} 个高置信度问题 (跳过 ${lowConfidenceIssues.length} 个低置信度)...`,
    });

    const validator = createValidator({
      repoPath: context.repoPath,
      verbose: this.options.verbose,
      onProgress: (current, total, issueId) => {
        this.progress.validation(current, total, issueId);
        this.sendStatus({
          type: 'progress',
          message: `验证进度: ${current}/${total}`,
          details: { current, total, issueId },
        });
      },
    });

    // Convert back to RawIssue for validation
    const issuesToValidate: RawIssue[] = highConfidenceIssues.map((issue) => ({
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
    }));

    const validationResult = await validator.validateBatch(issuesToValidate, 5);
    totalTokens += validationResult.tokensUsed;

    const confirmed = validationResult.issues.filter(
      (i) => i.validation_status === 'confirmed'
    ).length;
    const rejected = validationResult.issues.filter(
      (i) => i.validation_status === 'rejected'
    ).length;
    const uncertain = validationResult.issues.length - confirmed - rejected;

    this.progress.success(`验证完成: ${confirmed} 确认, ${rejected} 拒绝, ${uncertain} 不确定`);

    if (this.options.verbose) {
      console.log(
        `[Orchestrator] Validation complete: ${confirmed} confirmed, ${rejected} rejected, ${uncertain} uncertain`
      );
    }

    this.sendStatus({
      type: 'progress',
      message: `验证完成: ${validationResult.issues.length} 个问题已验证`,
      details: {
        total: validationResult.issues.length,
        confirmed: validationResult.issues.filter((i) => i.validation_status === 'confirmed')
          .length,
        rejected: validationResult.issues.filter((i) => i.validation_status === 'rejected').length,
        skipped_low_confidence: lowConfidenceIssues.length,
      },
    });

    // Combine validated issues with auto-rejected low-confidence issues
    return {
      validatedIssues: [...validationResult.issues, ...lowConfidenceIssues],
      checklists: allChecklists,
      tokens_used: totalTokens,
    };
  }

  /**
   * Run a single specialist agent
   */
  private async runSingleAgent(
    agentType: AgentType,
    context: ReviewContext,
    standardsText: string
  ): Promise<AgentResult> {
    if (this.options.verbose) {
      console.log(`[Orchestrator] Starting agent: ${agentType}`);
    }

    this.sendStatus({
      type: 'agent',
      agent: agentType,
      message: `${agentType} 开始分析...`,
      details: { status: 'running' },
    });

    // Build the prompt for this agent
    const userPrompt = buildSpecialistPrompt(agentType, {
      diff: context.diff.diff,
      fileAnalyses: context.fileAnalyses,
      standardsText,
    });

    // Build system prompt
    const systemPrompt = buildBaseSystemPrompt(agentType);

    let tokensUsed = 0;
    let resultText = '';

    // Run the agent using Claude Agent SDK
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const queryStream = query({
      prompt: fullPrompt,
      options: {
        cwd: context.repoPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: DEFAULT_AGENT_MAX_TURNS,
        model: DEFAULT_AGENT_MODEL,
        maxThinkingTokens: DEFAULT_AGENT_MAX_THINKING_TOKENS,
        settingSources: ['project'], // Load CLAUDE.md from repo
      },
    });

    // Consume the stream and collect the result
    for await (const message of queryStream) {
      // Show tool usage progress
      if (message.type === 'tool_progress') {
        const toolProgress = message as SDKToolProgressMessage;
        this.progress.agentActivity(agentType, `使用工具: ${toolProgress.tool_name}`);
      }

      // Show assistant thinking/actions
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        // Extract tool use info from assistant message
        for (const block of assistantMsg.message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name;
            // Extract key info from tool input
            let detail = '';
            if (toolName === 'Read' && block.input && typeof block.input === 'object') {
              const input = block.input as { file_path?: string };
              if (input.file_path) {
                const fileName = input.file_path.split('/').pop() || input.file_path;
                detail = `读取 ${fileName}`;
              }
            } else if (toolName === 'Grep' && block.input && typeof block.input === 'object') {
              const input = block.input as { pattern?: string };
              if (input.pattern) {
                detail = `搜索 "${input.pattern}"`;
              }
            } else if (toolName === 'Glob' && block.input && typeof block.input === 'object') {
              const input = block.input as { pattern?: string };
              if (input.pattern) {
                detail = `查找 ${input.pattern}`;
              }
            } else {
              detail = toolName;
            }
            this.progress.agentActivity(agentType, detail);
          }
        }
      }

      if (message.type === 'result') {
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === 'success') {
          resultText = resultMessage.result;
          tokensUsed = resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;

          // If structured output is available, use it
          if (resultMessage.structured_output) {
            const parsed = resultMessage.structured_output as {
              issues?: RawIssue[];
              checklist?: ChecklistItem[];
            };
            return {
              agent: agentType,
              issues: parsed.issues || [],
              checklist: parsed.checklist || [],
              tokens_used: tokensUsed,
            };
          }
        } else {
          // Agent returned an error - log details
          const errorType = resultMessage.subtype;
          console.error(`[Orchestrator] Agent ${agentType} failed with: ${errorType}`);

          if (errorType === 'error_max_turns') {
            console.warn(
              `[Orchestrator] Agent ${agentType} hit max turns limit (${DEFAULT_AGENT_MAX_TURNS}). Consider increasing DEFAULT_AGENT_MAX_TURNS.`
            );
          } else if (errorType === 'error_max_budget_usd') {
            console.warn(`[Orchestrator] Agent ${agentType} exceeded budget limit.`);
          } else if (errorType === 'error_during_execution') {
            console.warn(`[Orchestrator] Agent ${agentType} encountered execution error.`);
          }

          // Try to get any partial result from the error response
          const errorResult = resultMessage as { result?: string };
          if (errorResult.result) {
            resultText = errorResult.result;
            console.log(
              `[Orchestrator] Got partial result from failed agent (${resultText.length} chars)`
            );
          }
        }
      }
    }

    // Check if we got any result
    if (!resultText || resultText.trim() === '') {
      console.warn(`[Orchestrator] Agent ${agentType} returned empty response`);
      return {
        agent: agentType,
        issues: [],
        checklist: [],
        tokens_used: tokensUsed,
      };
    }

    // Parse the text result if no structured output
    const parsed = parseAgentResponse(resultText);

    if (this.options.verbose) {
      console.log(
        `[Orchestrator] Agent ${agentType} completed: ${parsed.issues.length} issues found`
      );
    }

    this.sendStatus({
      type: 'agent',
      agent: agentType,
      message: `${agentType} 完成，发现 ${parsed.issues.length} 个问题`,
      details: { status: 'completed', issues: parsed.issues.length },
    });

    return {
      agent: agentType,
      issues: parsed.issues,
      checklist: parsed.checklist,
      tokens_used: tokensUsed,
    };
  }

  /**
   * Send status update to the monitor
   */
  private sendStatus(update: {
    type: 'phase' | 'agent' | 'progress' | 'complete' | 'error';
    phase?: string;
    agent?: string;
    message: string;
    progress?: number;
    total?: number;
    details?: Record<string, unknown>;
  }): void {
    if (this.statusServer) {
      this.statusServer.sendUpdate(update);
    }
  }
}

/**
 * Create a review orchestrator instance
 */
export function createOrchestrator(options?: OrchestratorOptions): ReviewOrchestrator {
  return new ReviewOrchestrator(options);
}

/**
 * Convenience function to run a review
 */
export async function review(input: OrchestratorInput): Promise<ReviewReport> {
  const orchestrator = createOrchestrator(input.options);
  return orchestrator.review(input);
}
