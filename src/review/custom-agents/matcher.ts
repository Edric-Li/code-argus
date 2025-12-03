/**
 * Custom Agent Matcher
 *
 * Determines which custom agents should be triggered based on diff content.
 * Supports rule-based matching, LLM-based matching, and hybrid approaches.
 */

import Anthropic from '@anthropic-ai/sdk';
import { minimatch } from 'minimatch';
import type { DiffFile } from '../../git/parser.js';
import type { ChangeAnalysis } from '../../analyzer/types.js';
import type {
  LoadedCustomAgent,
  TriggerContext,
  TriggerResult,
  FileStatus,
  RuleTrigger,
} from './types.js';
import { CUSTOM_AGENT_DEFAULTS } from './types.js';
import { DEFAULT_AGENT_MODEL } from '../constants.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for matching custom agents
 */
export interface CustomAgentMatcherOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Disable LLM-based matching (rule-based only) */
  disableLLM?: boolean;
  /** Raw diff content for content pattern matching */
  diffContent?: string;
}

/**
 * Result of matching custom agents
 */
export interface CustomAgentMatchResult {
  /** Agents that should be triggered */
  triggeredAgents: {
    agent: LoadedCustomAgent;
    result: TriggerResult;
  }[];
  /** Agents that were skipped */
  skippedAgents: {
    agent: LoadedCustomAgent;
    reason: string;
  }[];
  /** Whether LLM was used for any decision */
  usedLLM: boolean;
}

// ============================================================================
// Trigger Context Builder
// ============================================================================

/**
 * Build trigger context from diff files and analysis results
 */
export function buildTriggerContext(
  diffFiles: DiffFile[],
  _fileAnalyses: ChangeAnalysis[],
  diffContent?: string
): TriggerContext {
  // Map file type to status
  const typeToStatus: Record<string, FileStatus> = {
    add: 'added',
    delete: 'deleted',
    modify: 'modified',
  };

  // Build file list
  const files = diffFiles.map((file) => {
    // Count additions and deletions from diff content
    const lines = file.content.split('\n');
    const additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

    return {
      path: file.path,
      status: typeToStatus[file.type] || 'modified',
      language: getLanguageFromPath(file.path),
      additions,
      deletions,
    };
  });

  // Build changed symbols from diff files
  // Note: detailed symbol extraction is not available from local analyzer
  const changed_symbols = diffFiles.map((file) => ({
    file: file.path,
    functions: [] as string[],
    classes: [] as string[],
    interfaces: [] as string[],
    exports: [] as string[],
  }));

  // Calculate stats
  const stats = {
    total_files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };

  // Create diff summary for LLM context (truncate if too long)
  const maxDiffLength = 5000;
  let diff_summary = diffContent || '';
  if (diff_summary.length > maxDiffLength) {
    diff_summary = diff_summary.substring(0, maxDiffLength) + '\n\n... (truncated)';
  }

  return {
    files,
    changed_symbols,
    stats,
    diff_summary: diff_summary || undefined,
  };
}

/**
 * Get programming language from file path
 */
function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    java: 'java',
    kt: 'kotlin',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    swift: 'swift',
    scala: 'scala',
    vue: 'vue',
    svelte: 'svelte',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    sql: 'sql',
  };
  return languageMap[ext] || ext || 'unknown';
}

// ============================================================================
// Rule-based Matching
// ============================================================================

/**
 * Match files against glob patterns
 */
function matchGlobPatterns(filePaths: string[], patterns: string[]): string[] {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  const matched = new Set<string>();
  for (const pattern of patterns) {
    for (const path of filePaths) {
      if (minimatch(path, pattern, { matchBase: true })) {
        matched.add(path);
      }
    }
  }
  return Array.from(matched);
}

/**
 * Match diff content against regex patterns
 */
function matchContentPatterns(diffContent: string, patterns: string[]): string[] {
  if (!patterns || patterns.length === 0 || !diffContent) {
    return [];
  }

  const matched: string[] = [];
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, 'gm');
      if (regex.test(diffContent)) {
        matched.push(pattern);
      }
    } catch {
      // Skip invalid regex
    }
  }
  return matched;
}

/**
 * Evaluate rule-based triggers
 */
function evaluateRuleTrigger(
  triggers: RuleTrigger,
  context: TriggerContext,
  diffContent?: string
): TriggerResult {
  const matchMode = triggers.match_mode || CUSTOM_AGENT_DEFAULTS.triggers.match_mode;
  const minFiles = triggers.min_files || CUSTOM_AGENT_DEFAULTS.triggers.min_files;

  const conditions: { name: string; passed: boolean; detail?: string }[] = [];
  const matchedFiles: string[] = [];
  const matchedPatterns: string[] = [];

  const filePaths = context.files.map((f) => f.path);

  // Check file patterns
  if (triggers.files && triggers.files.length > 0) {
    const matched = matchGlobPatterns(filePaths, triggers.files);
    matchedFiles.push(...matched);
    conditions.push({
      name: 'files',
      passed: matched.length >= minFiles,
      detail: `匹配 ${matched.length} 个文件`,
    });
  }

  // Check exclude patterns
  if (triggers.exclude_files && triggers.exclude_files.length > 0) {
    const excluded = matchGlobPatterns(filePaths, triggers.exclude_files);
    // Remove excluded files from matched
    const excludedSet = new Set(excluded);
    const remaining = matchedFiles.filter((f) => !excludedSet.has(f));
    if (excluded.length > 0) {
      conditions.push({
        name: 'exclude_files',
        passed: remaining.length > 0,
        detail: `排除 ${excluded.length} 个文件`,
      });
    }
  }

  // Check content patterns
  if (triggers.content_patterns && triggers.content_patterns.length > 0) {
    const matched = matchContentPatterns(diffContent || '', triggers.content_patterns);
    matchedPatterns.push(...matched);
    conditions.push({
      name: 'content_patterns',
      passed: matched.length > 0,
      detail: `匹配 ${matched.length} 个内容模式`,
    });
  }

  // Check file status
  if (triggers.file_status && triggers.file_status.length > 0) {
    const statusSet = new Set(triggers.file_status);
    const matchedByStatus = context.files.filter((f) => statusSet.has(f.status));
    conditions.push({
      name: 'file_status',
      passed: matchedByStatus.length > 0,
      detail: `匹配 ${matchedByStatus.length} 个文件状态`,
    });
  }

  // Check min_changes
  if (triggers.min_changes !== undefined && triggers.min_changes > 0) {
    const totalChanges = context.stats.additions + context.stats.deletions;
    conditions.push({
      name: 'min_changes',
      passed: totalChanges >= triggers.min_changes,
      detail: `变更 ${totalChanges} 行 (最小 ${triggers.min_changes})`,
    });
  }

  // If no conditions were checked, treat as no match
  if (conditions.length === 0) {
    return {
      should_trigger: false,
      confidence: 1.0,
      reason: '无触发条件',
      method: 'rule',
    };
  }

  // Evaluate based on match mode
  const passedConditions = conditions.filter((c) => c.passed);
  let shouldTrigger: boolean;
  let confidence: number;

  if (matchMode === 'all') {
    shouldTrigger = passedConditions.length === conditions.length;
    confidence = passedConditions.length / conditions.length;
  } else {
    // 'any' mode
    shouldTrigger = passedConditions.length > 0;
    confidence = shouldTrigger ? Math.min(0.8 + passedConditions.length * 0.05, 1.0) : 0;
  }

  // Build reason string
  const reasonParts = conditions.map(
    (c) => `${c.name}: ${c.passed ? '✓' : '✗'}${c.detail ? ` (${c.detail})` : ''}`
  );

  return {
    should_trigger: shouldTrigger,
    confidence,
    reason: reasonParts.join(', '),
    method: 'rule',
    matched_files: matchedFiles.length > 0 ? matchedFiles : undefined,
    matched_patterns: matchedPatterns.length > 0 ? matchedPatterns : undefined,
  };
}

// ============================================================================
// LLM-based Matching
// ============================================================================

/**
 * Evaluate trigger using LLM
 */
async function evaluateLLMTrigger(
  agent: LoadedCustomAgent,
  context: TriggerContext
): Promise<TriggerResult> {
  const client = new Anthropic();

  // Build file summary
  const fileSummary = context.files
    .slice(0, 20)
    .map((f) => `- ${f.path} (${f.status}, ${f.language}, +${f.additions}/-${f.deletions})`)
    .join('\n');

  // Build symbol summary
  const symbolSummary = context.changed_symbols
    .filter((s) => s.functions.length > 0 || s.interfaces.length > 0)
    .slice(0, 10)
    .map((s) => {
      const parts: string[] = [`  ${s.file}:`];
      if (s.functions.length > 0) parts.push(`    函数: ${s.functions.join(', ')}`);
      if (s.interfaces.length > 0) parts.push(`    接口: ${s.interfaces.join(', ')}`);
      return parts.join('\n');
    })
    .join('\n');

  const prompt = `你是一个代码审查触发判断器。根据以下变更信息，判断是否应该触发自定义审查 Agent。

## Agent 信息
名称: ${agent.name}
描述: ${agent.description}

## 触发条件
${agent.trigger_prompt}

## 变更信息

### 文件列表 (共 ${context.stats.total_files} 个文件, +${context.stats.additions}/-${context.stats.deletions} 行)
${fileSummary}
${context.files.length > 20 ? `... 还有 ${context.files.length - 20} 个文件` : ''}

### 变更的符号
${symbolSummary || '无符号信息'}

${context.diff_summary ? `### Diff 摘要\n\`\`\`\n${context.diff_summary}\n\`\`\`` : ''}

## 输出要求
请判断这些变更是否符合 Agent 的触发条件，输出 JSON:
{
  "should_trigger": true/false,
  "confidence": 0.0-1.0,
  "reason": "判断理由"
}

只输出 JSON，不要其他内容。`;

  try {
    const response = await client.messages.create({
      model: DEFAULT_AGENT_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (!content || content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    // Parse JSON response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const result = JSON.parse(jsonMatch[0]) as {
      should_trigger: boolean;
      confidence: number;
      reason: string;
    };

    return {
      should_trigger: Boolean(result.should_trigger),
      confidence: Math.max(0, Math.min(1, result.confidence || 0.5)),
      reason: result.reason || 'LLM判断',
      method: 'llm',
    };
  } catch (error) {
    // On error, return uncertain result
    console.warn(`[CustomAgentMatcher] LLM trigger evaluation failed for ${agent.name}:`, error);
    return {
      should_trigger: false,
      confidence: 0,
      reason: `LLM评估失败: ${error instanceof Error ? error.message : String(error)}`,
      method: 'llm',
    };
  }
}

// ============================================================================
// Hybrid Matching
// ============================================================================

/**
 * Evaluate trigger using hybrid approach (rule + LLM)
 */
async function evaluateHybridTrigger(
  agent: LoadedCustomAgent,
  context: TriggerContext,
  diffContent?: string,
  disableLLM?: boolean
): Promise<TriggerResult> {
  const strategy = agent.trigger_strategy || CUSTOM_AGENT_DEFAULTS.trigger_strategy;
  const confidenceThreshold = strategy.rule_confidence_threshold || 0.8;

  // First, try rule-based evaluation
  let ruleResult: TriggerResult | null = null;
  if (agent.triggers) {
    ruleResult = evaluateRuleTrigger(agent.triggers, context, diffContent);
  }

  // If rule-based is confident enough and LLM is not forced, use rule result
  if (ruleResult && ruleResult.confidence >= confidenceThreshold && !strategy.always_use_llm) {
    return {
      ...ruleResult,
      method: 'hybrid',
      reason: `[规则] ${ruleResult.reason}`,
    };
  }

  // If LLM is disabled, use rule result or default to not triggering
  if (disableLLM) {
    if (ruleResult) {
      return {
        ...ruleResult,
        method: 'hybrid',
        reason: `[规则，置信度不足] ${ruleResult.reason}`,
      };
    }
    return {
      should_trigger: false,
      confidence: 0,
      reason: 'LLM已禁用且无规则匹配',
      method: 'hybrid',
    };
  }

  // Use LLM for final decision
  if (agent.trigger_prompt) {
    const llmResult = await evaluateLLMTrigger(agent, context);
    return {
      ...llmResult,
      method: 'hybrid',
      reason: ruleResult
        ? `[规则: ${ruleResult.should_trigger ? '✓' : '✗'}] [LLM] ${llmResult.reason}`
        : `[LLM] ${llmResult.reason}`,
    };
  }

  // No LLM prompt, use rule result
  if (ruleResult) {
    return {
      ...ruleResult,
      method: 'hybrid',
    };
  }

  return {
    should_trigger: false,
    confidence: 0,
    reason: '无可用的触发评估方式',
    method: 'hybrid',
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Match custom agents against diff content to determine which should run
 *
 * @param agents - Loaded custom agents to evaluate
 * @param diffFiles - Parsed diff files
 * @param fileAnalyses - File analysis results (for symbol extraction)
 * @param options - Matching options
 * @returns Match result with triggered and skipped agents
 *
 * @example
 * ```typescript
 * const result = await matchCustomAgents(
 *   loadedAgents,
 *   diffFiles,
 *   fileAnalyses,
 *   { verbose: true, diffContent: rawDiff }
 * );
 *
 * for (const { agent, result } of result.triggeredAgents) {
 *   console.log(`Triggering ${agent.name}: ${result.reason}`);
 * }
 * ```
 */
export async function matchCustomAgents(
  agents: LoadedCustomAgent[],
  diffFiles: DiffFile[],
  fileAnalyses: ChangeAnalysis[],
  options: CustomAgentMatcherOptions = {}
): Promise<CustomAgentMatchResult> {
  const { verbose = false, disableLLM = false, diffContent } = options;

  const result: CustomAgentMatchResult = {
    triggeredAgents: [],
    skippedAgents: [],
    usedLLM: false,
  };

  if (agents.length === 0 || diffFiles.length === 0) {
    return result;
  }

  // Build trigger context
  const context = buildTriggerContext(diffFiles, fileAnalyses, diffContent);

  if (verbose) {
    console.log(`[CustomAgentMatcher] Evaluating ${agents.length} custom agent(s)`);
    console.log(
      `[CustomAgentMatcher] Context: ${context.stats.total_files} files, +${context.stats.additions}/-${context.stats.deletions} lines`
    );
  }

  // Evaluate each agent
  for (const agent of agents) {
    const triggerMode = agent.trigger_mode || CUSTOM_AGENT_DEFAULTS.trigger_mode;

    if (verbose) {
      console.log(`[CustomAgentMatcher] Evaluating "${agent.name}" (mode: ${triggerMode})`);
    }

    let triggerResult: TriggerResult;

    switch (triggerMode) {
      case 'rule':
        if (agent.triggers) {
          triggerResult = evaluateRuleTrigger(agent.triggers, context, diffContent);
        } else {
          triggerResult = {
            should_trigger: false,
            confidence: 0,
            reason: '无规则配置',
            method: 'rule',
          };
        }
        break;

      case 'llm':
        if (disableLLM) {
          triggerResult = {
            should_trigger: false,
            confidence: 0,
            reason: 'LLM已禁用',
            method: 'llm',
          };
        } else if (agent.trigger_prompt) {
          triggerResult = await evaluateLLMTrigger(agent, context);
          result.usedLLM = true;
        } else {
          triggerResult = {
            should_trigger: false,
            confidence: 0,
            reason: '无LLM触发提示词',
            method: 'llm',
          };
        }
        break;

      case 'hybrid':
      default:
        triggerResult = await evaluateHybridTrigger(agent, context, diffContent, disableLLM);
        if (
          triggerResult.method === 'llm' ||
          (triggerResult.method === 'hybrid' && triggerResult.reason.includes('[LLM]'))
        ) {
          result.usedLLM = true;
        }
        break;
    }

    if (verbose) {
      console.log(
        `[CustomAgentMatcher]   Result: ${triggerResult.should_trigger ? '✓ TRIGGER' : '✗ SKIP'} ` +
          `(confidence: ${triggerResult.confidence.toFixed(2)}, method: ${triggerResult.method})`
      );
      console.log(`[CustomAgentMatcher]   Reason: ${triggerResult.reason}`);
    }

    if (triggerResult.should_trigger) {
      result.triggeredAgents.push({ agent, result: triggerResult });
    } else {
      result.skippedAgents.push({ agent, reason: triggerResult.reason });
    }
  }

  return result;
}

// buildTriggerContext is already exported above
