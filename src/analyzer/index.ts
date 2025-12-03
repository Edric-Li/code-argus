/**
 * Diff Analyzer Module
 * Provides local rule-based analysis of git diffs
 */

// Export types
export type {
  RiskLevel,
  SemanticHints,
  ChangeAnalysis,
  AnalysisMetadata,
  AnalysisResult,
} from './types.js';

// Export local rule-based analyzer (fast, no LLM calls)
export { LocalDiffAnalyzer, createLocalDiffAnalyzer } from './local-analyzer.js';
