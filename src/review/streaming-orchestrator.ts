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
import { parseDiff } from '../git/parser.js';
import { LocalDiffAnalyzer } from '../analyzer/local-analyzer.js';
import { StatusServer } from '../monitor/status-server.js';
import { createIssueCollector, type IssueCollector } from './issue-collector.js';
import { buildStreamingSystemPrompt, buildStreamingUserPrompt } from './prompts/streaming.js';
import { standardsToText } from './prompts/specialist.js';
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
};

/**
 * Streaming Review Orchestrator
 *
 * Uses MCP tools for real-time issue reporting with immediate deduplication and validation.
 */
export class StreamingReviewOrchestrator {
  private options: Required<OrchestratorOptions>;
  private statusServer?: StatusServer;
  private issueCollector?: IssueCollector;
  private progress: IProgressPrinter;

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

      const context = await this.buildContext(input);

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

      // Create issue collector with progress callbacks
      this.issueCollector = createIssueCollector({
        repoPath: reviewRepoPath,
        verbose: this.options.verbose,
        skipValidation: this.options.skipValidation,
        onIssueReceived: (issue) => {
          // Report issue as soon as it's discovered
          const severityIcon =
            issue.severity === 'critical'
              ? '🔴'
              : issue.severity === 'error'
                ? '🟠'
                : issue.severity === 'warning'
                  ? '🟡'
                  : '🔵';
          this.progress.info(
            `${severityIcon} [${issue.source_agent}] ${issue.title} (${issue.file}:${issue.line_start})`
          );
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
          // Get the reason for the validation result
          const reason =
            issue.validation_status === 'rejected'
              ? issue.rejection_reason || issue.grounding_evidence.reasoning
              : issue.grounding_evidence.reasoning;

          // Display with full reason (no truncation)
          const statusIcon =
            issue.validation_status === 'confirmed'
              ? '✓'
              : issue.validation_status === 'rejected'
                ? '✗'
                : '?';

          // Output validation result with full reason
          this.progress.info(
            `  └─ 验证: ${statusIcon} ${issue.validation_status}${reason ? ` | ${reason}` : ''}`
          );

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
        onStatusUpdate: (message) => {
          if (this.options.verbose) {
            console.log(`[IssueCollector] ${message}`);
          }
        },
      });

      // Phase 2: Run specialist agents with streaming issue reporting
      this.progress.phase(2, 4, `运行 ${this.options.agents.length} 个 Agents...`);
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
        reviewRepoPath
      );
      tokensUsed += agentTokens;

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

      await this.issueCollector.waitForValidations();

      const validatedIssues = this.issueCollector.getValidatedIssues();
      const collectorStats = this.issueCollector.getStats();
      tokensUsed += collectorStats.tokensUsed;
      this.progress.success(`验证完成: ${validatedIssues.length} 个有效问题`);

      if (this.options.verbose) {
        console.log(`[StreamingOrchestrator] Total issues: ${collectorStats.totalReported}`);
        console.log(`[StreamingOrchestrator] Validated: ${collectorStats.validated}`);
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
        agents_used: this.options.agents,
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
  private async buildContext(input: OrchestratorInput): Promise<ReviewContext> {
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
      repoPath,
      diff: diffResult,
      fileAnalyses: analysisResult.changes,
      standards,
    };
  }

  /**
   * Run specialist agents with streaming issue reporting via MCP
   */
  private async runAgentsWithStreaming(
    context: ReviewContext,
    reviewRepoPath: string
  ): Promise<{ checklists: ChecklistItem[]; tokens: number }> {
    const standardsText = standardsToText(context.standards);
    let totalTokens = 0;
    const allChecklists: ChecklistItem[] = [];

    // Create MCP server with report_issue tool
    const mcpServer = this.createReportIssueMcpServer();

    // Show agents starting
    for (const agentType of this.options.agents) {
      this.progress.agent(agentType, 'running');
    }

    // Run all agents in parallel with timing
    if (this.options.verbose) {
      console.log(
        `[StreamingOrchestrator] Running ${this.options.agents.length} agents in parallel...`
      );
    }

    const agentPromises = this.options.agents.map(async (agentType) => {
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

        // Flush any buffered issues for this agent (for batch-on-agent-complete strategy)
        await this.issueCollector!.flushAgentIssues(agentType as AgentType);

        return { agentType, result, elapsed, success: true as const };
      } catch (error) {
        const elapsed = Date.now() - startTime;

        // Still flush buffered issues even on error
        await this.issueCollector!.flushAgentIssues(agentType as AgentType);

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
    const collector = this.issueCollector!;
    const verbose = this.options.verbose;

    // We need to track which agent is calling, so we'll create per-agent servers
    // For now, use a simpler approach with a shared server
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

              const result = await collector.reportIssue(
                {
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
                },
                agentType
              );

              const responseText =
                result.status === 'accepted'
                  ? `✓ 问题已接收 (ID: ${result.issue_id})\n正在后台验证...`
                  : `✗ 报告失败: ${result.message}`;

              return {
                content: [{ type: 'text' as const, text: responseText }],
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

    // Build prompts
    const systemPrompt = buildStreamingSystemPrompt(agentType);
    const userPrompt = buildStreamingUserPrompt(agentType, {
      diff: context.diff.diff,
      fileAnalyses: context.fileAnalyses
        .map((f) => `- ${f.file_path}: ${f.semantic_hints?.summary || 'No summary'}`)
        .join('\n'),
      standardsText,
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
