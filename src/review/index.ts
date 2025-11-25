/**
 * AI Code Review Module
 *
 * Multi-agent code review system using Claude Agent SDK.
 */

// Main orchestrator (batch mode)
export { ReviewOrchestrator, createOrchestrator, review } from './orchestrator.js';

// Streaming orchestrator (real-time mode)
export {
  StreamingReviewOrchestrator,
  createStreamingOrchestrator,
  streamingReview,
} from './streaming-orchestrator.js';

// Issue collector for streaming
export {
  IssueCollector,
  createIssueCollector,
  type IssueReport,
  type ReportResult,
  type IssueCollectorOptions,
  type CollectorStats,
} from './issue-collector.js';

// MCP tools
export {
  REPORT_ISSUE_TOOL_DEFINITION,
  createReportIssueHandler,
  formatToolResult,
  type ReportIssueInput,
} from './mcp/index.js';

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
  type ValidationProgressCallback,
} from './validator.js';

// Deduplicator
export {
  IssueDeduplicator,
  createDeduplicator,
  type DeduplicatorOptions,
  type DeduplicationResult,
} from './deduplicator.js';
