/**
 * Diff Analyzer Module
 * Provides LLM-based analysis of git diffs
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

// Export analyzer
export { DiffAnalyzer, createDiffAnalyzer } from './diff-analyzer.js';

// Export prompts (for customization)
export { DIFF_ANALYSIS_SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
