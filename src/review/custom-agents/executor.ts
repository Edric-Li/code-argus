/**
 * Custom Agent Executor
 *
 * Executes custom agents using Claude Agent SDK with MCP tools for issue reporting.
 */

import {
  query,
  createSdkMcpServer,
  tool,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { LoadedCustomAgent, CustomAgentResult, CustomAgentIssue } from './types.js';
import type { RawIssue, IssueCategory, Severity } from '../types.js';
import { DEFAULT_AGENT_MODEL } from '../constants.js';
import { CUSTOM_AGENT_DEFAULTS } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for executing custom agents
 */
export interface CustomAgentExecutorOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Repository path for agent execution */
  repoPath: string;
  /** Diff content to review */
  diffContent: string;
  /** File analyses summary */
  fileAnalysesSummary?: string;
  /** Project standards text */
  standardsText?: string;
  /** Max turns for agent execution */
  maxTurns?: number;
}

/**
 * Callback interface for custom agent execution
 */
export interface CustomAgentExecutorCallbacks {
  /** Called when an issue is discovered */
  onIssueDiscovered?: (issue: RawIssue) => void;
  /** Called when agent starts */
  onAgentStart?: (agent: LoadedCustomAgent) => void;
  /** Called when agent completes */
  onAgentComplete?: (agent: LoadedCustomAgent, result: CustomAgentResult) => void;
  /** Called when agent fails */
  onAgentError?: (agent: LoadedCustomAgent, error: Error) => void;
}

// ============================================================================
// System Prompt Builder
// ============================================================================

/**
 * Build system prompt for custom agent
 */
function buildCustomAgentSystemPrompt(agent: LoadedCustomAgent): string {
  const category = agent.output?.category || CUSTOM_AGENT_DEFAULTS.output.category;

  return `# ${agent.name}

${agent.description}

## 你的角色

你是一个专业的代码审查 Agent。你的任务是根据以下指南审查代码变更并报告发现的问题。

## 审查指南

${agent.prompt}

## 输出要求

1. 仔细阅读代码变更（diff）
2. 根据审查指南识别问题
3. 对于每个发现的问题，使用 \`report_issue\` 工具进行报告
4. 所有文本（标题、描述、建议）必须使用中文
5. 默认问题类别为 \`${category}\`，但可根据实际情况调整
6. 置信度 (confidence) 应反映你对问题真实性的把握程度

## 重要提示

- 只报告真正的问题，避免误报
- 提供具体的文件路径和行号
- 描述问题时要具体，说明为什么这是一个问题
- 如果有修复建议，请提供

开始审查以下代码变更。`;
}

/**
 * Build user prompt for custom agent
 */
function buildCustomAgentUserPrompt(
  diffContent: string,
  fileAnalysesSummary?: string,
  standardsText?: string
): string {
  const sections: string[] = [];

  if (standardsText) {
    sections.push('## 项目标准\n');
    sections.push(standardsText);
    sections.push('');
  }

  if (fileAnalysesSummary) {
    sections.push('## 变更文件概述\n');
    sections.push(fileAnalysesSummary);
    sections.push('');
  }

  sections.push('## 代码变更 (Diff)\n');
  sections.push('```diff');
  sections.push(diffContent);
  sections.push('```');
  sections.push('');
  sections.push('请开始审查以上代码变更，并使用 report_issue 工具报告发现的问题。');

  return sections.join('\n');
}

// ============================================================================
// MCP Server Factory
// ============================================================================

/**
 * Create MCP server for custom agent issue reporting
 */
function createCustomAgentMcpServer(
  agent: LoadedCustomAgent,
  onIssue: (issue: RawIssue) => void,
  verbose?: boolean
) {
  const defaultCategory = agent.output?.category || CUSTOM_AGENT_DEFAULTS.output.category;
  const defaultSeverity = agent.output?.default_severity;

  return createSdkMcpServer({
    name: 'custom-agent-tools',
    version: '1.0.0',
    tools: [
      tool(
        'report_issue',
        `Report a discovered code issue. Call this for EACH issue found during review.
Write all text (title, description, suggestion) in Chinese.`,
        {
          file: z.string().describe('File path where the issue is located'),
          line_start: z.number().describe('Starting line number'),
          line_end: z.number().describe('Ending line number'),
          severity: z
            .enum(['critical', 'error', 'warning', 'suggestion'])
            .optional()
            .describe(`Issue severity level (default: ${defaultSeverity || 'warning'})`),
          category: z
            .enum(['security', 'logic', 'performance', 'style', 'maintainability'])
            .optional()
            .describe(`Issue category (default: ${defaultCategory})`),
          title: z.string().describe('Short title in Chinese'),
          description: z.string().describe('Detailed description in Chinese'),
          suggestion: z.string().optional().describe('Fix suggestion in Chinese'),
          code_snippet: z.string().optional().describe('Relevant code snippet'),
          confidence: z.number().min(0).max(1).describe('Confidence level (0-1)'),
        },
        async (args) => {
          if (verbose) {
            console.log(`[CustomAgent:${agent.name}] report_issue: ${args.title}`);
          }

          // Generate unique issue ID
          const issueId = `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

          const rawIssue: RawIssue = {
            id: issueId,
            file: args.file,
            line_start: args.line_start,
            line_end: args.line_end,
            severity: (args.severity || defaultSeverity || 'warning') as Severity,
            category: (args.category || defaultCategory) as IssueCategory,
            title: args.title,
            description: args.description,
            suggestion: args.suggestion,
            code_snippet: args.code_snippet,
            confidence: args.confidence,
            // Use custom agent ID as source_agent (will be handled specially in aggregation)
            source_agent: agent.id as RawIssue['source_agent'],
          };

          onIssue(rawIssue);

          return {
            content: [{ type: 'text' as const, text: `✓ 问题已记录 (ID: ${issueId})` }],
          };
        }
      ),
    ],
  });
}

// ============================================================================
// Executor
// ============================================================================

/**
 * Execute a single custom agent
 */
export async function executeCustomAgent(
  agent: LoadedCustomAgent,
  options: CustomAgentExecutorOptions,
  callbacks?: CustomAgentExecutorCallbacks
): Promise<CustomAgentResult> {
  const startTime = Date.now();
  const issues: CustomAgentIssue[] = [];

  if (options.verbose) {
    console.log(`[CustomAgentExecutor] Starting agent: ${agent.name}`);
  }

  callbacks?.onAgentStart?.(agent);

  // Collect issues from MCP tool calls
  const onIssue = (rawIssue: RawIssue) => {
    const customIssue: CustomAgentIssue = {
      id: rawIssue.id,
      file: rawIssue.file,
      line_start: rawIssue.line_start,
      line_end: rawIssue.line_end,
      category: rawIssue.category,
      severity: rawIssue.severity,
      title: rawIssue.title,
      description: rawIssue.description,
      suggestion: rawIssue.suggestion,
      confidence: rawIssue.confidence,
      source_agent: agent.id,
    };
    issues.push(customIssue);
    callbacks?.onIssueDiscovered?.(rawIssue);
  };

  // Create MCP server
  const mcpServer = createCustomAgentMcpServer(agent, onIssue, options.verbose);

  // Build prompts
  const systemPrompt = buildCustomAgentSystemPrompt(agent);
  const userPrompt = buildCustomAgentUserPrompt(
    options.diffContent,
    options.fileAnalysesSummary,
    options.standardsText
  );

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  let tokensUsed = 0;

  try {
    const queryStream = query({
      prompt: fullPrompt,
      options: {
        cwd: options.repoPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: options.maxTurns || 20,
        model: DEFAULT_AGENT_MODEL,
        mcpServers: {
          'custom-agent-tools': mcpServer,
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
          if (options.verbose) {
            console.error(
              `[CustomAgentExecutor] Agent ${agent.name} error:`,
              resultMessage.subtype
            );
          }
        }
      }
    }

    const result: CustomAgentResult = {
      agent_id: agent.id,
      agent_name: agent.name,
      issues,
      tokens_used: tokensUsed,
      execution_time_ms: Date.now() - startTime,
    };

    if (options.verbose) {
      console.log(
        `[CustomAgentExecutor] Agent ${agent.name} completed: ${issues.length} issues, ${tokensUsed} tokens`
      );
    }

    callbacks?.onAgentComplete?.(agent, result);

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (options.verbose) {
      console.error(`[CustomAgentExecutor] Agent ${agent.name} failed:`, error);
    }

    callbacks?.onAgentError?.(agent, error instanceof Error ? error : new Error(errorMessage));

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      issues,
      tokens_used: tokensUsed,
      execution_time_ms: Date.now() - startTime,
      error: errorMessage,
    };
  }
}

/**
 * Execute multiple custom agents in parallel
 */
export async function executeCustomAgents(
  agents: LoadedCustomAgent[],
  options: CustomAgentExecutorOptions,
  callbacks?: CustomAgentExecutorCallbacks,
  maxConcurrency: number = 4
): Promise<CustomAgentResult[]> {
  if (agents.length === 0) {
    return [];
  }

  if (options.verbose) {
    console.log(
      `[CustomAgentExecutor] Executing ${agents.length} agents (concurrency: ${maxConcurrency})`
    );
  }

  // Execute with concurrency limit
  const results: CustomAgentResult[] = [];
  const executing: Promise<void>[] = [];

  for (const agent of agents) {
    const promise = executeCustomAgent(agent, options, callbacks).then((result) => {
      results.push(result);
    });

    executing.push(promise);

    // If we've reached max concurrency, wait for one to complete
    if (executing.length >= maxConcurrency) {
      await Promise.race(executing);
      // Remove completed promises
      const completedIndices: number[] = [];
      for (let i = 0; i < executing.length; i++) {
        // Check if promise is settled by racing with an immediately resolved promise
        const isSettled = await Promise.race([
          executing[i]!.then(() => true).catch(() => true),
          Promise.resolve(false),
        ]);
        if (isSettled) {
          completedIndices.push(i);
        }
      }
      // Remove from end to beginning to preserve indices
      for (const index of completedIndices.reverse()) {
        executing.splice(index, 1);
      }
    }
  }

  // Wait for remaining
  await Promise.all(executing);

  return results;
}

/**
 * Convert custom agent issues to raw issues for validation
 */
export function customIssuesToRawIssues(results: CustomAgentResult[]): RawIssue[] {
  const rawIssues: RawIssue[] = [];

  for (const result of results) {
    for (const issue of result.issues) {
      // Custom agent ID needs to be converted to a valid AgentType for RawIssue
      // We'll use a special marker that can be handled in aggregation
      const rawIssue: RawIssue = {
        id: issue.id,
        file: issue.file,
        line_start: issue.line_start,
        line_end: issue.line_end,
        category: issue.category,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        suggestion: issue.suggestion,
        confidence: issue.confidence,
        // Store custom agent ID in source_agent field
        // The type assertion is needed because source_agent expects AgentType
        source_agent: issue.source_agent as RawIssue['source_agent'],
      };
      rawIssues.push(rawIssue);
    }
  }

  return rawIssues;
}
