/**
 * Intent Analysis Module
 * Provides commit-based intent recognition for PRs
 */

// Export types
export type {
  RawCommit,
  ExcludeReason,
  FilteredCommit,
  CommitFilterResult,
  ChangeCategory,
  ConfidenceLevel,
  IntentAnalysis,
  LLMIntentResponse,
} from './types.js';

// Export commit filter
export { filterCommits } from './commit-filter.js';

// Export intent analyzer
export { analyzeIntent } from './intent-analyzer.js';

// Export prompts (for customization)
export { INTENT_SYSTEM_PROMPT, buildIntentPrompt } from './prompts.js';
