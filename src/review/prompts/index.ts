/**
 * Prompts Module
 */

export {
  RAW_ISSUE_SCHEMA,
  CHECKLIST_ITEM_SCHEMA,
  AGENT_OUTPUT_SCHEMA,
  AGENT_OUTPUT_JSON_SCHEMA,
  TOOL_USAGE_INSTRUCTIONS,
  OUTPUT_FORMAT_INSTRUCTIONS,
  DIFF_ANALYSIS_INSTRUCTIONS,
  COMMON_CHECKLIST,
  buildBaseSystemPrompt,
  buildContextSection,
  buildChecklistSection,
  parseAgentResponse,
  isValidSeverity,
  isValidCategory,
  generateIssueId,
} from './base.js';

export {
  buildSpecialistPrompt,
  buildAllSpecialistPrompts,
  buildValidatorPrompt,
  standardsToText,
  type SpecialistContext,
  type ValidatorContext,
} from './specialist.js';

// Streaming prompts
export {
  REPORT_ISSUE_TOOL_INSTRUCTIONS,
  STREAMING_CHECKLISTS,
  buildStreamingSystemPrompt,
  buildStreamingUserPrompt,
} from './streaming.js';
