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
  fetchRemote,
  createWorktreeForReview,
  removeWorktree,
  type WorktreeInfo,
} from '../git/diff.js';
import { parseDiff, type DiffFile } from '../git/parser.js';
import { selectAgents, type AgentSelectionResult } from './agent-selector.js';
import { LocalDiffAnalyzer } from '../analyzer/local-analyzer.js';
import { StatusServer } from '../monitor/status-server.js';
import { createStreamingValidator, type StreamingValidator } from './streaming-validator.js';
import { buildStreamingSystemPrompt, buildStreamingUserPrompt } from './prompts/streaming.js';
import { standardsToText } from './prompts/specialist.js';
import { DEFAULT_AGENT_MODEL } from './constants.js';
import {
  createProgressPrinter,
  nullProgressPrinter,
  type IProgressPrinter,
} from '../cli/progress.js';
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
  incremental: false,
  resetState: false,
};

/**
 * Streaming Review Orchestrator
 *
 * Uses MCP tools for real-time issue reporting with immediate deduplication and validation.
 */
export class StreamingReviewOrchestrator {
  private options: Required<OrchestratorOptions>;
  private statusServer?: StatusServer;
  private streamingValidator?: StreamingValidator;
  private realtimeDeduplicator?: RealtimeDeduplicator;
  private progress: IProgressPrinter;
  private rulesConfig: RulesConfig = EMPTY_RULES_CONFIG;
  private autoRejectedIssues: ValidatedIssue[] = [];
  private rawIssuesForSkipMode: RawIssue[] = [];
  private loadedCustomAgents: LoadedCustomAgent[] = [];

  constructor(options?: OrchestratorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.progress = this.options.showProgress ? createProgressPrinter() : nullProgressPrinter;
  }

  /**
   * Execute the complete review process with streaming
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
      // Phase 1: Build review context
      this.progress.phase(1, 4, '构建审查上下文...');
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Building review context...');
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Context Building',
        message: '正在构建审查上下文...',
      });

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

      // Create worktree for review (allows agents to read actual source code)
      this.progress.progress(`创建 worktree: ${input.sourceBranch}...`);
      if (this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Creating worktree for source branch: ${input.sourceBranch}`
        );
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Worktree',
        message: `正在创建 worktree: ${input.sourceBranch}...`,
      });
      worktreeInfo = createWorktreeForReview(input.repoPath, input.sourceBranch);
      this.progress.success(`Worktree 已创建: ${worktreeInfo.worktreePath}`);
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
          this.sendStatus({
            type: 'progress',
            message: `问题去重: ${newIssue.title}`,
            details: {
              issue_id: newIssue.id,
              duplicate_of: existingIssue.id,
              reason,
            },
          });
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
                this.progress.issueDiscovered(issue.title, issue.file, issue.severity);
                this.sendStatus({
                  type: 'progress',
                  message: `发现问题: ${issue.title}`,
                  details: {
                    issue_id: issue.id,
                    severity: issue.severity,
                    file: issue.file,
                    line: issue.line_start,
                  },
                });
              },
              onIssueValidated: (issue) => {
                const reason =
                  issue.validation_status === 'rejected'
                    ? issue.rejection_reason || issue.grounding_evidence?.reasoning
                    : undefined;
                this.progress.issueValidated(issue.title, issue.validation_status, reason);
                this.sendStatus({
                  type: 'progress',
                  message: `验证完成: ${issue.title} (${issue.validation_status})`,
                  details: {
                    issue_id: issue.id,
                    status: issue.validation_status,
                    reason: reason,
                  },
                });
              },
              onAutoRejected: (issue, reason) => {
                this.progress.autoRejected(issue.title, reason);
              },
              onRoundComplete: (_issueId, issueTitle, round, maxRounds, status) => {
                this.progress.validationRound(issueTitle, round, maxRounds, status);
              },
              onValidationActivity: (_issueId, issueTitle, activity) => {
                this.progress.validationActivity(issueTitle, activity);
              },
            },
          });

      // Phase 2: Run specialist agents with streaming issue reporting
      this.progress.phase(2, 4, `运行 ${agentsToRun.length} 个 Agents...`);
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Running specialist agents with streaming...');
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Agent Execution',
        message: '正在运行专业审查 Agents...',
      });

      const { checklists, tokens: agentTokens } = await this.runAgentsWithStreaming(
        context,
        reviewRepoPath,
        agentsToRun
      );
      tokensUsed += agentTokens;

      // Run custom agents if any were triggered
      let customAgentResults: CustomAgentResult[] = [];
      if (triggeredCustomAgents.length > 0) {
        this.progress.progress(`运行 ${triggeredCustomAgents.length} 个自定义 Agents...`);
        if (this.options.verbose) {
          console.log(
            `[StreamingOrchestrator] Running ${triggeredCustomAgents.length} custom agents...`
          );
        }
        this.sendStatus({
          type: 'phase',
          phase: 'Custom Agent Execution',
          message: `正在运行 ${triggeredCustomAgents.length} 个自定义审查 Agents...`,
        });

        // Show custom agents starting
        for (const agent of triggeredCustomAgents) {
          this.progress.agent(agent.name, 'running');
        }

        // Build file analyses summary for custom agents
        const fileAnalysesSummary = context.fileAnalyses
          .map((f) => `- ${f.file_path}: ${f.semantic_hints?.summary || 'No summary'}`)
          .join('\n');

        customAgentResults = await executeCustomAgents(
          triggeredCustomAgents,
          {
            verbose: this.options.verbose,
            repoPath: reviewRepoPath,
            diffContent: context.diff.diff,
            fileAnalysesSummary,
            standardsText: standardsToText(context.standards),
          },
          {
            onAgentStart: (agent) => {
              this.sendStatus({
                type: 'agent',
                agent: agent.name,
                message: `${agent.name} 开始分析...`,
                details: { status: 'running', isCustom: true },
              });
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
              this.sendStatus({
                type: 'agent',
                agent: agent.name,
                message: `${agent.name} 完成`,
                details: { status: 'completed', issues: result.issues.length, isCustom: true },
              });
            },
            onAgentError: (agent, error) => {
              this.progress.agent(agent.name, 'error', error.message);
              this.sendStatus({
                type: 'agent',
                agent: agent.name,
                message: `${agent.name} 失败: ${error.message}`,
                details: { status: 'error', isCustom: true },
              });
            },
            onIssueDiscovered: (issue) => {
              // Note: Don't call this.progress.issueDiscovered() here
              // because enqueue() will trigger the callback which already calls it.
              // Only send status update for the web monitor.
              this.sendStatus({
                type: 'progress',
                message: `发现问题: ${issue.title}`,
                details: {
                  issue_id: issue.id,
                  severity: issue.severity,
                  file: issue.file,
                  line: issue.line_start,
                  isCustom: true,
                },
              });

              // Enqueue custom agent issues for validation
              // This will trigger the streaming validator's onIssueDiscovered callback
              // which handles CLI progress output
              if (!this.options.skipValidation && this.streamingValidator) {
                const autoRejected = this.streamingValidator.enqueue(issue);
                if (autoRejected) {
                  this.autoRejectedIssues.push(autoRejected);
                }
              } else if (this.options.skipValidation) {
                // When skipping validation, we need to print the issue here
                // since enqueue() won't be called
                this.progress.issueDiscovered(issue.title, issue.file, issue.severity);
                this.rawIssuesForSkipMode.push(issue);
              }
            },
          },
          this.options.maxConcurrency
        );

        // Sum up tokens from custom agents
        const customAgentTokens = customAgentResults.reduce((sum, r) => sum + r.tokens_used, 0);
        tokensUsed += customAgentTokens;

        const totalCustomIssues = customAgentResults.reduce((sum, r) => sum + r.issues.length, 0);
        this.progress.success(
          `自定义 Agents 完成: ${totalCustomIssues} 个问题, ${customAgentTokens} tokens`
        );
      }

      // Phase 3: Wait for all validations to complete
      this.progress.phase(3, 4, '等待验证完成...');
      if (this.options.verbose) {
        console.log('[StreamingOrchestrator] Waiting for validations to complete...');
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Validation',
        message: '等待验证完成...',
      });

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
      this.sendStatus({
        type: 'phase',
        phase: 'Aggregation',
        message: '正在聚合结果...',
      });

      const aggregationResult = aggregate(validatedIssues, checklists);
      const aggregatedIssues = aggregationResult.issues;
      const aggregatedChecklist = aggregationResult.checklist;

      this.sendStatus({
        type: 'phase',
        phase: 'Report Generation',
        message: '正在生成报告...',
      });

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
        'zh'
      );

      if (this.options.verbose) {
        console.log(
          `[StreamingOrchestrator] Review completed in ${report.metadata.review_time_ms}ms`
        );
      }

      this.progress.complete(aggregatedIssues.length, report.metadata.review_time_ms);

      this.sendStatus({
        type: 'complete',
        message: `审查完成! 发现 ${aggregatedIssues.length} 个问题`,
        details: {
          issues: aggregatedIssues.length,
          time_ms: report.metadata.review_time_ms,
          tokens_used: tokensUsed,
        },
      });

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
          console.log(`[StreamingOrchestrator] Removing worktree: ${worktreeInfo.worktreePath}`);
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
          console.error('[StreamingOrchestrator] Failed to clean up worktree:', cleanupError);
        }
      }

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
      },
      diffFiles,
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

    // Create MCP server with report_issue tool
    const mcpServer = this.createReportIssueMcpServer();

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
          reviewRepoPath
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
   */
  private createReportIssueMcpServer() {
    const validator = this.streamingValidator;
    const deduplicator = this.realtimeDeduplicator;
    const verbose = this.options.verbose;
    const skipValidation = this.options.skipValidation;

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
    reviewRepoPath: string
  ): Promise<{ tokensUsed: number; checklists: ChecklistItem[] }> {
    if (this.options.verbose) {
      console.log(`[StreamingOrchestrator] Starting agent: ${agentType}`);
    }

    this.sendStatus({
      type: 'agent',
      agent: agentType,
      message: `${agentType} 开始分析...`,
      details: { status: 'running' },
    });

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

    try {
      const queryStream = query({
        prompt: fullPrompt,
        options: {
          cwd: reviewRepoPath,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns: 30, // More turns since we're making tool calls
          model: DEFAULT_AGENT_MODEL,
          settingSources: ['project'], // Load CLAUDE.md from repo
          mcpServers: {
            'code-review-tools': mcpServer,
          },
        },
      });

      // Consume the stream
      for await (const message of queryStream) {
        if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;
          if (resultMessage.subtype === 'success') {
            tokensUsed = resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;
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

    if (this.options.verbose) {
      console.log(`[StreamingOrchestrator] Agent ${agentType} completed`);
    }

    this.sendStatus({
      type: 'agent',
      agent: agentType,
      message: `${agentType} 完成`,
      details: { status: 'completed' },
    });

    // TODO: Parse checklist from agent output if needed
    return {
      tokensUsed,
      checklists: [],
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
 * Create a streaming review orchestrator instance
 */
export function createStreamingOrchestrator(
  options?: OrchestratorOptions
): StreamingReviewOrchestrator {
  return new StreamingReviewOrchestrator(options);
}

/**
 * Convenience function to run a streaming review
 */
export async function streamingReview(input: OrchestratorInput): Promise<ReviewReport> {
  const orchestrator = createStreamingOrchestrator(input.options);
  return orchestrator.review(input);
}
