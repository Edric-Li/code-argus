/**
 * Prompt templates for intent analysis
 */

import type { RawCommit } from './types.js';
import type { AnalysisResult } from '../analyzer/types.js';
import { loadIntentSystemTemplate } from '../review/prompts/template-loader.js';

/**
 * System prompt for intent analysis
 * Loaded from template file for easier maintenance
 */
export const INTENT_SYSTEM_PROMPT = loadIntentSystemTemplate();

/**
 * Build user prompt for intent analysis
 */
export function buildIntentPrompt(commits: RawCommit[], diffAnalysis: AnalysisResult): string {
  // Format commits
  const commitSection = commits
    .map((c, i) => `${i + 1}. ${c.subject}${c.body ? `\n   ${c.body.slice(0, 200)}` : ''}`)
    .join('\n');

  // Format high risk changes
  const highRisk = diffAnalysis.changes
    .filter((c) => c.risk_level === 'HIGH')
    .map((c) => {
      const hints = c.semantic_hints;
      let detail = `- ${c.file_path}`;

      if (hints.interfaces?.length) {
        const ifaceNames = hints.interfaces.map((i) => i.name).join(', ');
        detail += `\n  接口变更: ${ifaceNames}`;
      }

      if (hints.functions?.length) {
        const funcNames = hints.functions.map((f) => `${f.name}(${f.change_type})`).join(', ');
        detail += `\n  函数变更: ${funcNames}`;
      }

      if (hints.summary) {
        detail += `\n  摘要: ${hints.summary}`;
      }

      return detail;
    })
    .join('\n');

  // Format medium risk changes
  const mediumRisk = diffAnalysis.changes
    .filter((c) => c.risk_level === 'MEDIUM')
    .map(
      (c) => `- ${c.file_path}${c.semantic_hints.summary ? `: ${c.semantic_hints.summary}` : ''}`
    )
    .join('\n');

  // Format low risk changes
  const lowRisk = diffAnalysis.changes
    .filter((c) => c.risk_level === 'LOW')
    .map((c) => c.file_path)
    .join(', ');

  return `## Commit 信息 (${commits.length} 条有效提交)

${commitSection || '无有效 commit 信息'}

## 代码变更分析

### 高风险变更 (${diffAnalysis.changes.filter((c) => c.risk_level === 'HIGH').length} 个文件)
${highRisk || '无'}

### 中风险变更 (${diffAnalysis.changes.filter((c) => c.risk_level === 'MEDIUM').length} 个文件)
${mediumRisk || '无'}

### 低风险变更 (${diffAnalysis.changes.filter((c) => c.risk_level === 'LOW').length} 个文件)
${lowRisk || '无'}

## 统计信息
- 总文件数: ${diffAnalysis.metadata.total_files}
- 已分析: ${diffAnalysis.metadata.analyzed_files}
- 已跳过: ${diffAnalysis.metadata.skipped_files}

请分析本次变更的意图，输出 JSON:
{
  "summary": "约200字的意图分析...",
  "primary_goal": "一句话概括主要目标",
  "change_categories": ["feature", "bugfix", ...],
  "confidence": "high" | "medium" | "low"
}`;
}
