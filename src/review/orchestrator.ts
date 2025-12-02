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
  LocalReviewInput,
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
  getIncrementalDiff,
  getRemoteBranchSha,
  getLocalDiff,
  type WorktreeInfo,
} from '../git/diff.js';
import {
  createStateManager,
  type ReviewStateManager,
  type IncrementalCheckResult,
} from './state-manager.js';
import { parseDiff, type DiffFile } from '../git/parser.js';
import { selectAgents, type AgentSelectionResult } from './agent-selector.js';
import { LocalDiffAnalyzer } from '../analyzer/local-analyzer.js';
import { createValidator } from './validator.js';
import { createDeduplicator } from './deduplicator.js';
import {
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_MAX_THINKING_TOKENS,
  getMinConfidenceForValidation,
} from './constants.js';
import {
  createProgressPrinter,
  nullProgressPrinter,
  type IProgressPrinter,
} from '../cli/progress.js';

/**
 * Default orchestrator options
 */
const DEFAULT_OPTIONS: Required<Omit<OrchestratorOptions, 'onEvent'>> & {
  onEvent?: OrchestratorOptions['onEvent'];
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
  incremental: false,
  resetState: false,
  progressMode: 'auto',
  onEvent: undefined,
};

/**
 * Review Orchestrator
 *
 * Coordinates multiple specialized agents to perform comprehensive code review.
 */
export class ReviewOrchestrator {
  private options: typeof DEFAULT_OPTIONS;
  private progress: IProgressPrinter;
  private stateManager?: ReviewStateManager;
  private incrementalInfo?: IncrementalCheckResult;

  constructor(options?: OrchestratorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.progress = this.options.showProgress ? createProgressPrinter() : nullProgressPrinter;
  }

  /**
   * Execute the complete review process
   */
  async review(input: OrchestratorInput): Promise<ReviewReport> {
    const startTime = Date.now();
    let worktreeInfo: WorktreeInfo | null = null;
    let currentSha = '';

    // Initialize state manager for incremental review
    this.stateManager = createStateManager(input.repoPath, this.options.verbose);

    // Handle reset state
    if (this.options.resetState) {
      this.progress.info('重置审查状态...');
      this.stateManager.clear(input.sourceBranch);
    }

    // Check for incremental review possibility
    if (this.options.incremental) {
      this.progress.progress('检查增量审查条件...');
      this.incrementalInfo = this.stateManager.checkIncremental(
        input.sourceBranch,
        input.targetBranch
      );

      if (this.incrementalInfo.canIncrement) {
        this.progress.success(
          `增量审查模式: ${this.incrementalInfo.newCommitCount} 个新提交 ` +
            `(${this.incrementalInfo.lastReviewedSha?.slice(0, 7)}..${this.incrementalInfo.currentSha.slice(0, 7)})`
        );
        currentSha = this.incrementalInfo.currentSha;
      } else {
        this.progress.info(`无法增量审查: ${this.incrementalInfo.reason}`);
        this.progress.info('切换到完整审查模式');
        this.incrementalInfo = undefined;
      }
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

      const { context, diffFiles } = await this.buildContext(input);
      this.progress.success(`上下文构建完成 (${context.fileAnalyses.length} 个文件)`);

      // Smart agent selection
      const { agentsToRun } = await this.selectAgentsIfEnabled(diffFiles);

      // Create worktree for review
      this.progress.progress(`创建 worktree: ${input.sourceBranch}...`);
      if (this.options.verbose) {
        console.log(`[Orchestrator] Creating worktree for source branch: ${input.sourceBranch}`);
      }
      worktreeInfo = createWorktreeForReview(input.repoPath, input.sourceBranch);
      this.progress.success(`Worktree 已创建: ${worktreeInfo.worktreePath}`);
      if (this.options.verbose) {
        console.log(`[Orchestrator] Worktree created at: ${worktreeInfo.worktreePath}`);
      }

      // Phase 2-4: Run review pipeline
      const { report, aggregatedIssues } = await this.runReviewPipeline(
        context,
        agentsToRun,
        startTime,
        currentPhase,
        totalPhases
      );

      // Save review state for incremental reviews
      if (this.stateManager) {
        try {
          // Get current SHA if not already set
          if (!currentSha) {
            currentSha = getRemoteBranchSha(input.repoPath, input.sourceBranch);
          }

          const state = this.stateManager.createState({
            branch: input.sourceBranch,
            targetBranch: input.targetBranch,
            currentSha,
            issues: aggregatedIssues.map((issue) => ({
              file: issue.file,
              line_start: issue.line_start,
              line_end: issue.line_end,
              category: issue.category,
              title: issue.title,
            })),
            metadata: {
              totalIssues: aggregatedIssues.length,
              reviewTimeMs: report.metadata.review_time_ms,
              agentsUsed: report.metadata.agents_used,
            },
          });

          this.stateManager.save(state);
          this.progress.info(`审查状态已保存 (${currentSha.slice(0, 7)})`);

          if (this.options.verbose) {
            console.log(
              `[Orchestrator] Review state saved to: ${this.stateManager.getStateLocation(input.sourceBranch)}`
            );
          }
        } catch (stateError) {
          console.warn('[Orchestrator] Failed to save review state:', stateError);
        }
      }

      return report;
    } finally {
      // Clean up worktree
      if (worktreeInfo) {
        this.progress.progress('清理 worktree...');
        if (this.options.verbose) {
          console.log(`[Orchestrator] Removing worktree: ${worktreeInfo.worktreePath}`);
        }
        try {
          removeWorktree(worktreeInfo);
          this.progress.success('Worktree 已清理');
        } catch (cleanupError) {
          console.error('[Orchestrator] Failed to clean up worktree:', cleanupError);
        }
      }
    }
  }

  /**
   * Execute a local pre-commit review
   *
   * Reviews all uncommitted changes (staged + unstaged) without:
   * - Fetching remote refs
   * - Creating worktrees
   * - Modifying any files (read-only)
   */
  async reviewLocal(input: LocalReviewInput): Promise<ReviewReport> {
    const startTime = Date.now();
    const repoPath = input.repoPath || process.cwd();

    const totalPhases = this.options.skipValidation ? 4 : 5;
    let currentPhase = 0;

    // Phase 1: Build local review context
    currentPhase++;
    this.progress.phase(currentPhase, totalPhases, '构建本地审查上下文...');
    if (this.options.verbose) {
      console.log('[Orchestrator] Building local review context...');
    }

    const { context, diffFiles } = await this.buildLocalContext(repoPath);
    this.progress.success(`上下文构建完成 (${context.fileAnalyses.length} 个文件)`);

    // Smart agent selection
    const { agentsToRun } = await this.selectAgentsIfEnabled(diffFiles);

    // NO worktree creation for local review - agents work directly on repo
    this.progress.info('本地审查模式: 直接在当前目录运行 (只读)');

    // Phase 2-4: Run review pipeline
    const { report } = await this.runReviewPipeline(
      context,
      agentsToRun,
      startTime,
      currentPhase,
      totalPhases
    );

    return report;
  }

  /**
   * Build context for local pre-commit review
   *
   * Differences from buildContext:
   * - No remote fetch
   * - Uses git diff HEAD instead of branch comparison
   * - No worktree path needed
   */
  private async buildLocalContext(
    repoPath: string
  ): Promise<{ context: ReviewContext; diffFiles: DiffFile[] }> {
    // Step 1: Get local diff (no remote fetch needed)
    this.progress.progress('获取本地 diff...');
    if (this.options.verbose) {
      console.log('[Orchestrator] Getting local diff (git diff HEAD)...');
    }

    const diffResult = getLocalDiff(repoPath);

    if (!diffResult.diff.trim()) {
      throw new Error('没有本地更改可审查。请先修改代码后再运行 pre-commit 审查。');
    }

    const diffSizeKB = Math.round(diffResult.diff.length / 1024);
    this.progress.success(`获取本地 diff 完成 (${diffSizeKB} KB)`);

    // Step 2: Parse diff
    this.progress.progress('解析 diff...');
    const diffFiles = parseDiff(diffResult.diff);
    this.progress.success(`解析完成 (${diffFiles.length} 个文件)`);

    // Step 3: Local diff analysis (fast, no LLM)
    this.progress.progress('分析变更...');
    const analyzer = new LocalDiffAnalyzer();
    const analysisResult = analyzer.analyze(diffFiles);
    this.progress.success(`分析完成 (${analysisResult.changes.length} 个变更)`);

    // Step 4: Extract project standards
    this.progress.progress('提取项目标准...');
    if (this.options.verbose) {
      console.log('[Orchestrator] Extracting project standards...');
    }
    const standards = await createStandards(repoPath);
    this.progress.success('项目标准提取完成');

    // Create a DiffResult-compatible object for ReviewContext
    const diffForContext = {
      diff: diffResult.diff,
      sourceBranch: 'local',
      targetBranch: 'HEAD',
      repoPath: diffResult.repoPath,
      remote: '',
    };

    return {
      context: {
        repoPath,
        diff: diffForContext,
        fileAnalyses: analysisResult.changes,
        standards,
        diffFiles,
      },
      diffFiles,
    };
  }

  /**
   * Build the review context from input
   *
   * Optimized: DiffAnalyzer + Standards run in parallel
   * Supports incremental diff when incrementalInfo is available
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

    // Step 2: Get diff (incremental or full)
    let diffResult;
    if (this.incrementalInfo?.canIncrement && this.incrementalInfo.lastReviewedSha) {
      // Incremental diff: only changes since last review
      const lastSha = this.incrementalInfo.lastReviewedSha;
      this.progress.progress(`获取增量 diff: ${lastSha.slice(0, 7)}...${remote}/${sourceBranch}`);

      const incrementalResult = getIncrementalDiff({
        repoPath,
        sourceBranch,
        targetBranch,
        lastReviewedSha: lastSha,
        skipFetch: true,
      });

      diffResult = incrementalResult;
      const diffSizeKB = Math.round(diffResult.diff.length / 1024);
      this.progress.success(
        `获取增量 diff 完成 (${diffSizeKB} KB, ${incrementalResult.newCommitCount} 个新提交)`
      );

      if (this.options.verbose) {
        console.log(
          `[Orchestrator] Incremental diff: ${incrementalResult.fromSha.slice(0, 7)}..${incrementalResult.toSha.slice(0, 7)}`
        );
      }
    } else {
      // Full diff: all changes from target to source
      this.progress.progress(`获取 diff: ${remote}/${targetBranch}...${remote}/${sourceBranch}`);
      diffResult = getDiffWithOptions({
        sourceBranch,
        targetBranch,
        repoPath,
        skipFetch: true,
      });
      const diffSizeKB = Math.round(diffResult.diff.length / 1024);
      this.progress.success(`获取 diff 完成 (${diffSizeKB} KB)`);
    }

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
        diffFiles,
      },
      diffFiles,
    };
  }

  // ============================================================================
  // Shared Review Pipeline Methods
  // ============================================================================

  /**
   * Select agents based on diff content (if smart selection is enabled)
   */
  private async selectAgentsIfEnabled(diffFiles: DiffFile[]): Promise<{
    agentsToRun: AgentType[];
    selectionResult: AgentSelectionResult | null;
  }> {
    let agentsToRun = this.options.agents;
    let selectionResult: AgentSelectionResult | null = null;

    if (this.options.smartAgentSelection) {
      this.progress.progress('智能选择 Agents...');
      if (this.options.verbose) {
        console.log('[Orchestrator] Running smart agent selection...');
      }

      selectionResult = await selectAgents(diffFiles, {
        verbose: this.options.verbose,
        disableLLM: this.options.disableSelectionLLM,
      });

      agentsToRun = selectionResult.agents;

      const skippedAgents = this.options.agents.filter((a) => !agentsToRun.includes(a));

      if (skippedAgents.length > 0) {
        this.progress.success(
          `智能选择完成: 运行 ${agentsToRun.length} 个, 跳过 ${skippedAgents.length} 个`
        );
      } else {
        this.progress.success(`智能选择完成: 运行全部 ${agentsToRun.length} 个 Agents`);
      }

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

    return { agentsToRun, selectionResult };
  }

  /**
   * Run the review pipeline: agents → aggregation → report
   *
   * Shared by both review() and reviewLocal() methods
   */
  private async runReviewPipeline(
    context: ReviewContext,
    agentsToRun: AgentType[],
    startTime: number,
    startPhase: number,
    totalPhases: number
  ): Promise<{ report: ReviewReport; tokensUsed: number; aggregatedIssues: ValidatedIssue[] }> {
    let tokensUsed = 0;
    let currentPhase = startPhase;

    // Phase: Run specialist agents
    currentPhase++;
    this.progress.phase(currentPhase, totalPhases, `运行 ${agentsToRun.length} 个 Agents...`);
    if (this.options.verbose) {
      console.log('[Orchestrator] Running specialist agents with streaming validation...');
    }

    const { validatedIssues, checklists, tokens_used } =
      await this.runAgentsWithStreamingValidation(context, agentsToRun);
    tokensUsed += tokens_used;

    if (this.options.verbose) {
      console.log(`[Orchestrator] Total validated issues: ${validatedIssues.length}`);
    }

    // Phase: Aggregate results
    currentPhase++;
    this.progress.phase(currentPhase, totalPhases, '聚合结果...');
    if (this.options.verbose) {
      console.log('[Orchestrator] Aggregating results...');
    }

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

    // Phase: Generate report
    currentPhase++;
    this.progress.phase(currentPhase, totalPhases, '生成报告...');

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
      'zh'
    );

    this.progress.success('报告生成完成');

    if (this.options.verbose) {
      console.log(`[Orchestrator] Review completed in ${report.metadata.review_time_ms}ms`);
    }

    this.progress.complete(aggregatedIssues.length, report.metadata.review_time_ms);

    return { report, tokensUsed, aggregatedIssues };
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

    // Step 3: Filter out low-confidence issues using dynamic thresholds by severity
    // Critical issues have lower thresholds (0.2), suggestions have higher (0.7)
    const highConfidenceIssues = uniqueIssues.filter((issue) => {
      const threshold = getMinConfidenceForValidation(issue.severity);
      return issue.confidence >= threshold;
    });

    const lowConfidenceIssues: ValidatedIssue[] = uniqueIssues
      .filter((issue) => {
        const threshold = getMinConfidenceForValidation(issue.severity);
        return issue.confidence < threshold;
      })
      .map((issue) => {
        const threshold = getMinConfidenceForValidation(issue.severity);
        return {
          ...issue,
          validation_status: 'rejected' as const,
          grounding_evidence: {
            checked_files: [],
            checked_symbols: [],
            related_context: '置信度过低，自动跳过验证',
            reasoning: `置信度 ${issue.confidence} 低于阈值 ${threshold}（${issue.severity} 级别），自动拒绝`,
          },
          final_confidence: issue.confidence,
          rejection_reason: `置信度过低 (${issue.confidence} < ${threshold}，${issue.severity} 级别)`,
        };
      });

    if (lowConfidenceIssues.length > 0) {
      this.progress.info(
        `跳过 ${lowConfidenceIssues.length} 个低置信度问题 (动态阈值: critical≥0.2, error≥0.4, warning≥0.5, suggestion≥0.7)`
      );
      if (this.options.verbose) {
        console.log(
          `[Orchestrator] Skipping validation for ${lowConfidenceIssues.length} low-confidence issues (using dynamic thresholds by severity)`
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

    const validator = createValidator({
      repoPath: context.repoPath,
      verbose: this.options.verbose,
      onProgress: (current, total, issueId) => {
        this.progress.validation(current, total, issueId);
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

    // Extract whitespace-only changes for post-filtering (style-reviewer only)
    let whitespaceOnlyChanges: Array<{ path: string; lines: number[] }> | undefined;
    if (agentType === 'style-reviewer' && context.diffFiles) {
      whitespaceOnlyChanges = context.diffFiles
        .filter((f) => f.whitespaceOnlyLines && f.whitespaceOnlyLines.length > 0)
        .map((f) => ({
          path: f.path,
          lines: f.whitespaceOnlyLines!,
        }));
    }

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

            // Apply whitespace-only filter to structured output as well
            let issues = parsed.issues || [];
            if (
              agentType === 'style-reviewer' &&
              whitespaceOnlyChanges &&
              whitespaceOnlyChanges.length > 0
            ) {
              issues = this.applyWhitespaceOnlyFilter(issues, whitespaceOnlyChanges);
            }

            return {
              agent: agentType,
              issues,
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

    // Post-filter: reduce confidence for style issues on whitespace-only lines
    let filteredIssues = parsed.issues;
    if (
      agentType === 'style-reviewer' &&
      whitespaceOnlyChanges &&
      whitespaceOnlyChanges.length > 0
    ) {
      filteredIssues = this.applyWhitespaceOnlyFilter(parsed.issues, whitespaceOnlyChanges);
    }

    if (this.options.verbose) {
      console.log(
        `[Orchestrator] Agent ${agentType} completed: ${filteredIssues.length} issues found`
      );
    }

    return {
      agent: agentType,
      issues: filteredIssues,
      checklist: parsed.checklist,
      tokens_used: tokensUsed,
    };
  }

  /**
   * Filter out style issues on whitespace-only lines
   *
   * This is a deterministic code-based filter (no AI involved):
   * - If a style issue's line_start is on a whitespace-only change line, remove it
   * - These are pre-existing issues, not introduced by this change
   *
   * We use line_start because that's typically where the actual problem is located.
   */
  private applyWhitespaceOnlyFilter(
    issues: RawIssue[],
    whitespaceOnlyChanges: Array<{ path: string; lines: number[] }>
  ): RawIssue[] {
    // Build a quick lookup map: file -> Set of whitespace-only line numbers
    const whitespaceLinesByFile = new Map<string, Set<number>>();
    for (const { path, lines } of whitespaceOnlyChanges) {
      whitespaceLinesByFile.set(path, new Set(lines));
    }

    let filteredCount = 0;

    const filtered = issues.filter((issue) => {
      // Only filter style category issues
      if (issue.category !== 'style') {
        return true; // Keep non-style issues
      }

      const whitespaceLines = whitespaceLinesByFile.get(issue.file);
      if (!whitespaceLines) {
        return true; // No whitespace-only lines in this file, keep the issue
      }

      // Check if the issue's starting line is a whitespace-only change
      // This is the key logic: if line_start is whitespace-only, the issue is pre-existing
      if (whitespaceLines.has(issue.line_start)) {
        filteredCount++;
        if (this.options.verbose) {
          console.log(
            `[Orchestrator] Filtered pre-existing style issue "${issue.id}" on whitespace-only line ${issue.line_start}: ${issue.title}`
          );
        }
        return false; // Remove this issue
      }

      return true; // Keep the issue
    });

    if (filteredCount > 0) {
      this.progress.info(`过滤了 ${filteredCount} 个仅空白变更行上的已存在 style 问题`);
    }

    return filtered;
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

/**
 * Convenience function to run a local pre-commit review
 */
export async function reviewLocal(input: LocalReviewInput): Promise<ReviewReport> {
  const orchestrator = createOrchestrator(input.options);
  return orchestrator.reviewLocal(input);
}
