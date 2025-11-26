/**
 * AI Code Review Module
 *
 * Multi-agent code review system using Claude Agent SDK.
 */

// Main orchestrator (MCP mode with streaming validation)
export {
  StreamingReviewOrchestrator,
  createStreamingOrchestrator,
  streamingReview,
  streamingReview as review,
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
} from './types.js';

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

// Validator
export {
  IssueValidator,
  createValidator,
  type ValidatorOptions,
  type ValidationResult as SingleValidationResult,
  type ValidationProgressCallback,
} from './validator.js';

// Deduplicator
export {
  IssueDeduplicator,
  createDeduplicator,
  type DeduplicatorOptions,
  type DeduplicationResult,
} from './deduplicator.js';
