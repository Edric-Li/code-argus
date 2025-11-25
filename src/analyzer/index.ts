/**
 * Diff Analyzer Module
 * Provides both LLM-based and local rule-based analysis of git diffs
 */

// Export types
export type {
  RiskLevel,
  ChangedInterface,
  ChangedFunction,
  SemanticHints,
  ChangeAnalysis,
  LLMAnalysisResponse,
  AnalysisMetadata,
  AnalysisResult,
  DiffAnalyzerConfig,
} from './types.js';

export { DEFAULT_ANALYZER_CONFIG } from './types.js';

// Export LLM-based analyzer
export { DiffAnalyzer, createDiffAnalyzer } from './diff-analyzer.js';

// Export local rule-based analyzer (fast, no LLM calls)
export { LocalDiffAnalyzer, createLocalDiffAnalyzer } from './local-analyzer.js';

// Export prompts (for customization)
export { DIFF_ANALYSIS_SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
