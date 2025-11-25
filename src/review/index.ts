/**
 * AI Code Review Module
 *
 * Multi-agent code review system using Claude Agent SDK.
 */

// Main orchestrator
export { ReviewOrchestrator, createOrchestrator, review } from './orchestrator.js';

// Types
export type {
  // Basic types
  Severity,
  IssueCategory,
  ValidationStatus,
  RiskLevel,
  ChecklistResult,
  AgentType,
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

// Standards extraction
export { extractStandards, standardsToPromptText, createStandards } from './standards/index.js';

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
} from './validator.js';

// Deduplicator
export {
  IssueDeduplicator,
  createDeduplicator,
  type DeduplicatorOptions,
  type DeduplicationResult,
} from './deduplicator.js';
