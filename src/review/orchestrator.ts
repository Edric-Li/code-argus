/**
 * Review Orchestrator
 *
 * Coordinates the multi-agent code review process using Claude Agent SDK.
 */

import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
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
import { getDiffWithOptions, fetchRemote } from '../git/diff.js';
import { parseDiff } from '../git/parser.js';
import { DiffAnalyzer } from '../analyzer/diff-analyzer.js';
import { analyzeIntent } from '../intent/intent-analyzer.js';
import { getPRCommits } from '../git/commits.js';
import { StatusServer } from '../monitor/status-server.js';
import { createValidator } from './validator.js';
import { createDeduplicator } from './deduplicator.js';

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
};

/**
 * Review Orchestrator
 *
 * Coordinates multiple specialized agents to perform comprehensive code review.
 */
export class ReviewOrchestrator {
  private options: Required<OrchestratorOptions>;
  private statusServer?: StatusServer;

  constructor(options?: OrchestratorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Execute the complete review process
   */
  async review(input: OrchestratorInput): Promise<ReviewReport> {
    const startTime = Date.now();
    let tokensUsed = 0;

    // Start status server if monitoring is enabled
    if (this.options.monitor) {
      this.statusServer = new StatusServer(this.options.monitorPort);
      await this.statusServer.start();
    }

    try {
      // Phase 0: Build review context
      if (this.options.verbose) {
        console.log('[Orchestrator] Building review context...');
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Context Building',
        message: '正在构建审查上下文...',
      });

      const context = await this.buildContext(input);

      // Phase 1: Run specialist agents with streaming validation and deduplication
      if (this.options.verbose) {
        console.log('[Orchestrator] Running specialist agents with streaming validation...');
      }
      this.sendStatus({
        type: 'phase',
        phase: 'Agent Execution & Validation',
        message: '正在运行专业审查 Agents 并实时验证...',
      });

      const { validatedIssues, checklists, tokens_used } =
        await this.runAgentsWithStreamingValidation(context);
      tokensUsed += tokens_used;

      if (this.options.verbose) {
        console.log(`[Orchestrator] Total validated issues: ${validatedIssues.length}`);
      }

      // Phase 2: Aggregate results
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

      if (this.options.verbose) {
        console.log(
          `[Orchestrator] Aggregation: filtered to ${aggregationResult.stats.after_filter} issues`
        );
      }

      // Phase 4: Generate report
      this.sendStatus({
        type: 'phase',
        phase: 'Report Generation',
        message: '正在生成报告...',
      });

      const metrics = calculateMetrics(validatedIssues, aggregatedIssues);
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
        'zh' // Language will be set when formatting the report
      );

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

      return report;
    } catch (error) {
      this.sendStatus({
        type: 'error',
        message: `审查失败: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    } finally {
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
   */
  private async buildContext(input: OrchestratorInput): Promise<ReviewContext> {
    const { sourceBranch, targetBranch, repoPath } = input;
    const remote = 'origin';

    // Fetch remote refs once at the beginning
    if (this.options.verbose) {
      console.log('[Orchestrator] Fetching remote refs...');
    }
    fetchRemote(repoPath, remote);

    // Get diff (skip fetch since we already did it)
    const diffResult = getDiffWithOptions({
      sourceBranch,
      targetBranch,
      repoPath,
      skipFetch: true,
    });

    // Parse diff
    const diffFiles = parseDiff(diffResult.diff);

    // Analyze diff semantically
    const analyzer = new DiffAnalyzer();
    const analysisResult = await analyzer.analyze(diffFiles);

    // Get commits (skip fetch since we already did it)
    const commits = getPRCommits(repoPath, sourceBranch, targetBranch, remote, { skipFetch: true });

    // Analyze intent
    const intent = await analyzeIntent(commits, analysisResult);

    // Extract standards
    const standards = await createStandards(repoPath);

    return {
      repoPath,
      diff: diffResult,
      intent,
      fileAnalyses: analysisResult.changes,
      standards,
    };
  }

  /**
   * Run specialist agents with streaming validation and deduplication
   *
   * Flow:
   * 1. Run all agents in parallel
   * 2. For each agent that completes:
   *    a. Validate its issues (parallel validation with concurrency limit)
   *    b. Deduplicate against already validated issues
   * 3. After all agents complete, do final global deduplication
   */
  private async runAgentsWithStreamingValidation(context: ReviewContext): Promise<{
    validatedIssues: ValidatedIssue[];
    checklists: ChecklistItem[];
    tokens_used: number;
  }> {
    const standardsText = standardsToText(context.standards);
    let totalTokens = 0;
    const allValidatedIssues: ValidatedIssue[] = [];
    const allChecklists: ChecklistItem[] = [];

    // Create validator and deduplicator
    const validator = createValidator({
      repoPath: context.repoPath,
      verbose: this.options.verbose,
    });
    const deduplicator = createDeduplicator({
      verbose: this.options.verbose,
    });

    // Run all agents in parallel
    const agentPromises = this.options.agents.map((agentType) =>
      this.runSingleAgent(agentType as AgentType, context, standardsText)
    );

    const results = await Promise.allSettled(agentPromises);

    // Process each agent's results sequentially (to maintain order and allow deduplication)
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;

      const agentType = this.options.agents[i] as AgentType;

      let agentResult: AgentResult;
      if (result.status === 'fulfilled') {
        agentResult = result.value;
      } else {
        if (this.options.verbose) {
          console.error(`[Orchestrator] Agent ${agentType} failed:`, result.reason);
        }
        agentResult = {
          agent: agentType,
          issues: [],
          checklist: [],
          tokens_used: 0,
        };
      }

      totalTokens += agentResult.tokens_used;
      allChecklists.push(...agentResult.checklist);

      // Skip if no issues found
      if (agentResult.issues.length === 0) {
        if (this.options.verbose) {
          console.log(`[Orchestrator] Agent ${agentType}: no issues found`);
        }
        continue;
      }

      if (this.options.verbose) {
        console.log(
          `[Orchestrator] Agent ${agentType}: ${agentResult.issues.length} issues, starting validation...`
        );
      }

      // Step 1: Validate issues from this agent (skip if validation disabled)
      let validatedForThisAgent: ValidatedIssue[];

      if (this.options.skipValidation) {
        validatedForThisAgent = agentResult.issues.map((issue) => ({
          ...issue,
          validation_status: 'pending' as const,
          grounding_evidence: {
            checked_files: [],
            checked_symbols: [],
            related_context: '',
            reasoning: 'Validation skipped',
          },
          final_confidence: issue.confidence,
        }));
      } else {
        this.sendStatus({
          type: 'progress',
          message: `验证 ${agentType} 发现的 ${agentResult.issues.length} 个问题...`,
          details: { agent: agentType, issues: agentResult.issues.length },
        });

        const validationResult = await validator.validateBatch(agentResult.issues, 3);
        validatedForThisAgent = validationResult.issues;
        totalTokens += validationResult.tokensUsed;

        if (this.options.verbose) {
          const confirmed = validatedForThisAgent.filter(
            (i) => i.validation_status === 'confirmed'
          ).length;
          console.log(
            `[Orchestrator] Agent ${agentType}: validated ${validatedForThisAgent.length} issues, ${confirmed} confirmed`
          );
        }
      }

      // Step 2: Deduplicate against already validated issues
      if (allValidatedIssues.length > 0) {
        if (this.options.verbose) {
          console.log(
            `[Orchestrator] Deduplicating ${validatedForThisAgent.length} new issues against ${allValidatedIssues.length} existing issues...`
          );
        }

        this.sendStatus({
          type: 'progress',
          message: `去重 ${agentType} 的问题...`,
          details: { agent: agentType },
        });

        // Combine and deduplicate
        const combined = [...allValidatedIssues, ...validatedForThisAgent];
        const deduplicationResult = await deduplicator.deduplicate(combined);
        totalTokens += deduplicationResult.tokensUsed;

        // Update the main list with deduplicated results
        allValidatedIssues.length = 0;
        allValidatedIssues.push(...deduplicationResult.uniqueIssues);

        if (this.options.verbose) {
          console.log(
            `[Orchestrator] After deduplication: ${allValidatedIssues.length} unique issues (removed ${deduplicationResult.duplicateGroups.length} duplicate groups)`
          );
        }
      } else {
        // First agent, just add all validated issues
        allValidatedIssues.push(...validatedForThisAgent);
      }

      this.sendStatus({
        type: 'progress',
        message: `${agentType} 完成，当前共 ${allValidatedIssues.length} 个唯一问题`,
        details: { agent: agentType, total_issues: allValidatedIssues.length },
      });
    }

    // Step 3: Final global deduplication
    if (allValidatedIssues.length > 1) {
      if (this.options.verbose) {
        console.log('[Orchestrator] Performing final global deduplication...');
      }

      this.sendStatus({
        type: 'phase',
        phase: 'Final Deduplication',
        message: '正在进行最终去重...',
      });

      const finalDedup = await deduplicator.deduplicate(allValidatedIssues);
      totalTokens += finalDedup.tokensUsed;

      if (this.options.verbose) {
        console.log(
          `[Orchestrator] Final deduplication: ${finalDedup.uniqueIssues.length} unique issues (removed ${finalDedup.duplicateGroups.length} duplicate groups)`
        );
      }

      return {
        validatedIssues: finalDedup.uniqueIssues,
        checklists: allChecklists,
        tokens_used: totalTokens,
      };
    }

    return {
      validatedIssues: allValidatedIssues,
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
      intent: context.intent,
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
        maxTurns: 20,
      },
    });

    // Consume the stream and collect the result
    for await (const message of queryStream) {
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
          if (this.options.verbose) {
            console.error(`[Orchestrator] Agent ${agentType} error:`, resultMessage.subtype);
          }
        }
      }
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
