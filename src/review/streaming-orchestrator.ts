/**
 * Streaming Review Orchestrator
 *
 * Coordinates the multi-agent code review process with real-time issue reporting.
 * Agents report issues via MCP tool, enabling immediate deduplication and validation.
 */

import {
  query,
  createSdkMcpServer,
  tool,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  ReviewContext,
  ReviewReport,
  OrchestratorOptions,
  OrchestratorInput,
  ReviewInput,
  AgentType,
  ChecklistItem,
  RawIssue,
  ValidatedIssue,
} from './types.js';
import { createStandards } from './standards/index.js';
import { aggregate } from './aggregator.js';
import { calculateMetrics, generateReport } from './report.js';
import {
  getDiffWithOptions,
  getDiffByRefs,
  fetchRemote,
  getManagedWorktree,
  getManagedWorktreeForRef,
  type WorktreeInfo,
} from '../git/diff.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  detectRefType,
  getCommitsBetween,
  getRefDisplayString,
  type GitRef,
  type ReviewMode,
} from '../git/ref.js';
import { parseDiff, type DiffFile } from '../git/parser.js';
import { selectAgents, type AgentSelectionResult } from './agent-selector.js';
import { LocalDiffAnalyzer } from '../analyzer/local-analyzer.js';
import { createStreamingValidator, type StreamingValidator } from './streaming-validator.js';
import { buildStreamingSystemPrompt, buildStreamingUserPrompt } from './prompts/streaming.js';
import { standardsToText } from './prompts/specialist.js';
import { DEFAULT_AGENT_MODEL, getRecommendedMaxTurns } from './constants.js';
import { createProgressPrinterWithMode, type IProgressPrinter } from '../cli/index.js';
import type { ReviewEvent, ReviewStateSnapshot, ReviewEventEmitter } from '../cli/events.js';
import {
  loadRules,
  getRulesForAgent,
  rulesToPromptText,
  isEmptyRules,
  type RulesConfig,
  type RuleAgentType,
  EMPTY_RULES_CONFIG,
} from './rules/index.js';
import {
  loadCustomAgents,
  matchCustomAgents,
  executeCustomAgents,
  type LoadedCustomAgent,
  type CustomAgentResult,
} from './custom-agents/index.js';
import { createRealtimeDeduplicator, type RealtimeDeduplicator } from './realtime-deduplicator.js';
import { executeFixVerifier } from './fix-verifier.js';
import type { FixVerificationSummary, PreviousReviewData } from './types.js';

/**
 * Default orchestrator options
 */
const DEFAULT_OPTIONS: Required<
  Omit<OrchestratorOptions, 'onEvent' | 'previousReviewData' | 'verifyFixes'>
> & {
  onEvent?: OrchestratorOptions['onEvent'];
  previousReviewData?: PreviousReviewData;
  verifyFixes?: boolean;
} = {
  maxConcurrency: 4,
  verbose: false,
  agents: ['security-reviewer', 'logic-reviewer', 'style-reviewer', 'performance-reviewer'],
  skipValidation: false,
  showProgress: true,
  smartAgentSelection: true,
  disableSelectionLLM: false,
  rulesDirs: [],
  customAgentsDirs: [],
  disableCustomAgentLLM: false,
  progressMode: 'auto',
  onEvent: undefined,
  previousReviewData: undefined,
  verifyFixes: undefined,
};

/**
 * Extended progress printer interface with state access
 */
interface ExtendedProgressPrinter extends IProgressPrinter {
  getState?: () => ReviewStateSnapshot;
  getEmitter?: () => ReviewEventEmitter;
}

/**
 * Streaming Review Orchestrator
 *
 * Uses MCP tools for real-time issue reporting with immediate deduplication and validation.
 */
export class StreamingReviewOrchestrator {
  private options: typeof DEFAULT_OPTIONS;
  private streamingValidator?: StreamingValidator;
  private realtimeDeduplicator?: RealtimeDeduplicator;
  private progress: ExtendedProgressPrinter;
  private rulesConfig: RulesConfig = EMPTY_RULES_CONFIG;
  private autoRejectedIssues: ValidatedIssue[] = [];
  private rawIssuesForSkipMode: RawIssue[] = [];
  private loadedCustomAgents: LoadedCustomAgent[] = [];
  private fixVerificationResults?: FixVerificationSummary;

  constructor(options?: OrchestratorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Create progress printer based on mode
    this.progress = createProgressPrinterWithMode({
      mode: this.options.progressMode,
      verbose: this.options.verbose,
      onEvent: this.options.onEvent as ((event: ReviewEvent) => void) | undefined,
    });
  }

  /**
   * Get current review state snapshot (for service integration)
   * Returns undefined if progress mode doesn't support state tracking
   */
  getState(): ReviewStateSnapshot | undefined {
    return this.progress.getState?.();
  }

  /**
   * Get the event emitter for direct event subscription
   * Returns undefined if progress mode doesn't support events
   */
  getEmitter(): ReviewEventEmitter | undefined {
    return this.progress.getEmitter?.();
  }

  /**
   * Execute the complete review process with streaming
   */
  async review(input: OrchestratorInput): Promise<ReviewReport> {
    const startTime = Date.now();
    let tokensUsed = 0;
    let worktreeInfo: WorktreeInfo | null = null;

    try {
      // Phase 1: Build review context
      this.progress.phase(1, 4, '构建审查上下文...');
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Building review context...');
      }

      const { context, diffFiles } = await this.buildContext(input);

      // Load custom rules if specified
      if (this.options.rulesDirs.length > 0) {
        this.progress.progress('加载自定义规则...');
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Loading rules from: ${this.options.rulesDirs.join(', ')}`
          );
        }
        this.rulesConfig = await loadRules(this.options.rulesDirs, {
          verbose: this.options.verbose,
        });

        if (!isEmptyRules(this.rulesConfig)) {
          const agentCount = Object.keys(this.rulesConfig.agents).length;
          const hasGlobal = this.rulesConfig.global ? 1 : 0;
          const checklistCount = this.rulesConfig.checklist.length;
          this.progress.success(
            `加载自定义规则完成 (${hasGlobal} 全局, ${agentCount} 专用, ${checklistCount} checklist)`
          );
        } else {
          this.progress.info('未找到自定义规则文件');
        }
      }

      // Load custom agents if specified
      let triggeredCustomAgents: LoadedCustomAgent[] = [];
      if (this.options.customAgentsDirs.length > 0) {
        this.progress.progress('加载自定义 Agents...');
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Loading custom agents from: ${this.options.customAgentsDirs.join(', ')}`
          );
        }

        const loadResult = await loadCustomAgents(this.options.customAgentsDirs, {
          verbose: this.options.verbose,
        });

        this.loadedCustomAgents = loadResult.agents;

        if (loadResult.errors.length > 0) {
          for (const err of loadResult.errors) {
            this.progress.warn(`加载自定义 Agent 失败: ${err.file}: ${err.error}`);
          }
        }

        if (this.loadedCustomAgents.length > 0) {
          this.progress.success(`加载 ${this.loadedCustomAgents.length} 个自定义 Agents`);

          // Match custom agents against diff
          this.progress.progress('匹配自定义 Agent 触发条件...');
          const matchResult = await matchCustomAgents(
            this.loadedCustomAgents,
            diffFiles,
            context.fileAnalyses,
            {
              verbose: this.options.verbose,
              disableLLM: this.options.disableCustomAgentLLM,
              diffContent: context.diff.diff,
            }
          );

          triggeredCustomAgents = matchResult.triggeredAgents.map((t) => t.agent);

          if (triggeredCustomAgents.length > 0) {
            this.progress.success(`触发 ${triggeredCustomAgents.length} 个自定义 Agents`);
            for (const { agent, result } of matchResult.triggeredAgents) {
              this.progress.info(`  ✓ ${agent.name}: ${result.reason}`);
            }
          } else {
            this.progress.info('无自定义 Agent 被触发');
          }

          if (matchResult.skippedAgents.length > 0 && this.options.verbose) {
            for (const { agent, reason } of matchResult.skippedAgents) {
              console.log(
                `[StreamingOrchestrator] Skipped custom agent "${agent.name}": ${reason}`
              );
            }
          }
        } else {
          this.progress.info('未找到自定义 Agent 定义');
        }
      }

      // Smart agent selection
      let agentsToRun = this.options.agents;
      let selectionResult: AgentSelectionResult | null = null;

      if (this.options.smartAgentSelection) {
        this.progress.progress('智能选择 Agents...');
        if (this.options.verbose) {
          console.log('[StreamingOrchestrator] Running smart agent selection...');
        }

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

        // Always show agent selection reasons
        for (const agent of agentsToRun) {
          const reason = selectionResult.reasons[agent] || '默认选择';
          this.progress.info(`  ✓ ${agent}: ${reason}`);
        }
        for (const agent of skippedAgents) {
          const reason = selectionResult.reasons[agent] || '不需要';
          this.progress.info(`  ✗ ${agent}: ${reason}`);
        }

        if (this.options.verbose) {
          console.log('[StreamingOrchestrator] Agent selection details:', {
            usedLLM: selectionResult.usedLLM,
            confidence: selectionResult.confidence,
          });
        }
      }

      // Get or create managed worktree (reuses existing if available)
      this.progress.progress(`准备 worktree: ${input.sourceBranch}...`);
      if (this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Getting/creating worktree for source branch: ${input.sourceBranch}`
        );
      }
      const managedWorktree = getManagedWorktree(input.repoPath, input.sourceBranch);
      worktreeInfo = managedWorktree; // ManagedWorktreeInfo is compatible with WorktreeInfo
      this.progress.success(
        `Worktree ${managedWorktree.reused ? '已复用' : '已创建'}: ${worktreeInfo.worktreePath}`
      );
      if (this.options.verbose) {
        console.log(`[StreamingOrchestrator] Worktree created at: ${worktreeInfo.worktreePath}`);
      }

      // Update context to use worktree path for agent execution
      const reviewRepoPath = worktreeInfo.worktreePath;

      // Reset state for this review
      this.autoRejectedIssues = [];
      this.rawIssuesForSkipMode = [];

      // Create realtime deduplicator with progress callbacks
      this.realtimeDeduplicator = createRealtimeDeduplicator({
        verbose: this.options.verbose,
        onDeduplicated: (newIssue, existingIssue, reason) => {
          this.progress.info(
            `去重: "${newIssue.title}" 与 "${existingIssue.title}" 重复 (${reason})`
          );
        },
      });

      // Create streaming validator with progress callbacks
      // Pass project rules so validator can use rule priority logic
      const projectRulesText = rulesToPromptText(this.rulesConfig);
      this.streamingValidator = this.options.skipValidation
        ? undefined
        : createStreamingValidator({
            repoPath: reviewRepoPath,
            verbose: this.options.verbose,
            maxConcurrentSessions: 5,
            projectRules: projectRulesText || undefined,
            callbacks: {
              onIssueDiscovered: (issue) => {
                this.progress.issueDiscovered(
                  issue.title,
                  issue.file,
                  issue.severity,
                  issue.line_start,
                  issue.description,
                  issue.suggestion
                );
              },
              onIssueValidated: (issue) => {
                const reason =
                  issue.validation_status === 'rejected'
                    ? issue.rejection_reason || issue.grounding_evidence?.reasoning
                    : undefined;
                this.progress.issueValidated({
                  title: issue.title,
                  file: issue.file,
                  line: issue.line_start,
                  severity: issue.severity,
                  description: issue.description,
                  suggestion: issue.suggestion,
                  status: issue.validation_status,
                  reason,
                });
              },
              onAutoRejected: (issue, reason) => {
                this.progress.autoRejected({
                  title: issue.title,
                  file: issue.file,
                  line: issue.line_start,
                  severity: issue.severity,
                  description: issue.description,
                  suggestion: issue.suggestion,
                  reason,
                });
              },
              onRoundComplete: (_issueId, issueTitle, round, maxRounds, status) => {
                this.progress.validationRound(issueTitle, round, maxRounds, status);
              },
              onValidationActivity: (_issueId, issueTitle, activity) => {
                this.progress.validationActivity(issueTitle, activity);
              },
            },
          });

      // Phase 2: Run ALL agents in parallel (built-in + custom + fix verifier)
      // Determine if fix verification should run
      const previousReviewData = this.options.previousReviewData;
      const shouldVerifyFixes =
        previousReviewData &&
        previousReviewData.issues.length > 0 &&
        this.options.verifyFixes !== false;

      const totalAgentCount =
        agentsToRun.length + triggeredCustomAgents.length + (shouldVerifyFixes ? 1 : 0);
      this.progress.phase(2, 4, `运行 ${totalAgentCount} 个 Agents (并行)...`);
      if (this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Running ${totalAgentCount} agents in parallel (${agentsToRun.length} built-in + ${triggeredCustomAgents.length} custom${shouldVerifyFixes ? ' + 1 fix-verifier' : ''})...`
        );
      }

      // Show custom agents starting (built-in agents are shown in runAgentsWithStreaming)
      for (const agent of triggeredCustomAgents) {
        this.progress.agent(agent.name, 'running');
      }

      if (shouldVerifyFixes) {
        this.progress.agent('fix-verifier', 'running');
        this.progress.info(`修复验证: 将验证 ${previousReviewData.issues.length} 个上次问题`);
      }

      // Build file analyses summary for custom agents
      const fileAnalysesSummary = context.fileAnalyses
        .map((f) => `- ${f.file_path}: ${f.semantic_hints?.summary || 'No summary'}`)
        .join('\n');

      // Run built-in agents, custom agents, AND fix verifier IN PARALLEL
      // Use Promise.allSettled to ensure all complete even if some fail
      const [builtInSettled, customSettled, fixVerifierSettled] = await Promise.allSettled([
        // Built-in agents
        this.runAgentsWithStreaming(context, reviewRepoPath, agentsToRun),
        // Custom agents (returns empty array if none triggered)
        triggeredCustomAgents.length > 0
          ? executeCustomAgents(
              triggeredCustomAgents,
              {
                verbose: this.options.verbose,
                repoPath: reviewRepoPath,
                diffContent: context.diff.diff,
                fileAnalysesSummary,
                standardsText: standardsToText(context.standards),
              },
              {
                onAgentStart: () => {
                  // No-op: progress is handled elsewhere
                },
                onAgentComplete: (agent, result) => {
                  const elapsed = result.execution_time_ms;
                  const elapsedStr =
                    elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
                  this.progress.agent(
                    agent.name,
                    'completed',
                    `${result.issues.length} issues, ${elapsedStr}`
                  );
                },
                onAgentError: (agent, error) => {
                  this.progress.agent(agent.name, 'error', error.message);
                },
                onIssueDiscovered: (issue) => {
                  // Enqueue custom agent issues for validation
                  if (!this.options.skipValidation && this.streamingValidator) {
                    const autoRejected = this.streamingValidator.enqueue(issue);
                    if (autoRejected) {
                      this.autoRejectedIssues.push(autoRejected);
                    }
                  } else if (this.options.skipValidation) {
                    this.progress.issueDiscovered(
                      issue.title,
                      issue.file,
                      issue.severity,
                      issue.line_start,
                      issue.description,
                      issue.suggestion
                    );
                    this.rawIssuesForSkipMode.push(issue);
                  }
                },
              },
              this.options.maxConcurrency
            )
          : Promise.resolve([] as CustomAgentResult[]),
        // Fix verifier (if previous review data is provided)
        shouldVerifyFixes
          ? executeFixVerifier({
              repoPath: reviewRepoPath,
              previousReview: previousReviewData,
              diffContent: context.diff.diff,
              fileChangesSummary: fileAnalysesSummary,
              verbose: this.options.verbose,
              progress: this.progress,
            })
          : Promise.resolve(undefined as FixVerificationSummary | undefined),
      ]);

      // Handle built-in agents result (required - throw if failed)
      if (builtInSettled.status === 'rejected') {
        throw builtInSettled.reason;
      }
      const builtInResult = builtInSettled.value;

      // Handle custom agents result (optional - log error and continue)
      let customAgentResults: CustomAgentResult[] = [];
      if (customSettled.status === 'rejected') {
        console.error('[StreamingOrchestrator] Custom agents failed:', customSettled.reason);
        this.progress.warn('自定义 Agents 执行失败，继续处理内置 Agents 结果');
      } else {
        customAgentResults = customSettled.value;
      }

      // Handle fix verifier result (optional - log error and continue)
      if (fixVerifierSettled.status === 'rejected') {
        console.error('[StreamingOrchestrator] Fix verifier failed:', fixVerifierSettled.reason);
        this.progress.warn('修复验证失败，继续处理其他结果');
        this.progress.agent('fix-verifier', 'error', String(fixVerifierSettled.reason));
      } else if (fixVerifierSettled.value) {
        this.fixVerificationResults = fixVerifierSettled.value;
        tokensUsed += this.fixVerificationResults.tokens_used;
        const fv = this.fixVerificationResults;
        this.progress.agent(
          'fix-verifier',
          'completed',
          `${fv.by_status.fixed} 已修复, ${fv.by_status.missed} 未修复, ${fv.by_status.false_positive} 误报`
        );
      }

      // Collect results from built-in agents
      const { checklists, tokens: agentTokens } = builtInResult;
      tokensUsed += agentTokens;

      // Collect results from custom agents
      if (customAgentResults.length > 0) {
        const customAgentTokens = customAgentResults.reduce((sum, r) => sum + r.tokens_used, 0);
        tokensUsed += customAgentTokens;

        const totalCustomIssues = customAgentResults.reduce((sum, r) => sum + r.issues.length, 0);
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Custom agents completed: ${totalCustomIssues} issues, ${customAgentTokens} tokens`
          );
        }
      }

      // Phase 3: Wait for all validations to complete
      this.progress.phase(3, 4, '等待验证完成...');
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Waiting for validations to complete...');
      }

      // Flush streaming validator and get results
      let validatedIssues: ValidatedIssue[] = [];
      let validationTokens = 0;
      if (this.streamingValidator) {
        // Start a status polling interval to show progress while waiting
        const statusInterval = globalThis.setInterval(() => {
          const stats = this.streamingValidator?.getStats();
          if (stats && stats.total > 0) {
            this.progress.progress(
              `验证进度: ${stats.completed}/${stats.total} (${stats.activeSessions} 个活跃会话)`
            );
          }
        }, 5000); // Update every 5 seconds

        try {
          const validationResult = await this.streamingValidator.flush();
          validatedIssues = [...validationResult.issues, ...this.autoRejectedIssues];
          validationTokens = validationResult.tokensUsed;
          tokensUsed += validationTokens;
        } finally {
          globalThis.clearInterval(statusInterval);
        }

        const confirmed = validatedIssues.filter((i) => i.validation_status === 'confirmed').length;
        const rejected = validatedIssues.filter((i) => i.validation_status === 'rejected').length;
        const uncertain = validatedIssues.length - confirmed - rejected;

        // Get deduplication stats
        const dedupStats = this.realtimeDeduplicator?.getStats();
        const dedupTokens = dedupStats?.tokensUsed || 0;
        tokensUsed += dedupTokens;

        this.progress.validationSummary({
          total: validatedIssues.length,
          confirmed,
          rejected,
          uncertain,
          autoRejected: this.autoRejectedIssues.length,
          deduplicated: dedupStats?.deduplicated || 0,
          tokensUsed: validationTokens + dedupTokens,
          timeMs: Date.now() - startTime,
        });
      } else if (this.options.skipValidation) {
        // Skip validation mode - convert raw issues to validated without actual validation
        validatedIssues = this.rawIssuesForSkipMode.map((issue) => ({
          ...issue,
          validation_status: 'pending' as const,
          grounding_evidence: {
            checked_files: [],
            checked_symbols: [],
            related_context: '跳过验证',
            reasoning: '用户选择跳过验证',
          },
          final_confidence: issue.confidence,
        }));
        this.progress.info(`跳过验证: ${validatedIssues.length} 个问题`);
      }

      this.progress.success(`验证完成: ${validatedIssues.length} 个有效问题`);

      if (this.options.verbose) {
        console.log(`[StreamingOrchestrator] Total validated issues: ${validatedIssues.length}`);
      }

      // Phase 4: Aggregate and generate report
      this.progress.phase(4, 4, '生成报告...');
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Aggregating results...');
      }

      const aggregationResult = aggregate(validatedIssues, checklists);
      const aggregatedIssues = aggregationResult.issues;
      const aggregatedChecklist = aggregationResult.checklist;

      const metrics = calculateMetrics(
        validatedIssues.map((i) => ({
          id: i.id,
          file: i.file,
          line_start: i.line_start,
          line_end: i.line_end,
          category: i.category,
          severity: i.severity,
          title: i.title,
          description: i.description,
          confidence: i.confidence,
          source_agent: i.source_agent,
        })),
        aggregatedIssues
      );

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
        'zh',
        this.fixVerificationResults
      );

      if (this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Review completed in ${report.metadata.review_time_ms}ms`
        );
      }

      this.progress.complete(aggregatedIssues.length, report.metadata.review_time_ms);

      return report;
    } finally {
      // Managed worktrees are NOT cleaned up after each review
      // They are cached for reuse and automatically cleaned up after staleDays (default: 5 days)
      if (worktreeInfo && this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Worktree preserved for future reuse: ${worktreeInfo.worktreePath}`
        );
      }
    }
  }

  /**
   * Execute the complete review process with auto-detection of refs
   *
   * This method auto-detects whether the provided refs are branches or commits,
   * and uses the appropriate diff strategy.
   */
  async reviewByRefs(input: ReviewInput): Promise<ReviewReport> {
    const startTime = Date.now();
    let tokensUsed = 0;
    let worktreeInfo: WorktreeInfo | null = null;

    // Check if using external diff mode
    const hasExternalDiff =
      input.externalDiff?.diffContent ||
      input.externalDiff?.diffFile ||
      input.externalDiff?.diffStdin ||
      input.externalDiff?.commits;

    // Detect ref types (only if refs are provided)
    const sourceType = input.sourceRef ? detectRefType(input.sourceRef) : undefined;
    const targetType = input.targetRef ? detectRefType(input.targetRef) : undefined;
    const isIncremental = !hasExternalDiff && sourceType === 'commit' && targetType === 'commit';

    try {
      // Phase 1: Build review context
      let modeLabel: string;
      if (hasExternalDiff) {
        modeLabel = '外部 Diff';
      } else if (isIncremental) {
        modeLabel = '增量审查';
      } else {
        modeLabel = '分支审查';
      }
      this.progress.phase(1, 4, `构建${modeLabel}上下文...`);
      if (this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Building review context (mode: ${hasExternalDiff ? 'external' : isIncremental ? 'incremental' : 'branch'})...`
        );
      }

      const { context, diffFiles, sourceRef, targetRef } = await this.buildContextByRefs(input);

      // Show review mode info
      if (hasExternalDiff) {
        this.progress.info(`外部 Diff 模式: ${diffFiles.length} 个文件`);
      } else if (isIncremental && input.sourceRef && input.targetRef && sourceRef && targetRef) {
        const commitRange = getCommitsBetween(input.repoPath, input.targetRef, input.sourceRef);
        const sourceDisplay = getRefDisplayString(sourceRef, input.repoPath);
        const targetDisplay = getRefDisplayString(targetRef, input.repoPath);
        this.progress.info(
          `增量审查: ${targetDisplay} → ${sourceDisplay} (${commitRange.length} commits)`
        );
      }

      // Load custom rules if specified
      if (this.options.rulesDirs.length > 0) {
        this.progress.progress('加载自定义规则...');
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Loading rules from: ${this.options.rulesDirs.join(', ')}`
          );
        }
        this.rulesConfig = await loadRules(this.options.rulesDirs, {
          verbose: this.options.verbose,
        });

        if (!isEmptyRules(this.rulesConfig)) {
          const agentCount = Object.keys(this.rulesConfig.agents).length;
          const hasGlobal = this.rulesConfig.global ? 1 : 0;
          const checklistCount = this.rulesConfig.checklist.length;
          this.progress.success(
            `加载自定义规则完成 (${hasGlobal} 全局, ${agentCount} 专用, ${checklistCount} checklist)`
          );
        } else {
          this.progress.info('未找到自定义规则文件');
        }
      }

      // Load custom agents if specified
      let triggeredCustomAgents: LoadedCustomAgent[] = [];
      if (this.options.customAgentsDirs.length > 0) {
        this.progress.progress('加载自定义 Agents...');
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Loading custom agents from: ${this.options.customAgentsDirs.join(', ')}`
          );
        }

        const loadResult = await loadCustomAgents(this.options.customAgentsDirs, {
          verbose: this.options.verbose,
        });

        this.loadedCustomAgents = loadResult.agents;

        if (loadResult.errors.length > 0) {
          for (const err of loadResult.errors) {
            this.progress.warn(`加载自定义 Agent 失败: ${err.file}: ${err.error}`);
          }
        }

        if (this.loadedCustomAgents.length > 0) {
          this.progress.success(`加载 ${this.loadedCustomAgents.length} 个自定义 Agents`);

          // Match custom agents against diff
          this.progress.progress('匹配自定义 Agent 触发条件...');
          const matchResult = await matchCustomAgents(
            this.loadedCustomAgents,
            diffFiles,
            context.fileAnalyses,
            {
              verbose: this.options.verbose,
              disableLLM: this.options.disableCustomAgentLLM,
              diffContent: context.diff.diff,
            }
          );

          triggeredCustomAgents = matchResult.triggeredAgents.map((t) => t.agent);

          if (triggeredCustomAgents.length > 0) {
            this.progress.success(`触发 ${triggeredCustomAgents.length} 个自定义 Agents`);
            for (const { agent, result } of matchResult.triggeredAgents) {
              this.progress.info(`  ✓ ${agent.name}: ${result.reason}`);
            }
          } else {
            this.progress.info('无自定义 Agent 被触发');
          }

          if (matchResult.skippedAgents.length > 0 && this.options.verbose) {
            for (const { agent, reason } of matchResult.skippedAgents) {
              console.log(
                `[StreamingOrchestrator] Skipped custom agent "${agent.name}": ${reason}`
              );
            }
          }
        } else {
          this.progress.info('未找到自定义 Agent 定义');
        }
      }

      // Smart agent selection
      let agentsToRun = this.options.agents;
      let selectionResult: AgentSelectionResult | null = null;

      if (this.options.smartAgentSelection) {
        this.progress.progress('智能选择 Agents...');
        if (this.options.verbose) {
          console.log('[StreamingOrchestrator] Running smart agent selection...');
        }

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

        // Always show agent selection reasons
        for (const agent of agentsToRun) {
          const reason = selectionResult.reasons[agent] || '默认选择';
          this.progress.info(`  ✓ ${agent}: ${reason}`);
        }
        for (const agent of skippedAgents) {
          const reason = selectionResult.reasons[agent] || '不需要';
          this.progress.info(`  ✗ ${agent}: ${reason}`);
        }

        if (this.options.verbose) {
          console.log('[StreamingOrchestrator] Agent selection details:', {
            usedLLM: selectionResult.usedLLM,
            confidence: selectionResult.confidence,
          });
        }
      }

      // Get or create managed worktree (reuses existing if available)
      // For external diff mode without refs, use the repo directly
      let reviewRepoPath: string;

      if (hasExternalDiff && !sourceRef) {
        // External diff mode - use repo directly
        this.progress.progress('使用仓库目录进行审查...');
        reviewRepoPath = resolve(input.repoPath);
        this.progress.success(`使用仓库目录: ${reviewRepoPath}`);
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Using repo directly (external diff mode): ${reviewRepoPath}`
          );
        }
      } else if (sourceRef) {
        // Normal mode - create worktree
        const refDisplayStr = getRefDisplayString(sourceRef, input.repoPath);
        this.progress.progress(`准备 worktree: ${refDisplayStr}...`);
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Getting/creating worktree for source ref: ${refDisplayStr}`
          );
        }
        const managedWorktree = getManagedWorktreeForRef(input.repoPath, sourceRef);
        worktreeInfo = managedWorktree; // ManagedWorktreeInfo is compatible with WorktreeInfo
        reviewRepoPath = worktreeInfo.worktreePath;
        this.progress.success(
          `Worktree ${managedWorktree.reused ? '已复用' : '已创建'}: ${worktreeInfo.worktreePath}`
        );
        if (this.options.verbose) {
          console.log(`[StreamingOrchestrator] Worktree created at: ${worktreeInfo.worktreePath}`);
        }
      } else {
        // Fallback - use repo directly
        reviewRepoPath = resolve(input.repoPath);
        this.progress.info(`使用仓库目录: ${reviewRepoPath}`);
      }

      // Reset state for this review
      this.autoRejectedIssues = [];
      this.rawIssuesForSkipMode = [];

      // Create realtime deduplicator with progress callbacks
      this.realtimeDeduplicator = createRealtimeDeduplicator({
        verbose: this.options.verbose,
        onDeduplicated: (newIssue, existingIssue, reason) => {
          this.progress.info(
            `去重: "${newIssue.title}" 与 "${existingIssue.title}" 重复 (${reason})`
          );
        },
      });

      // Create streaming validator with progress callbacks
      // Pass project rules so validator can use rule priority logic
      const projectRulesText = rulesToPromptText(this.rulesConfig);
      this.streamingValidator = this.options.skipValidation
        ? undefined
        : createStreamingValidator({
            repoPath: reviewRepoPath,
            verbose: this.options.verbose,
            maxConcurrentSessions: 5,
            projectRules: projectRulesText || undefined,
            callbacks: {
              onIssueDiscovered: (issue) => {
                this.progress.issueDiscovered(
                  issue.title,
                  issue.file,
                  issue.severity,
                  issue.line_start,
                  issue.description,
                  issue.suggestion
                );
              },
              onIssueValidated: (issue) => {
                const reason =
                  issue.validation_status === 'rejected'
                    ? issue.rejection_reason || issue.grounding_evidence?.reasoning
                    : undefined;
                this.progress.issueValidated({
                  title: issue.title,
                  file: issue.file,
                  line: issue.line_start,
                  severity: issue.severity,
                  description: issue.description,
                  suggestion: issue.suggestion,
                  status: issue.validation_status,
                  reason,
                });
              },
              onAutoRejected: (issue, reason) => {
                this.progress.autoRejected({
                  title: issue.title,
                  file: issue.file,
                  line: issue.line_start,
                  severity: issue.severity,
                  description: issue.description,
                  suggestion: issue.suggestion,
                  reason,
                });
              },
              onRoundComplete: (_issueId, issueTitle, round, maxRounds, status) => {
                this.progress.validationRound(issueTitle, round, maxRounds, status);
              },
              onValidationActivity: (_issueId, issueTitle, activity) => {
                this.progress.validationActivity(issueTitle, activity);
              },
            },
          });

      // Phase 2: Run ALL agents in parallel (built-in + custom + fix verifier)
      // Determine if fix verification should run
      const previousReviewData = this.options.previousReviewData;
      const shouldVerifyFixes =
        previousReviewData &&
        previousReviewData.issues.length > 0 &&
        this.options.verifyFixes !== false;

      const totalAgentCount =
        agentsToRun.length + triggeredCustomAgents.length + (shouldVerifyFixes ? 1 : 0);
      this.progress.phase(2, 4, `运行 ${totalAgentCount} 个 Agents (并行)...`);
      if (this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Running ${totalAgentCount} agents in parallel (${agentsToRun.length} built-in + ${triggeredCustomAgents.length} custom${shouldVerifyFixes ? ' + 1 fix-verifier' : ''})...`
        );
      }

      // Show custom agents starting (built-in agents are shown in runAgentsWithStreaming)
      for (const agent of triggeredCustomAgents) {
        this.progress.agent(agent.name, 'running');
      }

      if (shouldVerifyFixes) {
        this.progress.agent('fix-verifier', 'running');
        this.progress.info(`修复验证: 将验证 ${previousReviewData.issues.length} 个上次问题`);
      }

      // Build file analyses summary for custom agents
      const fileAnalysesSummary = context.fileAnalyses
        .map((f) => `- ${f.file_path}: ${f.semantic_hints?.summary || 'No summary'}`)
        .join('\n');

      // Run built-in agents, custom agents, AND fix verifier IN PARALLEL
      // Use Promise.allSettled to ensure all complete even if some fail
      const [builtInSettled, customSettled, fixVerifierSettled] = await Promise.allSettled([
        // Built-in agents
        this.runAgentsWithStreaming(context, reviewRepoPath, agentsToRun),
        // Custom agents (returns empty array if none triggered)
        triggeredCustomAgents.length > 0
          ? executeCustomAgents(
              triggeredCustomAgents,
              {
                verbose: this.options.verbose,
                repoPath: reviewRepoPath,
                diffContent: context.diff.diff,
                fileAnalysesSummary,
                standardsText: standardsToText(context.standards),
              },
              {
                onAgentStart: () => {
                  // No-op: progress is handled elsewhere
                },
                onAgentComplete: (agent, result) => {
                  const elapsed = result.execution_time_ms;
                  const elapsedStr =
                    elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
                  this.progress.agent(
                    agent.name,
                    'completed',
                    `${result.issues.length} issues, ${elapsedStr}`
                  );
                },
                onAgentError: (agent, error) => {
                  this.progress.agent(agent.name, 'error', error.message);
                },
                onIssueDiscovered: (issue) => {
                  // Enqueue custom agent issues for validation
                  if (!this.options.skipValidation && this.streamingValidator) {
                    const autoRejected = this.streamingValidator.enqueue(issue);
                    if (autoRejected) {
                      this.autoRejectedIssues.push(autoRejected);
                    }
                  } else if (this.options.skipValidation) {
                    this.progress.issueDiscovered(
                      issue.title,
                      issue.file,
                      issue.severity,
                      issue.line_start,
                      issue.description,
                      issue.suggestion
                    );
                    this.rawIssuesForSkipMode.push(issue);
                  }
                },
              },
              this.options.maxConcurrency
            )
          : Promise.resolve([] as CustomAgentResult[]),
        // Fix verifier (if previous review data is provided)
        shouldVerifyFixes
          ? executeFixVerifier({
              repoPath: reviewRepoPath,
              previousReview: previousReviewData,
              diffContent: context.diff.diff,
              fileChangesSummary: fileAnalysesSummary,
              verbose: this.options.verbose,
              progress: this.progress,
            })
          : Promise.resolve(undefined as FixVerificationSummary | undefined),
      ]);

      // Handle built-in agents result (required - throw if failed)
      if (builtInSettled.status === 'rejected') {
        throw builtInSettled.reason;
      }
      const builtInResult = builtInSettled.value;

      // Handle custom agents result (optional - log error and continue)
      let customAgentResults: CustomAgentResult[] = [];
      if (customSettled.status === 'rejected') {
        console.error('[StreamingOrchestrator] Custom agents failed:', customSettled.reason);
        this.progress.warn('自定义 Agents 执行失败，继续处理内置 Agents 结果');
      } else {
        customAgentResults = customSettled.value;
      }

      // Handle fix verifier result (optional - log error and continue)
      if (fixVerifierSettled.status === 'rejected') {
        console.error('[StreamingOrchestrator] Fix verifier failed:', fixVerifierSettled.reason);
        this.progress.warn('修复验证失败，继续处理其他结果');
        this.progress.agent('fix-verifier', 'error', String(fixVerifierSettled.reason));
      } else if (fixVerifierSettled.value) {
        this.fixVerificationResults = fixVerifierSettled.value;
        tokensUsed += this.fixVerificationResults.tokens_used;
        const fv = this.fixVerificationResults;
        this.progress.agent(
          'fix-verifier',
          'completed',
          `${fv.by_status.fixed} 已修复, ${fv.by_status.missed} 未修复, ${fv.by_status.false_positive} 误报`
        );
      }

      // Collect results from built-in agents
      const { checklists, tokens: agentTokens } = builtInResult;
      tokensUsed += agentTokens;

      // Collect results from custom agents
      if (customAgentResults.length > 0) {
        const customAgentTokens = customAgentResults.reduce((sum, r) => sum + r.tokens_used, 0);
        tokensUsed += customAgentTokens;

        const totalCustomIssues = customAgentResults.reduce((sum, r) => sum + r.issues.length, 0);
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Custom agents completed: ${totalCustomIssues} issues, ${customAgentTokens} tokens`
          );
        }
      }

      // Phase 3: Wait for all validations to complete
      this.progress.phase(3, 4, '等待验证完成...');
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Waiting for validations to complete...');
      }

      // Flush streaming validator and get results
      let validatedIssues: ValidatedIssue[] = [];
      let validationTokens = 0;
      if (this.streamingValidator) {
        // Start a status polling interval to show progress while waiting
        const statusInterval = globalThis.setInterval(() => {
          const stats = this.streamingValidator?.getStats();
          if (stats && stats.total > 0) {
            this.progress.progress(
              `验证进度: ${stats.completed}/${stats.total} (${stats.activeSessions} 个活跃会话)`
            );
          }
        }, 5000); // Update every 5 seconds

        try {
          const validationResult = await this.streamingValidator.flush();
          validatedIssues = [...validationResult.issues, ...this.autoRejectedIssues];
          validationTokens = validationResult.tokensUsed;
          tokensUsed += validationTokens;
        } finally {
          globalThis.clearInterval(statusInterval);
        }

        const confirmed = validatedIssues.filter((i) => i.validation_status === 'confirmed').length;
        const rejected = validatedIssues.filter((i) => i.validation_status === 'rejected').length;
        const uncertain = validatedIssues.length - confirmed - rejected;

        // Get deduplication stats
        const dedupStats = this.realtimeDeduplicator?.getStats();
        const dedupTokens = dedupStats?.tokensUsed || 0;
        tokensUsed += dedupTokens;

        this.progress.validationSummary({
          total: validatedIssues.length,
          confirmed,
          rejected,
          uncertain,
          autoRejected: this.autoRejectedIssues.length,
          deduplicated: dedupStats?.deduplicated || 0,
          tokensUsed: validationTokens + dedupTokens,
          timeMs: Date.now() - startTime,
        });
      } else if (this.options.skipValidation) {
        // Skip validation mode - convert raw issues to validated without actual validation
        validatedIssues = this.rawIssuesForSkipMode.map((issue) => ({
          ...issue,
          validation_status: 'pending' as const,
          grounding_evidence: {
            checked_files: [],
            checked_symbols: [],
            related_context: '跳过验证',
            reasoning: '用户选择跳过验证',
          },
          final_confidence: issue.confidence,
        }));
        this.progress.info(`跳过验证: ${validatedIssues.length} 个问题`);
      }

      this.progress.success(`验证完成: ${validatedIssues.length} 个有效问题`);

      if (this.options.verbose) {
        console.log(`[StreamingOrchestrator] Total validated issues: ${validatedIssues.length}`);
      }

      // Phase 4: Aggregate and generate report
      this.progress.phase(4, 4, '生成报告...');
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Aggregating results...');
      }

      const aggregationResult = aggregate(validatedIssues, checklists);
      const aggregatedIssues = aggregationResult.issues;
      const aggregatedChecklist = aggregationResult.checklist;

      const metrics = calculateMetrics(
        validatedIssues.map((i) => ({
          id: i.id,
          file: i.file,
          line_start: i.line_start,
          line_end: i.line_end,
          category: i.category,
          severity: i.severity,
          title: i.title,
          description: i.description,
          confidence: i.confidence,
          source_agent: i.source_agent,
        })),
        aggregatedIssues
      );

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
        'zh',
        this.fixVerificationResults
      );

      if (this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Review completed in ${report.metadata.review_time_ms}ms`
        );
      }

      this.progress.complete(aggregatedIssues.length, report.metadata.review_time_ms);

      return report;
    } finally {
      // Managed worktrees are NOT cleaned up after each review
      // They are cached for reuse and automatically cleaned up after staleDays (default: 5 days)
      if (worktreeInfo && this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Worktree preserved for future reuse: ${worktreeInfo.worktreePath}`
        );
      }
    }
  }

  /**
   * Build the review context from input
   */
  private async buildContext(
    input: OrchestratorInput
  ): Promise<{ context: ReviewContext; diffFiles: DiffFile[] }> {
    const { sourceBranch, targetBranch, repoPath } = input;
    const remote = 'origin';

    this.progress.progress('获取远程 refs...');
    if (this.options.verbose) {
      console.log('[StreamingOrchestrator] Fetching remote refs...');
    }
    fetchRemote(repoPath, remote);
    this.progress.success('获取远程 refs 完成');

    this.progress.progress('获取 diff...');
    const diffResult = getDiffWithOptions({
      sourceBranch,
      targetBranch,
      repoPath,
      skipFetch: true,
    });
    const diffSizeKB = Math.round(diffResult.diff.length / 1024);
    this.progress.success(`获取 diff 完成 (${diffSizeKB} KB)`);

    this.progress.progress('解析 diff...');
    const diffFiles = parseDiff(diffResult.diff);
    this.progress.success(`解析完成 (${diffFiles.length} 个文件)`);

    // Local diff analysis (fast, no LLM)
    this.progress.progress('分析变更...');
    const analyzer = new LocalDiffAnalyzer();
    const analysisResult = analyzer.analyze(diffFiles);
    this.progress.success(`分析完成 (${analysisResult.changes.length} 个变更)`);

    // Extract project standards
    this.progress.progress('提取项目标准...');
    if (this.options.verbose) {
      console.log('[StreamingOrchestrator] Extracting project standards...');
    }
    const standards = await createStandards(repoPath);
    this.progress.success('项目标准提取完成');

    return {
      context: {
        repoPath,
        diff: diffResult,
        fileAnalyses: analysisResult.changes,
        standards,
        diffFiles, // Include parsed diff files for filtering
      },
      diffFiles,
    };
  }

  /**
   * Read diff content from external sources
   */
  private async readExternalDiff(input: ReviewInput): Promise<string | null> {
    const { externalDiff, repoPath } = input;
    if (!externalDiff) return null;

    // Priority: diffContent > diffFile > diffStdin > commits
    if (externalDiff.diffContent) {
      this.progress.progress('使用外部 diff 内容...');
      return externalDiff.diffContent;
    }

    if (externalDiff.diffFile) {
      this.progress.progress(`读取 diff 文件: ${externalDiff.diffFile}...`);
      try {
        const filePath = resolve(externalDiff.diffFile);
        const content = readFileSync(filePath, 'utf-8');
        this.progress.success(`读取 diff 文件完成 (${Math.round(content.length / 1024)} KB)`);
        return content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read diff file: ${message}`);
      }
    }

    if (externalDiff.diffStdin) {
      // Note: This will block until stdin is closed (EOF).
      // When used with pipes (e.g., `cat file | argus review`), this works correctly.
      // If stdin is a TTY with no input, user should press Ctrl+D to signal EOF.
      this.progress.progress('从 stdin 读取 diff...');
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        const content = Buffer.concat(chunks).toString('utf-8');
        this.progress.success(`从 stdin 读取 diff 完成 (${Math.round(content.length / 1024)} KB)`);
        return content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read diff from stdin: ${message}`);
      }
    }

    if (externalDiff.commits) {
      // Get commits array
      const commits = Array.isArray(externalDiff.commits)
        ? externalDiff.commits
        : externalDiff.commits.split(',').map((c) => c.trim());

      if (commits.length === 0) {
        throw new Error('No commits specified');
      }

      this.progress.progress(`计算 ${commits.length} 个 commits 的 diff...`);
      if (this.options.verbose) {
        console.log(`[StreamingOrchestrator] Computing diff for commits: ${commits.join(', ')}`);
      }

      // For each commit, get diff against its parent and combine
      const absolutePath = resolve(repoPath);
      const diffs: string[] = [];

      for (const sha of commits) {
        try {
          // Try to get diff against parent
          const diff = execSync(`git diff ${sha}^..${sha}`, {
            cwd: absolutePath,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: 'pipe',
          });
          if (diff.trim()) {
            diffs.push(diff);
          }
        } catch {
          // If no parent (initial commit), use git show
          try {
            const diff = execSync(`git show ${sha} --format="" --patch`, {
              cwd: absolutePath,
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
              stdio: 'pipe',
            });
            if (diff.trim()) {
              diffs.push(diff);
            }
          } catch {
            console.warn(`[StreamingOrchestrator] Failed to get diff for commit ${sha}`);
          }
        }
      }

      const combinedDiff = diffs.join('\n');
      this.progress.success(`计算 diff 完成 (${Math.round(combinedDiff.length / 1024)} KB)`);
      return combinedDiff;
    }

    return null;
  }

  /**
   * Build the review context from ReviewInput (with auto-detection)
   */
  private async buildContextByRefs(input: ReviewInput): Promise<{
    context: ReviewContext;
    diffFiles: DiffFile[];
    sourceRef?: GitRef;
    targetRef?: GitRef;
    reviewMode: ReviewMode;
  }> {
    const { sourceRef: sourceRefStr, targetRef: targetRefStr, repoPath, externalDiff } = input;

    // Check for external diff first
    const externalDiffContent = await this.readExternalDiff(input);

    if (externalDiffContent !== null) {
      // External diff mode - skip git diff computation
      this.progress.progress('解析外部 diff...');
      const diffFiles = parseDiff(externalDiffContent);
      this.progress.success(`解析完成 (${diffFiles.length} 个文件)`);

      // Local diff analysis (fast, no LLM)
      this.progress.progress('分析变更...');
      const analyzer = new LocalDiffAnalyzer();
      const analysisResult = analyzer.analyze(diffFiles);
      this.progress.success(`分析完成 (${analysisResult.changes.length} 个变更)`);

      // Extract project standards
      this.progress.progress('提取项目标准...');
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Extracting project standards...');
      }
      const standards = await createStandards(repoPath);
      this.progress.success('项目标准提取完成');

      // Create a synthetic DiffResult for external diff
      const diffResult = {
        diff: externalDiffContent,
        sourceBranch: sourceRefStr || 'external',
        targetBranch: targetRefStr || 'external',
        repoPath: resolve(repoPath),
        remote: 'origin',
        mode: 'external' as ReviewMode,
      };

      return {
        context: {
          repoPath,
          diff: diffResult,
          fileAnalyses: analysisResult.changes,
          standards,
          diffFiles,
        },
        diffFiles,
        sourceRef: undefined,
        targetRef: undefined,
        reviewMode: 'external' as ReviewMode,
      };
    }

    // Normal mode - compute diff from refs
    if (!sourceRefStr || !targetRefStr) {
      throw new Error('Source and target refs are required when not using external diff');
    }

    // Detect ref types
    const sourceType = detectRefType(sourceRefStr);
    const targetType = detectRefType(targetRefStr);
    const isIncremental = sourceType === 'commit' && targetType === 'commit';

    // Let getDiffByRefs handle fetch logic - it will check if commits exist locally
    // and only fetch if necessary (smart fetch for incremental mode)
    this.progress.progress(isIncremental ? '检查 commits...' : '获取远程 refs...');
    if (this.options.verbose) {
      console.log(
        isIncremental
          ? '[StreamingOrchestrator] Checking if commits exist locally...'
          : '[StreamingOrchestrator] Fetching remote refs...'
      );
    }

    this.progress.progress('获取 diff...');
    const diffResult = getDiffByRefs({
      sourceRef: sourceRefStr,
      targetRef: targetRefStr,
      repoPath,
      skipFetch: false, // Let getDiffByRefs handle smart fetch logic
      smartMergeFilter: !externalDiff?.disableSmartMergeFilter, // Use smart filtering by default
    });
    const diffSizeKB = Math.round(diffResult.diff.length / 1024);
    this.progress.success(`获取 diff 完成 (${diffSizeKB} KB)`);

    this.progress.progress('解析 diff...');
    const diffFiles = parseDiff(diffResult.diff);
    this.progress.success(`解析完成 (${diffFiles.length} 个文件)`);

    // Local diff analysis (fast, no LLM)
    this.progress.progress('分析变更...');
    const analyzer = new LocalDiffAnalyzer();
    const analysisResult = analyzer.analyze(diffFiles);
    this.progress.success(`分析完成 (${analysisResult.changes.length} 个变更)`);

    // Extract project standards
    this.progress.progress('提取项目标准...');
    if (this.options.verbose) {
      console.log('[StreamingOrchestrator] Extracting project standards...');
    }
    const standards = await createStandards(repoPath);
    this.progress.success('项目标准提取完成');

    return {
      context: {
        repoPath,
        diff: diffResult,
        fileAnalyses: analysisResult.changes,
        standards,
        diffFiles, // Include parsed diff files for filtering
      },
      diffFiles,
      sourceRef: diffResult.sourceRef!,
      targetRef: diffResult.targetRef!,
      reviewMode: diffResult.mode || 'branch',
    };
  }

  /**
   * Run specialist agents with streaming issue reporting via MCP
   */
  private async runAgentsWithStreaming(
    context: ReviewContext,
    reviewRepoPath: string,
    agentsToRun: AgentType[] = this.options.agents
  ): Promise<{ checklists: ChecklistItem[]; tokens: number }> {
    const standardsText = standardsToText(context.standards);
    let totalTokens = 0;
    const allChecklists: ChecklistItem[] = [];

    // Calculate dynamic maxTurns based on diff size
    const fileCount = context.diffFiles?.length ?? 0;
    const dynamicMaxTurns = getRecommendedMaxTurns(fileCount);

    if (this.options.verbose) {
      console.log(
        `[StreamingOrchestrator] Dynamic maxTurns: ${dynamicMaxTurns} (${fileCount} files)`
      );
    }

    // Build filter maps for style-reviewer (from parsed diff files)
    const diffFiles = context.diffFiles;
    let changedLinesByFile: Map<string, Set<number>> | undefined;
    let whitespaceOnlyLinesByFile: Map<string, Set<number>> | undefined;

    if (diffFiles && diffFiles.length > 0) {
      // Changed lines: lines with '+' prefix in diff
      changedLinesByFile = new Map();
      for (const file of diffFiles) {
        if (file.changedLines && file.changedLines.length > 0) {
          changedLinesByFile.set(file.path, new Set(file.changedLines));
        }
      }

      // Whitespace-only change lines
      whitespaceOnlyLinesByFile = new Map();
      for (const file of diffFiles) {
        if (file.whitespaceOnlyLines && file.whitespaceOnlyLines.length > 0) {
          whitespaceOnlyLinesByFile.set(file.path, new Set(file.whitespaceOnlyLines));
        }
      }

      if (this.options.verbose) {
        const filesWithChanges = changedLinesByFile.size;
        const filesWithWsOnly = whitespaceOnlyLinesByFile.size;
        console.log(
          `[StreamingOrchestrator] Style filter maps built: ${filesWithChanges} files with changed lines, ${filesWithWsOnly} files with whitespace-only changes`
        );
      }
    }

    // Create MCP server with report_issue tool (includes filter maps)
    const mcpServer = this.createReportIssueMcpServer(
      changedLinesByFile,
      whitespaceOnlyLinesByFile
    );

    // Show agents starting
    for (const agentType of agentsToRun) {
      this.progress.agent(agentType, 'running');
    }

    // Run all agents in parallel with timing
    if (this.options.verbose) {
      console.log(`[StreamingOrchestrator] Running ${agentsToRun.length} agents in parallel...`);
    }

    const agentPromises = agentsToRun.map(async (agentType) => {
      const startTime = Date.now();
      try {
        const result = await this.runStreamingAgent(
          agentType as AgentType,
          context,
          standardsText,
          mcpServer,
          reviewRepoPath,
          dynamicMaxTurns
        );
        const elapsed = Date.now() - startTime;

        return { agentType, result, elapsed, success: true as const };
      } catch (error) {
        const elapsed = Date.now() - startTime;

        return { agentType, error, elapsed, success: false as const };
      }
    });

    const results = await Promise.all(agentPromises);

    // Collect results
    for (const res of results) {
      const elapsedStr =
        res.elapsed < 1000 ? `${res.elapsed}ms` : `${(res.elapsed / 1000).toFixed(1)}s`;

      if (res.success) {
        totalTokens += res.result.tokensUsed;
        allChecklists.push(...res.result.checklists);

        this.progress.agent(res.agentType, 'completed', elapsedStr);

        if (this.options.verbose) {
          console.log(`[StreamingOrchestrator] Agent ${res.agentType} completed in ${elapsedStr}`);
        }
      } else {
        this.progress.agent(res.agentType, 'error', `failed, ${elapsedStr}`);

        if (this.options.verbose) {
          console.error(`[StreamingOrchestrator] Agent ${res.agentType} failed:`, res.error);
        }
      }
    }

    return {
      checklists: allChecklists,
      tokens: totalTokens,
    };
  }

  /**
   * Create MCP server with report_issue tool
   *
   * @param changedLinesByFile - Map of file path to set of changed line numbers (for filtering style issues)
   * @param whitespaceOnlyLinesByFile - Map of file path to set of whitespace-only change line numbers
   */
  private createReportIssueMcpServer(
    changedLinesByFile?: Map<string, Set<number>>,
    whitespaceOnlyLinesByFile?: Map<string, Set<number>>
  ) {
    const validator = this.streamingValidator;
    const deduplicator = this.realtimeDeduplicator;
    const verbose = this.options.verbose;
    const skipValidation = this.options.skipValidation;
    const progress = this.progress;

    // We need to track which agent is calling, so we'll create per-agent servers
    return (agentType: AgentType) =>
      createSdkMcpServer({
        name: 'code-review-tools',
        version: '1.0.0',
        tools: [
          tool(
            'report_issue',
            `Report a discovered code issue. Call this for EACH issue found during review.
The issue will be checked for duplicates and validated automatically.
Write all text (title, description, suggestion) in Chinese.`,
            {
              file: z.string().describe('File path where the issue is located'),
              line_start: z.number().describe('Starting line number'),
              line_end: z.number().describe('Ending line number'),
              severity: z
                .enum(['critical', 'error', 'warning', 'suggestion'])
                .describe('Issue severity level'),
              category: z
                .enum(['security', 'logic', 'performance', 'style', 'maintainability'])
                .describe('Issue category'),
              title: z.string().describe('Short title in Chinese'),
              description: z.string().describe('Detailed description in Chinese'),
              suggestion: z.string().optional().describe('Fix suggestion in Chinese'),
              code_snippet: z.string().optional().describe('Relevant code snippet'),
              confidence: z.number().min(0).max(1).describe('Confidence level (0-1)'),
            },
            async (args) => {
              if (verbose) {
                console.log(`[MCP] report_issue called by ${agentType}: ${args.title}`);
              }

              // Generate unique issue ID
              const issueId = `${agentType}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

              // Step 0: Apply style-reviewer filters (before dedup/validation)
              // Filter 1: Check if style issue is on unchanged context line
              if (
                agentType === 'style-reviewer' &&
                args.category === 'style' &&
                changedLinesByFile
              ) {
                const changedLines = changedLinesByFile.get(args.file);
                if (!changedLines || changedLines.size === 0) {
                  // No changed lines in this file - filter out
                  if (verbose) {
                    console.log(
                      `[StreamingOrchestrator] Filtered style issue "${args.title}" - file has no changed lines: ${args.file}`
                    );
                  }
                  progress.info(`过滤: "${args.title}" (文件无改动行)`);
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: `⏭️ 问题已过滤 (ID: ${issueId})\n原因: 样式问题在未变更的文件行上`,
                      },
                    ],
                  };
                }

                // Check if issue's line range overlaps with any changed line
                const lineStart = args.line_start;
                const lineEnd = args.line_end ?? args.line_start;
                let hasOverlap = false;
                for (let line = lineStart; line <= lineEnd; line++) {
                  if (changedLines.has(line)) {
                    hasOverlap = true;
                    break;
                  }
                }

                if (!hasOverlap) {
                  if (verbose) {
                    console.log(
                      `[StreamingOrchestrator] Filtered style issue "${args.title}" on unchanged line ${lineStart}: ${args.file}`
                    );
                  }
                  progress.info(`过滤: "${args.title}" (行 ${lineStart} 未变更)`);
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: `⏭️ 问题已过滤 (ID: ${issueId})\n原因: 样式问题在未变更的行上 (行 ${lineStart}-${lineEnd})`,
                      },
                    ],
                  };
                }
              }

              // Filter 2: Check if style issue is on whitespace-only change line
              if (
                agentType === 'style-reviewer' &&
                args.category === 'style' &&
                whitespaceOnlyLinesByFile
              ) {
                const whitespaceLines = whitespaceOnlyLinesByFile.get(args.file);
                if (whitespaceLines && whitespaceLines.has(args.line_start)) {
                  if (verbose) {
                    console.log(
                      `[StreamingOrchestrator] Filtered pre-existing style issue "${args.title}" on whitespace-only line ${args.line_start}: ${args.file}`
                    );
                  }
                  progress.info(`过滤: "${args.title}" (仅空白变更行 ${args.line_start})`);
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: `⏭️ 问题已过滤 (ID: ${issueId})\n原因: 样式问题在仅空白变更的行上 (行 ${args.line_start})`,
                      },
                    ],
                  };
                }
              }

              const rawIssue: RawIssue = {
                id: issueId,
                file: args.file,
                line_start: args.line_start,
                line_end: args.line_end,
                severity: args.severity,
                category: args.category,
                title: args.title,
                description: args.description,
                suggestion: args.suggestion,
                code_snippet: args.code_snippet,
                confidence: args.confidence,
                source_agent: agentType,
              };

              // Step 1: Realtime deduplication check
              if (deduplicator) {
                const dedupResult = await deduplicator.checkAndAdd(rawIssue);
                if (dedupResult.isDuplicate) {
                  // Issue is a duplicate - skip validation
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: `⚠️ 问题已去重 (ID: ${issueId})\n与已有问题重复: ${dedupResult.duplicateOf?.title}\n原因: ${dedupResult.reason || '相同根因'}`,
                      },
                    ],
                  };
                }
              }

              // Step 2: Process accepted issue
              if (skipValidation) {
                // Skip validation mode - just collect issues
                this.rawIssuesForSkipMode.push(rawIssue);
                return {
                  content: [
                    { type: 'text' as const, text: `✓ 问题已接收 (ID: ${issueId})\n跳过验证模式` },
                  ],
                };
              }

              // Enqueue for streaming validation
              const autoRejected = validator?.enqueue(rawIssue);
              if (autoRejected) {
                // Issue was auto-rejected due to low confidence
                this.autoRejectedIssues.push(autoRejected);
              }

              return {
                content: [
                  { type: 'text' as const, text: `✓ 问题已接收 (ID: ${issueId})\n正在后台验证...` },
                ],
              };
            }
          ),
        ],
      });
  }

  /**
   * Run a single streaming agent
   */
  private async runStreamingAgent(
    agentType: AgentType,
    context: ReviewContext,
    standardsText: string,
    mcpServerFactory: (agentType: AgentType) => ReturnType<typeof createSdkMcpServer>,
    reviewRepoPath: string,
    maxTurns: number = 30
  ): Promise<{ tokensUsed: number; checklists: ChecklistItem[] }> {
    if (this.options.verbose) {
      console.log(`[StreamingOrchestrator] Starting agent: ${agentType}`);
    }

    // Get project-specific rules for this agent
    const projectRules =
      agentType !== 'validator'
        ? getRulesForAgent(this.rulesConfig, agentType as RuleAgentType)
        : undefined;

    // Build prompts
    const systemPrompt = buildStreamingSystemPrompt(agentType);
    const userPrompt = buildStreamingUserPrompt(agentType, {
      diff: context.diff.diff,
      fileAnalyses: context.fileAnalyses
        .map((f) => `- ${f.file_path}: ${f.semantic_hints?.summary || 'No summary'}`)
        .join('\n'),
      standardsText,
      projectRules: projectRules
        ? `## Project-Specific Review Guidelines\n\n> Loaded from: ${this.rulesConfig.sources.join(', ')}\n\n${projectRules}`
        : undefined,
    });

    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    // Create MCP server for this agent
    const mcpServer = mcpServerFactory(agentType);

    let tokensUsed = 0;
    let turnCount = 0;

    try {
      const queryStream = query({
        prompt: fullPrompt,
        options: {
          cwd: reviewRepoPath,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns, // Dynamic based on diff size
          model: DEFAULT_AGENT_MODEL,
          settingSources: ['project'], // Load CLAUDE.md from repo
          mcpServers: {
            'code-review-tools': mcpServer,
          },
        },
      });

      // Consume the stream
      for await (const message of queryStream) {
        // 统计 stream_event 消息作为 turn 计数
        if (message.type === 'stream_event') {
          turnCount++;
        }

        if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;
          if (resultMessage.subtype === 'success') {
            const inputTokens = resultMessage.usage.input_tokens;
            const outputTokens = resultMessage.usage.output_tokens;
            tokensUsed = inputTokens + outputTokens;

            // 详细日志：Agent 最终 token 消耗
            console.log(
              `[Agent-Detail] ${agentType} FinalResult ` +
                `Tokens: input=${inputTokens}, output=${outputTokens}, total=${tokensUsed}, turns=${turnCount}`
            );
          } else {
            if (this.options.verbose) {
              console.error(
                `[StreamingOrchestrator] Agent ${agentType} error:`,
                resultMessage.subtype
              );
            }
          }
        }
      }
    } catch (error) {
      console.error(`[StreamingOrchestrator] Agent ${agentType} threw error:`, error);
    }

    // 详细日志：Agent 完成汇总
    console.log(
      `[Agent-Summary] ${agentType} completed: turns=${turnCount}, totalTokens=${tokensUsed}`
    );

    if (this.options.verbose) {
      console.log(`[StreamingOrchestrator] Agent ${agentType} completed`);
    }

    // TODO: Parse checklist from agent output if needed
    return {
      tokensUsed,
      checklists: [],
    };
  }
}

/**
 * Create a streaming review orchestrator instance
 */
export function createStreamingOrchestrator(
  options?: OrchestratorOptions
): StreamingReviewOrchestrator {
  return new StreamingReviewOrchestrator(options);
}

/**
 * Convenience function to run a streaming review (branch-based)
 */
export async function streamingReview(input: OrchestratorInput): Promise<ReviewReport> {
  const orchestrator = createStreamingOrchestrator(input.options);
  return orchestrator.review(input);
}

/**
 * Convenience function to run a streaming review with auto-detection
 *
 * This function auto-detects whether the provided refs are branches or commits,
 * supporting both initial PR reviews and incremental reviews.
 *
 * @example
 * // Branch-based review (initial PR)
 * await reviewByRefs({ repoPath: '.', sourceRef: 'feature-branch', targetRef: 'main' });
 *
 * // Commit-based review (incremental)
 * await reviewByRefs({ repoPath: '.', sourceRef: 'abc1234', targetRef: 'def5678' });
 */
export async function reviewByRefs(input: ReviewInput): Promise<ReviewReport> {
  const orchestrator = createStreamingOrchestrator(input.options);
  return orchestrator.reviewByRefs(input);
}

/**
 * Unified review function that auto-detects input type
 *
 * Accepts either OrchestratorInput (legacy) or ReviewInput (new).
 * For ReviewInput, auto-detects branch vs commit refs.
 */
export async function review(input: OrchestratorInput | ReviewInput): Promise<ReviewReport> {
  const orchestrator = createStreamingOrchestrator(input.options);

  // Check if it's a ReviewInput (has sourceRef/targetRef) or OrchestratorInput (has sourceBranch/targetBranch)
  if ('sourceRef' in input && 'targetRef' in input) {
    return orchestrator.reviewByRefs(input as ReviewInput);
  } else {
    return orchestrator.review(input as OrchestratorInput);
  }
}
