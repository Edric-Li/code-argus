/**
 * Intent Analyzer
 * Analyzes PR intent using commits and diff analysis
 */

import { llm, type ChatResponse } from '../llm/index.js';
import { withRetry } from '../utils/index.js';
import type { AnalysisResult } from '../analyzer/types.js';
import type { RawCommit, IntentAnalysis, LLMIntentResponse, CommitFilterResult } from './types.js';
import { INTENT_SYSTEM_PROMPT, buildIntentPrompt } from './prompts.js';
import { filterCommits } from './commit-filter.js';

/**
 * Default fallback intent when analysis fails
 */
const FALLBACK_INTENT: LLMIntentResponse = {
  summary: '无法分析本次变更意图，请查看具体的代码变更和 commit 信息。',
  primary_goal: '未知',
  change_categories: [],
  confidence: 'low',
};

/**
 * Analyze PR intent from commits and diff analysis
 *
 * @param commits - Raw commits from the PR
 * @param diffAnalysis - Result from DiffAnalyzer
 * @param commitFilterResult - Optional pre-computed filter result (to avoid duplicate filtering)
 * @returns Intent analysis result
 */
export async function analyzeIntent(
  commits: RawCommit[],
  diffAnalysis: AnalysisResult,
  commitFilterResult?: CommitFilterResult
): Promise<IntentAnalysis> {
  // Use provided filter result or compute it
  const filterResult = commitFilterResult ?? filterCommits(commits);

  // If no valid commits and no changes, return empty analysis
  if (filterResult.valid.length === 0 && diffAnalysis.changes.length === 0) {
    return {
      ...FALLBACK_INTENT,
      summary: '本次 PR 没有有效的 commit 信息和代码变更。',
      metadata: {
        total_commits: commits.length,
        valid_commits: 0,
        excluded_commits: filterResult.excluded.length,
        tokens_used: 0,
      },
    };
  }

  // Analyze with LLM
  try {
    const result = await withRetry(
      () => performAnalysis(filterResult.valid, diffAnalysis),
      3,
      1000
    );

    return {
      ...result.intent,
      metadata: {
        total_commits: commits.length,
        valid_commits: filterResult.valid.length,
        excluded_commits: filterResult.excluded.length,
        tokens_used: result.tokens,
      },
    };
  } catch (error) {
    console.error('Intent analysis failed:', error);

    return {
      ...FALLBACK_INTENT,
      metadata: {
        total_commits: commits.length,
        valid_commits: filterResult.valid.length,
        excluded_commits: filterResult.excluded.length,
        tokens_used: 0,
      },
    };
  }
}

/**
 * Perform the actual LLM analysis
 */
async function performAnalysis(
  commits: RawCommit[],
  diffAnalysis: AnalysisResult
): Promise<{ intent: LLMIntentResponse; tokens: number }> {
  const userPrompt = buildIntentPrompt(commits, diffAnalysis);

  const response: ChatResponse = await llm.chatWithMetadata(INTENT_SYSTEM_PROMPT, userPrompt);

  const intent = parseIntentResponse(response.content);

  return {
    intent,
    tokens: response.metadata.totalTokens ?? 0,
  };
}

/**
 * Parse LLM response into structured intent
 */
function parseIntentResponse(content: string): LLMIntentResponse {
  try {
    let jsonStr = content.trim();

    // Handle markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1]!.trim();
    }

    const parsed: LLMIntentResponse = JSON.parse(jsonStr);

    // Validate required fields
    if (!parsed.summary || !parsed.primary_goal) {
      throw new Error('Missing required fields');
    }

    // Normalize
    return {
      summary: parsed.summary,
      primary_goal: parsed.primary_goal,
      change_categories: parsed.change_categories || [],
      confidence: parsed.confidence || 'medium',
    };
  } catch (error) {
    console.error('Failed to parse intent response:', error);
    return FALLBACK_INTENT;
  }
}
