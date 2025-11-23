/**
 * Review Orchestrator
 *
 * Coordinates the multi-agent code review process using Claude Agent SDK.
 */

import { query, type AgentDefinition, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
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
import {
  buildBaseSystemPrompt,
  parseAgentResponse,
  AGENT_OUTPUT_JSON_SCHEMA,
} from './prompts/index.js';
import { buildSpecialistPrompt, standardsToText } from './prompts/specialist.js';
import { aggregate } from './aggregator.js';
import { calculateMetrics, generateReport } from './report.js';
import { getDiffWithOptions } from '../git/diff.js';
import { parseDiff } from '../git/parser.js';
import { DiffAnalyzer } from '../analyzer/diff-analyzer.js';
import { analyzeIntent } from '../intent/intent-analyzer.js';
import { getPRCommits } from '../git/commits.js';

/**
 * Default orchestrator options
 */
const DEFAULT_OPTIONS: Required<OrchestratorOptions> = {
  maxConcurrency: 4,
  verbose: false,
  agents: ['security-reviewer', 'logic-reviewer', 'style-reviewer', 'performance-reviewer'],
  skipValidation: false,
};

/**
 * Review Orchestrator
 *
 * Coordinates multiple specialized agents to perform comprehensive code review.
 */
export class ReviewOrchestrator {
  private options: Required<OrchestratorOptions>;

  constructor(options?: OrchestratorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Execute the complete review process
   */
  async review(input: OrchestratorInput): Promise<ReviewReport> {
    const startTime = Date.now();
    let tokensUsed = 0;

    // Phase 0: Build review context
    if (this.options.verbose) {
      console.log('[Orchestrator] Building review context...');
    }

    const context = await this.buildContext(input);

    // Phase 1: Run specialist agents in parallel
    if (this.options.verbose) {
      console.log('[Orchestrator] Running specialist agents...');
    }

    const agentResults = await this.runSpecialistAgents(context);
    tokensUsed += agentResults.reduce((sum, r) => sum + r.tokens_used, 0);

    // Collect all raw issues
    const rawIssues = agentResults.flatMap((r) => r.issues);
    const checklists = agentResults.flatMap((r) => r.checklist);

    if (this.options.verbose) {
      console.log(`[Orchestrator] Found ${rawIssues.length} potential issues`);
    }

    // Phase 2: Validate all issues (unless skipped)
    let validatedIssues: ValidatedIssue[];

    if (this.options.skipValidation) {
      // Convert raw issues to validated without actual validation
      validatedIssues = rawIssues.map((issue) => ({
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
      if (this.options.verbose) {
        console.log('[Orchestrator] Validating issues...');
      }

      const validationResult = await this.validateIssues(rawIssues, context);
      validatedIssues = validationResult.issues;
      tokensUsed += validationResult.tokens_used;
    }

    // Phase 3: Aggregate results
    if (this.options.verbose) {
      console.log('[Orchestrator] Aggregating results...');
    }

    const aggregationResult = aggregate(validatedIssues, checklists);
    const aggregatedIssues = aggregationResult.issues;
    const aggregatedChecklist = aggregationResult.checklist;

    if (this.options.verbose) {
      console.log(
        `[Orchestrator] Aggregation: ${aggregationResult.stats.duplicates_removed} duplicates removed`
      );
    }

    // Phase 4: Generate report
    const metrics = calculateMetrics(rawIssues, aggregatedIssues);
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
      metadata
    );

    if (this.options.verbose) {
      console.log(`[Orchestrator] Review completed in ${report.metadata.review_time_ms}ms`);
    }

    return report;
  }

  /**
   * Build the review context from input
   */
  private async buildContext(input: OrchestratorInput): Promise<ReviewContext> {
    const { sourceBranch, targetBranch, repoPath } = input;

    // Get diff
    const diffResult = getDiffWithOptions({
      sourceBranch,
      targetBranch,
      repoPath,
    });

    // Parse diff
    const diffFiles = parseDiff(diffResult.diff);

    // Analyze diff semantically
    const analyzer = new DiffAnalyzer();
    const analysisResult = await analyzer.analyze(diffFiles);

    // Get commits
    const commits = getPRCommits(repoPath, sourceBranch, targetBranch);

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
   * Run specialist agents in parallel using Claude Agent SDK
   */
  private async runSpecialistAgents(context: ReviewContext): Promise<AgentResult[]> {
    // Build specialist context
    const standardsText = standardsToText(context.standards);

    // Run all agents in parallel
    const agentPromises = this.options.agents.map((agentType) =>
      this.runSingleAgent(agentType as AgentType, context, standardsText)
    );

    const results = await Promise.allSettled(agentPromises);

    // Process results
    return results.map((result, index) => {
      const agentType = this.options.agents[index] as AgentType;

      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        if (this.options.verbose) {
          console.error(`[Orchestrator] Agent ${agentType} failed:`, result.reason);
        }
        return {
          agent: agentType,
          issues: [] as RawIssue[],
          checklist: [] as ChecklistItem[],
          tokens_used: 0,
        };
      }
    });
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

    // Build the prompt for this agent
    const userPrompt = buildSpecialistPrompt(agentType, {
      diff: context.diff.diff,
      intent: context.intent,
      fileAnalyses: context.fileAnalyses,
      standardsText,
    });

    // Build system prompt
    const systemPrompt = buildBaseSystemPrompt(agentType);

    // Define the agent
    const agentDefinitions: Record<string, AgentDefinition> = {
      [agentType]: {
        description: this.getAgentDescription(agentType),
        tools: ['Read', 'Grep', 'Glob'],
        prompt: systemPrompt,
        model: 'sonnet',
      },
    };

    let tokensUsed = 0;
    let resultText = '';

    // Run the agent using Claude Agent SDK
    const queryStream = query({
      prompt: userPrompt,
      options: {
        cwd: context.repoPath,
        agents: agentDefinitions,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: systemPrompt,
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        outputFormat: {
          type: 'json_schema',
          schema: AGENT_OUTPUT_JSON_SCHEMA,
        },
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

    return {
      agent: agentType,
      issues: parsed.issues,
      checklist: parsed.checklist,
      tokens_used: tokensUsed,
    };
  }

  /**
   * Get agent description for SDK
   */
  private getAgentDescription(agentType: AgentType): string {
    const descriptions: Record<AgentType, string> = {
      'security-reviewer': 'Security vulnerabilities and injection detection specialist',
      'logic-reviewer': 'Logic errors and bug detection specialist',
      'style-reviewer': 'Code style and consistency specialist',
      'performance-reviewer': 'Performance issues and optimization specialist',
      validator: 'Issue validation and grounding specialist',
    };
    return descriptions[agentType] || 'Code review specialist';
  }

  /**
   * Validate issues using the validator agent
   */
  private async validateIssues(
    issues: RawIssue[],
    context: ReviewContext
  ): Promise<{ issues: ValidatedIssue[]; tokens_used: number }> {
    if (issues.length === 0) {
      return { issues: [], tokens_used: 0 };
    }

    if (this.options.verbose) {
      console.log(`[Orchestrator] Validating ${issues.length} issues with validator agent`);
    }

    // Build validator prompt
    const { buildValidatorPrompt } = await import('./prompts/specialist.js');
    const userPrompt = buildValidatorPrompt({
      issues: issues.map((i) => ({
        id: i.id,
        file: i.file,
        line_start: i.line_start,
        line_end: i.line_end,
        category: i.category,
        severity: i.severity,
        title: i.title,
        description: i.description,
        code_snippet: i.code_snippet,
        confidence: i.confidence,
      })),
      repoPath: context.repoPath,
    });

    // Build system prompt for validator
    const systemPrompt = `You are an expert code reviewer specializing in validating issues discovered by other agents.
Your job is to verify each issue by reading the actual code and grounding claims in evidence.

For each issue:
1. Read the actual file using the Read tool
2. Verify the issue exists at the reported location
3. Check for mitigating code that might handle the issue
4. Make a decision: confirm, reject, or uncertain

Output your results as JSON with the validated_issues array.`;

    // Define validator agent
    const agentDefinitions: Record<string, AgentDefinition> = {
      validator: {
        description: 'Issue validation and grounding specialist',
        tools: ['Read', 'Grep', 'Glob'],
        prompt: systemPrompt,
        model: 'sonnet',
      },
    };

    let tokensUsed = 0;
    let resultText = '';

    // Run validator using Claude Agent SDK
    const queryStream = query({
      prompt: userPrompt,
      options: {
        cwd: context.repoPath,
        agents: agentDefinitions,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: systemPrompt,
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 30, // Allow more turns for validation
      },
    });

    // Consume the stream and collect the result
    for await (const message of queryStream) {
      if (message.type === 'result') {
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === 'success') {
          resultText = resultMessage.result;
          tokensUsed = resultMessage.usage.input_tokens + resultMessage.usage.output_tokens;
        } else {
          if (this.options.verbose) {
            console.error('[Orchestrator] Validator agent error:', resultMessage.subtype);
          }
        }
      }
    }

    // Parse validation results
    const validatedIssues = this.parseValidationResult(resultText, issues);

    if (this.options.verbose) {
      const confirmed = validatedIssues.filter((i) => i.validation_status === 'confirmed').length;
      const rejected = validatedIssues.filter((i) => i.validation_status === 'rejected').length;
      console.log(
        `[Orchestrator] Validation complete: ${confirmed} confirmed, ${rejected} rejected`
      );
    }

    return { issues: validatedIssues, tokens_used: tokensUsed };
  }

  /**
   * Parse validation result from validator agent
   */
  private parseValidationResult(resultText: string, originalIssues: RawIssue[]): ValidatedIssue[] {
    // Create a map of original issues by ID
    const issueMap = new Map<string, RawIssue>();
    for (const issue of originalIssues) {
      issueMap.set(issue.id, issue);
    }

    // Try to extract JSON from the result
    const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch?.[1] ?? resultText;

    try {
      const parsed = JSON.parse(jsonStr.trim()) as {
        validated_issues?: Array<{
          original_id: string;
          validation_status: 'confirmed' | 'rejected' | 'uncertain';
          final_confidence: number;
          grounding_evidence: {
            checked_files: string[];
            checked_symbols: string[];
            related_context: string;
            reasoning: string;
          };
        }>;
      };

      if (!parsed.validated_issues) {
        // Return issues as pending if parsing fails
        return this.markIssuesAsPending(originalIssues);
      }

      // Map validation results back to issues
      const validatedIssues: ValidatedIssue[] = [];

      for (const validation of parsed.validated_issues) {
        const original = issueMap.get(validation.original_id);
        if (original) {
          // Convert string symbols to SymbolLookup objects if needed
          const checkedSymbols = Array.isArray(validation.grounding_evidence.checked_symbols)
            ? validation.grounding_evidence.checked_symbols.map((sym) =>
                typeof sym === 'string'
                  ? { name: sym, type: 'reference' as const, locations: [] }
                  : sym
              )
            : [];

          validatedIssues.push({
            ...original,
            validation_status: validation.validation_status,
            grounding_evidence: {
              ...validation.grounding_evidence,
              checked_symbols: checkedSymbols,
            },
            final_confidence: validation.final_confidence,
          });
          issueMap.delete(validation.original_id);
        }
      }

      // Add any issues that weren't validated as pending
      for (const remaining of issueMap.values()) {
        validatedIssues.push({
          ...remaining,
          validation_status: 'pending',
          grounding_evidence: {
            checked_files: [],
            checked_symbols: [],
            related_context: '',
            reasoning: 'Issue was not validated',
          },
          final_confidence: remaining.confidence,
        });
      }

      return validatedIssues;
    } catch {
      console.error('[Orchestrator] Failed to parse validation result');
      return this.markIssuesAsPending(originalIssues);
    }
  }

  /**
   * Mark all issues as pending (fallback when validation fails)
   */
  private markIssuesAsPending(issues: RawIssue[]): ValidatedIssue[] {
    return issues.map((issue) => ({
      ...issue,
      validation_status: 'pending' as const,
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: '',
        reasoning: 'Validation failed or skipped',
      },
      final_confidence: issue.confidence,
    }));
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
