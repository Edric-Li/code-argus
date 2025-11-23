/**
 * Prompt templates for intent analysis
 */

import type { RawCommit } from './types.js';
import type { AnalysisResult } from '../analyzer/types.js';

/**
 * System prompt for intent analysis
 */
export const INTENT_SYSTEM_PROMPT = `你是一个代码变更意图分析专家。你的任务是根据 commit 信息和代码变更分析，总结本次 PR/MR 的意图。

分析要求：
1. 输出约200字的中文总结
2. 重点说明"为什么"要做这个变更，而不只是"做了什么"
3. 如果能识别出业务背景或技术背景，要提及
4. 指出潜在的影响范围和风险点
5. 使用专业但易懂的语言

变更类别说明：
- feature: 新功能
- bugfix: Bug修复
- refactor: 代码重构（不改变功能）
- performance: 性能优化
- style: 代码风格/格式调整
- docs: 文档变更
- test: 测试相关
- chore: 构建/工具/依赖变更
- security: 安全相关修复

置信度判断：
- high: commit 信息清晰，代码变更明确
- medium: 部分信息模糊，但可推断意图
- low: 信息不足，意图推测成分较大

输出纯 JSON，不要 markdown 包裹。`;

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
