/**
 * Custom Agents Module
 *
 * Exports all custom agent functionality for external use.
 */

// Types
export type {
  // Trigger types
  FileStatus,
  TriggerMode,
  RuleTrigger,
  LLMTrigger,
  HybridTriggerStrategy,
  // Agent definition types
  CustomAgentOutput,
  CustomAgentDefinition,
  LoadedCustomAgent,
  // Runtime types
  TriggerContext,
  TriggerResult,
  CustomAgentResult,
  CustomAgentIssue,
  // Loader types
  CustomAgentLoaderOptions,
  CustomAgentLoadResult,
} from './types.js';

// Constants
export { CUSTOM_AGENT_EXTENSIONS, CUSTOM_AGENT_DEFAULTS } from './types.js';

// Loader
export { loadCustomAgents, validateAgentDefinition, getDefaultTriggerConfig } from './loader.js';

// Matcher
export type { CustomAgentMatcherOptions, CustomAgentMatchResult } from './matcher.js';
export { matchCustomAgents, buildTriggerContext } from './matcher.js';

// Executor
export type { CustomAgentExecutorOptions, CustomAgentExecutorCallbacks } from './executor.js';
export { executeCustomAgent, executeCustomAgents, customIssuesToRawIssues } from './executor.js';
