/**
 * Agent Selector
 *
 * Intelligently selects which reviewer agents to run based on diff content.
 * Uses a hybrid approach: rule-based fast filtering + LLM for edge cases.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { DiffFile, FileCategory } from '../git/parser.js';
import type { AgentType } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * File characteristics for agent selection
 */
export interface FileCharacteristics {
  /** File extensions present */
  extensions: Set<string>;
  /** File categories present */
  categories: Set<FileCategory>;
  /** Has source code files (ts, js, py, etc.) */
  hasSourceCode: boolean;
  /** Has only style files (css, scss, less) */
  hasOnlyStyles: boolean;
  /** Has security-sensitive files */
  hasSecuritySensitive: boolean;
  /** Has test files */
  hasTests: boolean;
  /** Has config files */
  hasConfig: boolean;
  /** Has documentation files */
  hasDocs: boolean;
  /** Has database/SQL files */
  hasDatabase: boolean;
  /** Has HTML/template files */
  hasTemplates: boolean;
  /** Total number of files */
  totalFiles: number;
}

/**
 * Agent selection result
 */
export interface AgentSelectionResult {
  /** Selected agents to run */
  agents: AgentType[];
  /** Reasons for selection/exclusion */
  reasons: Record<string, string>;
  /** Whether LLM was used for decision */
  usedLLM: boolean;
  /** Confidence level (rule-based: 1.0, LLM: varies) */
  confidence: number;
}

/**
 * Options for agent selection
 */
export interface AgentSelectorOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Force specific agents (bypass selection) */
  forceAgents?: AgentType[];
  /** Disable LLM fallback (rule-based only) */
  disableLLM?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Source code extensions */
const SOURCE_CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyw',
  'java',
  'kt',
  'scala',
  'go',
  'rs',
  'rb',
  'php',
  'c',
  'cpp',
  'cc',
  'h',
  'hpp',
  'cs',
  'swift',
  'vue',
  'svelte',
]);

/** Style file extensions */
const STYLE_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'styl', 'stylus']);

/** Test file patterns */
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.go$/,
  /_test\.py$/,
  /test_.*\.py$/,
  /Test\.java$/,
  /\.test\.rb$/,
  /__tests__\//,
  /tests?\//i,
];

/** Security-sensitive file patterns */
const SECURITY_SENSITIVE_PATTERNS = [
  /auth/i,
  /login/i,
  /password/i,
  /credential/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /\.env/,
  /config.*\.(json|ya?ml|toml)$/i,
  /permission/i,
  /access/i,
  /rbac/i,
  /oauth/i,
  /jwt/i,
  /crypto/i,
  /encrypt/i,
  /decrypt/i,
  /sanitize/i,
  /escape/i,
  /validate/i,
  /security/i,
];

/** Database/SQL file extensions and patterns */
const DATABASE_PATTERNS = [
  /\.sql$/i,
  /migration/i,
  /schema/i,
  /prisma/i,
  /drizzle/i,
  /sequelize/i,
  /typeorm/i,
  /knex/i,
  /\.prisma$/,
];

/** Documentation extensions */
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'rst', 'txt', 'adoc']);

/** HTML/Template extensions */
const TEMPLATE_EXTENSIONS = new Set([
  'html',
  'htm',
  'ejs',
  'hbs',
  'pug',
  'jade',
  'mustache',
  'njk',
]);

/** Config file patterns */
const CONFIG_PATTERNS = [
  /package\.json$/,
  /tsconfig.*\.json$/,
  /\.eslintrc/,
  /\.prettierrc/,
  /vite\.config/,
  /webpack\.config/,
  /rollup\.config/,
  /jest\.config/,
  /vitest\.config/,
  /\.babelrc/,
  /babel\.config/,
  /\.env/,
  /docker-compose/,
  /Dockerfile/,
  /\.ya?ml$/,
  /\.toml$/,
];

// ============================================================================
// Core Implementation
// ============================================================================

/**
 * Analyze diff files to extract characteristics
 */
export function analyzeFileCharacteristics(diffFiles: DiffFile[]): FileCharacteristics {
  const extensions = new Set<string>();
  const categories = new Set<FileCategory>();

  let hasSourceCode = false;
  let styleCount = 0;
  let hasSecuritySensitive = false;
  let hasTests = false;
  let hasConfig = false;
  let hasDocs = false;
  let hasDatabase = false;
  let hasTemplates = false;

  for (const file of diffFiles) {
    const path = file.path.toLowerCase();
    const ext = path.split('.').pop() || '';

    extensions.add(ext);
    categories.add(file.category);

    // Check source code
    if (SOURCE_CODE_EXTENSIONS.has(ext)) {
      hasSourceCode = true;
    }

    // Check style files
    if (STYLE_EXTENSIONS.has(ext)) {
      styleCount++;
    }

    // Check test files
    if (TEST_PATTERNS.some((p) => p.test(path))) {
      hasTests = true;
    }

    // Check security-sensitive
    if (SECURITY_SENSITIVE_PATTERNS.some((p) => p.test(path))) {
      hasSecuritySensitive = true;
    }

    // Check database
    if (DATABASE_PATTERNS.some((p) => p.test(path))) {
      hasDatabase = true;
    }

    // Check docs
    if (DOC_EXTENSIONS.has(ext)) {
      hasDocs = true;
    }

    // Check templates
    if (TEMPLATE_EXTENSIONS.has(ext)) {
      hasTemplates = true;
    }

    // Check config
    if (CONFIG_PATTERNS.some((p) => p.test(path))) {
      hasConfig = true;
    }
  }

  return {
    extensions,
    categories,
    hasSourceCode,
    hasOnlyStyles: styleCount === diffFiles.length && diffFiles.length > 0,
    hasSecuritySensitive,
    hasTests,
    hasConfig,
    hasDocs,
    hasDatabase,
    hasTemplates,
    totalFiles: diffFiles.length,
  };
}

/**
 * Rule-based agent selection
 *
 * Returns selected agents and confidence level.
 * Confidence < 1.0 indicates edge cases that may benefit from LLM analysis.
 */
export function selectAgentsByRules(characteristics: FileCharacteristics): {
  agents: AgentType[];
  reasons: Record<string, string>;
  confidence: number;
} {
  const agents: AgentType[] = [];
  const reasons: Record<string, string> = {};
  let confidence = 1.0;

  const {
    hasSourceCode,
    hasOnlyStyles,
    hasSecuritySensitive,
    hasTests,
    hasConfig,
    hasDocs,
    hasDatabase,
    hasTemplates,
  } = characteristics;

  // === Security Reviewer ===
  if (hasSecuritySensitive || hasDatabase || hasTemplates || hasConfig) {
    agents.push('security-reviewer');
    const triggers: string[] = [];
    if (hasSecuritySensitive) triggers.push('安全敏感文件');
    if (hasDatabase) triggers.push('数据库相关');
    if (hasTemplates) triggers.push('HTML模板(XSS风险)');
    if (hasConfig) triggers.push('配置文件');
    reasons['security-reviewer'] = `需要: ${triggers.join(', ')}`;
  } else if (hasSourceCode) {
    // Source code might still have security issues
    agents.push('security-reviewer');
    reasons['security-reviewer'] = '需要: 源代码可能存在安全问题';
    confidence = Math.min(confidence, 0.8); // Lower confidence, might be overkill
  } else {
    reasons['security-reviewer'] = '跳过: 无安全相关文件';
  }

  // === Logic Reviewer ===
  if (hasSourceCode || hasDatabase) {
    agents.push('logic-reviewer');
    const triggers: string[] = [];
    if (hasSourceCode) triggers.push('源代码');
    if (hasDatabase) triggers.push('数据库逻辑');
    reasons['logic-reviewer'] = `需要: ${triggers.join(', ')}`;
  } else if (hasTests) {
    // Tests only might have logic issues
    agents.push('logic-reviewer');
    reasons['logic-reviewer'] = '需要: 测试文件逻辑';
  } else {
    reasons['logic-reviewer'] = '跳过: 无需逻辑检查的文件';
  }

  // === Performance Reviewer ===
  if (hasSourceCode || hasDatabase) {
    agents.push('performance-reviewer');
    const triggers: string[] = [];
    if (hasSourceCode) triggers.push('源代码');
    if (hasDatabase) triggers.push('数据库查询');
    reasons['performance-reviewer'] = `需要: ${triggers.join(', ')}`;
  } else if (hasOnlyStyles && characteristics.totalFiles > 5) {
    // Large CSS changes might have performance implications
    agents.push('performance-reviewer');
    reasons['performance-reviewer'] = '需要: 大量样式文件可能影响性能';
    confidence = Math.min(confidence, 0.7);
  } else {
    reasons['performance-reviewer'] = '跳过: 无性能相关文件';
  }

  // === Style Reviewer ===
  if (hasSourceCode || hasOnlyStyles || hasTests) {
    agents.push('style-reviewer');
    const triggers: string[] = [];
    if (hasSourceCode) triggers.push('源代码');
    if (hasOnlyStyles) triggers.push('样式文件');
    if (hasTests) triggers.push('测试文件');
    reasons['style-reviewer'] = `需要: ${triggers.join(', ')}`;
  } else if (hasDocs) {
    agents.push('style-reviewer');
    reasons['style-reviewer'] = '需要: 文档格式检查';
    confidence = Math.min(confidence, 0.6); // Docs style check is optional
  } else {
    reasons['style-reviewer'] = '跳过: 无需风格检查的文件';
  }

  // === Edge Cases ===
  // Only docs changed
  if (hasDocs && !hasSourceCode && !hasOnlyStyles && !hasConfig) {
    confidence = Math.min(confidence, 0.5);
  }

  // Only config changed
  if (hasConfig && !hasSourceCode && !hasSecuritySensitive) {
    confidence = Math.min(confidence, 0.6);
  }

  // Mixed bag with unclear priority
  if (characteristics.categories.size >= 3) {
    confidence = Math.min(confidence, 0.7);
  }

  return { agents, reasons, confidence };
}

/**
 * LLM-based agent selection for edge cases
 */
async function selectAgentsByLLM(
  diffFiles: DiffFile[],
  characteristics: FileCharacteristics,
  ruleBasedResult: { agents: AgentType[]; reasons: Record<string, string> }
): Promise<{ agents: AgentType[]; reasons: Record<string, string> }> {
  const client = new Anthropic();

  // Build file list summary
  const fileSummary = diffFiles
    .slice(0, 30) // Limit to 30 files for prompt size
    .map((f) => `- ${f.path} (${f.type}, ${f.category})`)
    .join('\n');

  const prompt = `分析以下 diff 文件列表，决定需要运行哪些代码审查 agents。

可用的 agents:
- security-reviewer: 检查安全漏洞（SQL注入、XSS、认证问题、敏感数据泄露等）
- logic-reviewer: 检查逻辑错误、运行时错误、边界条件问题
- performance-reviewer: 检查性能问题（N+1查询、内存泄漏、不必要的计算等）
- style-reviewer: 检查代码风格、一致性、可读性

变更文件列表（共 ${diffFiles.length} 个文件）:
${fileSummary}
${diffFiles.length > 30 ? `\n... 还有 ${diffFiles.length - 30} 个文件` : ''}

文件特征:
- 源代码文件: ${characteristics.hasSourceCode ? '有' : '无'}
- 仅样式文件: ${characteristics.hasOnlyStyles ? '是' : '否'}
- 安全敏感文件: ${characteristics.hasSecuritySensitive ? '有' : '无'}
- 测试文件: ${characteristics.hasTests ? '有' : '无'}
- 配置文件: ${characteristics.hasConfig ? '有' : '无'}
- 文档文件: ${characteristics.hasDocs ? '有' : '无'}
- 数据库相关: ${characteristics.hasDatabase ? '有' : '无'}

规则系统建议的 agents: ${ruleBasedResult.agents.join(', ') || '无'}

请根据实际情况判断，哪些 agents 是真正需要的。输出 JSON 格式:
{
  "agents": ["agent-name", ...],
  "reasons": {
    "agent-name": "选择或排除的理由"
  }
}

只输出 JSON，不要其他内容。`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 500,
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
      agents: string[];
      reasons: Record<string, string>;
    };

    // Validate agents
    const validAgents: AgentType[] = result.agents.filter((a): a is AgentType =>
      ['security-reviewer', 'logic-reviewer', 'style-reviewer', 'performance-reviewer'].includes(a)
    );

    return {
      agents: validAgents,
      reasons: result.reasons || {},
    };
  } catch (error) {
    // Fallback to rule-based result on error
    console.warn('[AgentSelector] LLM selection failed, using rule-based result:', error);
    return ruleBasedResult;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Select which agents to run based on diff content
 *
 * Uses hybrid approach:
 * 1. Rule-based fast filtering for clear cases
 * 2. LLM analysis for edge cases (confidence < 0.8)
 */
export async function selectAgents(
  diffFiles: DiffFile[],
  options: AgentSelectorOptions = {}
): Promise<AgentSelectionResult> {
  const { verbose = false, forceAgents, disableLLM = false } = options;

  // Handle force agents
  if (forceAgents && forceAgents.length > 0) {
    if (verbose) {
      console.log('[AgentSelector] Using forced agents:', forceAgents);
    }
    return {
      agents: forceAgents,
      reasons: { _forced: '用户强制指定' },
      usedLLM: false,
      confidence: 1.0,
    };
  }

  // Handle empty diff
  if (diffFiles.length === 0) {
    if (verbose) {
      console.log('[AgentSelector] No diff files, skipping all agents');
    }
    return {
      agents: [],
      reasons: { _empty: '无变更文件' },
      usedLLM: false,
      confidence: 1.0,
    };
  }

  // Analyze file characteristics
  const characteristics = analyzeFileCharacteristics(diffFiles);

  if (verbose) {
    console.log('[AgentSelector] File characteristics:', {
      totalFiles: characteristics.totalFiles,
      hasSourceCode: characteristics.hasSourceCode,
      hasOnlyStyles: characteristics.hasOnlyStyles,
      hasSecuritySensitive: characteristics.hasSecuritySensitive,
      hasTests: characteristics.hasTests,
      hasConfig: characteristics.hasConfig,
      hasDocs: characteristics.hasDocs,
      hasDatabase: characteristics.hasDatabase,
      hasTemplates: characteristics.hasTemplates,
    });
  }

  // Rule-based selection
  const ruleResult = selectAgentsByRules(characteristics);

  if (verbose) {
    console.log('[AgentSelector] Rule-based result:', {
      agents: ruleResult.agents,
      confidence: ruleResult.confidence,
    });
  }

  // If confidence is high enough or LLM is disabled, use rule-based result
  if (ruleResult.confidence >= 0.8 || disableLLM) {
    return {
      agents: ruleResult.agents,
      reasons: ruleResult.reasons,
      usedLLM: false,
      confidence: ruleResult.confidence,
    };
  }

  // Use LLM for edge cases
  if (verbose) {
    console.log('[AgentSelector] Using LLM for edge case analysis...');
  }

  const llmResult = await selectAgentsByLLM(diffFiles, characteristics, ruleResult);

  return {
    agents: llmResult.agents,
    reasons: llmResult.reasons,
    usedLLM: true,
    confidence: 0.9, // LLM decisions have good but not perfect confidence
  };
}

/**
 * Create an agent selector instance with options
 */
export function createAgentSelector(options: AgentSelectorOptions = {}) {
  return {
    select: (diffFiles: DiffFile[]) => selectAgents(diffFiles, options),
    analyzeCharacteristics: analyzeFileCharacteristics,
    selectByRules: selectAgentsByRules,
  };
}
