/**
 * AI Code Review Module
 *
 * Multi-agent code review system using Claude Agent SDK.
 */

// Main orchestrator (streaming validation)
export {
  StreamingReviewOrchestrator,
  createStreamingOrchestrator,
  streamingReview,
  reviewByRefs,
  review,
} from './streaming-orchestrator.js';

// Streaming validator
export {
  StreamingValidator,
  createStreamingValidator,
  type StreamingValidatorOptions,
  type StreamingValidationCallbacks,
} from './streaming-validator.js';

// Types
export type {
  // Basic types
  Severity,
  IssueCategory,
  ValidationStatus,
  RiskLevel,
  ChecklistResult,
  AgentType,
  ValidationStrategy,
  ValidationStrategyConfig,
  // Issue types
  RawIssue,
  SymbolLookup,
  GroundingEvidence,
  ValidatedIssue,
  ChecklistItem,
  // Standards types
  ESLintStandards,
  TypeScriptStandards,
  PrettierStandards,
  NamingConventions,
  ProjectStandards,
  // Context and report types
  ReviewContext,
  ReviewMetrics,
  ReviewMetadata,
  ReviewReport,
  // Agent types
  AgentResult,
  ValidationResult,
  // Orchestrator types
  OrchestratorOptions,
  OrchestratorInput,
  ReviewInput,
  CommitRangeInfo,
  // Progress event type
  ReviewProgressEvent,
} from './types.js';

// CLI Events (for service integration)
export {
  ReviewEventEmitter,
  createReviewEventEmitter,
  type ReviewEvent,
  type ReviewEventHandler,
  type ReviewStateSnapshot,
  type AgentState,
} from '../cli/events.js';

// CLI Progress Printers
export {
  createProgressPrinterWithMode,
  type CreateProgressPrinterOptions,
  type ProgressMode,
} from '../cli/index.js';

// Validation strategies
export { DEFAULT_VALIDATION_STRATEGIES } from './types.js';

// Standards extraction
export { extractStandards, standardsToPromptText, createStandards } from './standards/index.js';

// Rules loading (project-specific review guidelines)
export {
  loadRules,
  getRulesForAgent,
  rulesToPromptText,
  isEmptyRules,
  EMPTY_RULES_CONFIG,
  RULES_FILE_NAMES,
  type RulesConfig,
  type RulesLoaderOptions,
  type CustomChecklistItem,
  type RuleAgentType,
} from './rules/index.js';

// Aggregator
export {
  aggregate,
  aggregateIssues,
  groupByCategory,
  groupByFile,
  groupBySeverity,
  type AggregationOptions,
  type AggregationResult,
} from './aggregator.js';

// Report generation
export {
  calculateMetrics,
  determineRiskLevel,
  generateSummary,
  generateReport,
  formatAsJson,
  formatAsMarkdown,
  formatAsSummary,
  formatAsPRComments,
  formatReport,
  type ReportOptions,
  type PRComment,
} from './report.js';

// Prompts (for advanced usage)
export {
  buildBaseSystemPrompt,
  buildContextSection,
  buildChecklistSection,
  buildSpecialistPrompt,
  buildValidatorPrompt,
  standardsToText,
  parseAgentResponse,
  AGENT_OUTPUT_JSON_SCHEMA,
  type SpecialistContext,
  type ValidatorContext,
} from './prompts/index.js';

// Previous review loader (for fix verification)
export {
  loadPreviousReview,
  validatePreviousReviewData,
  filterIssuesBySeverity,
  getPreviousReviewSummary,
} from './previous-review-loader.js';

// Fix verifier
export { executeFixVerifier, type FixVerifierOptions } from './fix-verifier.js';

// Fix verification types
export type {
  VerificationStatus,
  PreviousIssue,
  FixVerificationEvidence,
  FixVerificationResult,
  FixVerificationSummary,
  PreviousReviewData,
} from './types.js';
