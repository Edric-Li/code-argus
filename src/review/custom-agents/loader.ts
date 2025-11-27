/**
 * Custom Agent Loader
 *
 * Loads user-defined custom agents from external directories.
 * Supports YAML/YML format for agent definitions.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, resolve, basename, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  CustomAgentDefinition,
  LoadedCustomAgent,
  CustomAgentLoaderOptions,
  CustomAgentLoadResult,
  TriggerMode,
  RuleTrigger,
  CustomAgentOutput,
} from './types.js';
import { CUSTOM_AGENT_EXTENSIONS, CUSTOM_AGENT_DEFAULTS } from './types.js';

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate trigger configuration
 */
function validateTriggers(triggers: unknown, agentName: string): RuleTrigger | undefined {
  if (!triggers || typeof triggers !== 'object') {
    return undefined;
  }

  const t = triggers as Record<string, unknown>;
  const result: RuleTrigger = {};

  // Validate files array
  if (t.files !== undefined) {
    if (!Array.isArray(t.files) || !t.files.every((f) => typeof f === 'string')) {
      throw new Error(`Agent "${agentName}": triggers.files must be an array of strings`);
    }
    result.files = t.files;
  }

  // Validate exclude_files array
  if (t.exclude_files !== undefined) {
    if (!Array.isArray(t.exclude_files) || !t.exclude_files.every((f) => typeof f === 'string')) {
      throw new Error(`Agent "${agentName}": triggers.exclude_files must be an array of strings`);
    }
    result.exclude_files = t.exclude_files;
  }

  // Validate content_patterns array
  if (t.content_patterns !== undefined) {
    if (
      !Array.isArray(t.content_patterns) ||
      !t.content_patterns.every((p) => typeof p === 'string')
    ) {
      throw new Error(
        `Agent "${agentName}": triggers.content_patterns must be an array of strings`
      );
    }
    // Validate regex patterns
    for (const pattern of t.content_patterns) {
      try {
        new RegExp(pattern);
      } catch {
        throw new Error(
          `Agent "${agentName}": Invalid regex pattern in content_patterns: "${pattern}"`
        );
      }
    }
    result.content_patterns = t.content_patterns;
  }

  // Validate file_status array
  if (t.file_status !== undefined) {
    const validStatuses = ['added', 'modified', 'deleted', 'renamed'];
    if (!Array.isArray(t.file_status) || !t.file_status.every((s) => validStatuses.includes(s))) {
      throw new Error(
        `Agent "${agentName}": triggers.file_status must be an array of: ${validStatuses.join(', ')}`
      );
    }
    result.file_status = t.file_status;
  }

  // Validate min_changes
  if (t.min_changes !== undefined) {
    if (typeof t.min_changes !== 'number' || t.min_changes < 0) {
      throw new Error(`Agent "${agentName}": triggers.min_changes must be a non-negative number`);
    }
    result.min_changes = t.min_changes;
  }

  // Validate min_files
  if (t.min_files !== undefined) {
    if (typeof t.min_files !== 'number' || t.min_files < 1) {
      throw new Error(`Agent "${agentName}": triggers.min_files must be a positive number`);
    }
    result.min_files = t.min_files;
  }

  // Validate match_mode
  if (t.match_mode !== undefined) {
    if (t.match_mode !== 'all' && t.match_mode !== 'any') {
      throw new Error(`Agent "${agentName}": triggers.match_mode must be 'all' or 'any'`);
    }
    result.match_mode = t.match_mode;
  }

  return result;
}

/**
 * Validate output configuration
 */
function validateOutput(output: unknown, agentName: string): CustomAgentOutput | undefined {
  if (!output || typeof output !== 'object') {
    return undefined;
  }

  const o = output as Record<string, unknown>;
  const result: CustomAgentOutput = {};

  // Validate category
  if (o.category !== undefined) {
    const validCategories = ['security', 'logic', 'performance', 'style', 'maintainability'];
    if (!validCategories.includes(o.category as string)) {
      throw new Error(
        `Agent "${agentName}": output.category must be one of: ${validCategories.join(', ')}`
      );
    }
    result.category = o.category as CustomAgentOutput['category'];
  }

  // Validate default_severity
  if (o.default_severity !== undefined) {
    const validSeverities = ['critical', 'error', 'warning', 'suggestion'];
    if (!validSeverities.includes(o.default_severity as string)) {
      throw new Error(
        `Agent "${agentName}": output.default_severity must be one of: ${validSeverities.join(', ')}`
      );
    }
    result.default_severity = o.default_severity as CustomAgentOutput['default_severity'];
  }

  // Validate severity_weight
  if (o.severity_weight !== undefined) {
    if (typeof o.severity_weight !== 'number' || o.severity_weight < 0 || o.severity_weight > 2) {
      throw new Error(
        `Agent "${agentName}": output.severity_weight must be a number between 0 and 2`
      );
    }
    result.severity_weight = o.severity_weight;
  }

  return result;
}

/**
 * Parse and validate a custom agent definition from raw YAML content
 */
function parseAgentDefinition(content: string, filePath: string): CustomAgentDefinition {
  const raw = parseYaml(content);

  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid YAML: expected an object');
  }

  const data = raw as Record<string, unknown>;

  // Derive name from filename if not specified
  const fileBasename = basename(filePath, extname(filePath));
  const name = (data.name as string) || fileBasename;

  // Validate required fields
  if (!data.prompt || typeof data.prompt !== 'string') {
    throw new Error(`Agent "${name}": 'prompt' is required and must be a string`);
  }

  if (!data.description || typeof data.description !== 'string') {
    throw new Error(`Agent "${name}": 'description' is required and must be a string`);
  }

  // Validate trigger_mode
  const validTriggerModes: TriggerMode[] = ['rule', 'llm', 'hybrid'];
  if (
    data.trigger_mode !== undefined &&
    !validTriggerModes.includes(data.trigger_mode as TriggerMode)
  ) {
    throw new Error(
      `Agent "${name}": trigger_mode must be one of: ${validTriggerModes.join(', ')}`
    );
  }

  // Validate trigger_prompt for llm/hybrid modes
  const triggerMode = (data.trigger_mode as TriggerMode) || CUSTOM_AGENT_DEFAULTS.trigger_mode;
  if (
    (triggerMode === 'llm' || triggerMode === 'hybrid') &&
    !data.trigger_prompt &&
    !data.triggers
  ) {
    throw new Error(
      `Agent "${name}": trigger_prompt or triggers is required for ${triggerMode} mode`
    );
  }

  // Build the definition
  const definition: CustomAgentDefinition = {
    name,
    description: data.description as string,
    prompt: data.prompt as string,
    trigger_mode: triggerMode,
  };

  // Add optional fields
  if (data.triggers) {
    definition.triggers = validateTriggers(data.triggers, name);
  }

  if (data.trigger_prompt && typeof data.trigger_prompt === 'string') {
    definition.trigger_prompt = data.trigger_prompt;
  }

  if (data.trigger_strategy && typeof data.trigger_strategy === 'object') {
    const strategy = data.trigger_strategy as Record<string, unknown>;
    definition.trigger_strategy = {
      rule_confidence_threshold:
        typeof strategy.rule_confidence_threshold === 'number'
          ? strategy.rule_confidence_threshold
          : CUSTOM_AGENT_DEFAULTS.trigger_strategy.rule_confidence_threshold,
      always_use_llm:
        typeof strategy.always_use_llm === 'boolean'
          ? strategy.always_use_llm
          : CUSTOM_AGENT_DEFAULTS.trigger_strategy.always_use_llm,
    };
  }

  if (data.output) {
    definition.output = validateOutput(data.output, name);
  }

  if (data.enabled !== undefined) {
    definition.enabled = Boolean(data.enabled);
  }

  if (Array.isArray(data.tags)) {
    definition.tags = data.tags.filter((t) => typeof t === 'string');
  }

  return definition;
}

/**
 * Load custom agents from a single directory
 */
async function loadAgentsFromDirectory(
  dirPath: string,
  options: CustomAgentLoaderOptions = {}
): Promise<CustomAgentLoadResult> {
  const resolvedPath = resolve(dirPath);
  const result: CustomAgentLoadResult = {
    agents: [],
    errors: [],
    sources: [resolvedPath],
  };

  // Check if directory exists
  if (!(await pathExists(resolvedPath))) {
    if (options.verbose) {
      console.log(`[CustomAgentLoader] Directory not found: ${resolvedPath}`);
    }
    return result;
  }

  // Read directory contents
  let files: string[];
  try {
    files = await readdir(resolvedPath);
  } catch (error) {
    result.errors.push({
      file: resolvedPath,
      error: `Failed to read directory: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }

  // Filter YAML files
  const yamlFiles = files.filter((file) =>
    CUSTOM_AGENT_EXTENSIONS.some((ext) => file.endsWith(ext))
  );

  if (options.verbose) {
    console.log(
      `[CustomAgentLoader] Found ${yamlFiles.length} agent definition(s) in ${resolvedPath}`
    );
  }

  // Load each agent definition
  for (const file of yamlFiles) {
    const filePath = join(resolvedPath, file);

    try {
      const content = await readFile(filePath, 'utf-8');
      const definition = parseAgentDefinition(content, filePath);

      // Skip disabled agents if enabledOnly is true
      if (options.enabledOnly !== false && definition.enabled === false) {
        if (options.verbose) {
          console.log(`[CustomAgentLoader] Skipping disabled agent: ${definition.name}`);
        }
        continue;
      }

      // Filter by tags if specified
      if (options.tags && options.tags.length > 0) {
        const agentTags = definition.tags || [];
        const hasMatchingTag = options.tags.some((tag) => agentTags.includes(tag));
        if (!hasMatchingTag) {
          if (options.verbose) {
            console.log(`[CustomAgentLoader] Skipping agent due to tag filter: ${definition.name}`);
          }
          continue;
        }
      }

      // Create loaded agent
      const loadedAgent: LoadedCustomAgent = {
        ...definition,
        source_file: filePath,
        id: `custom:${definition.name}`,
      };

      result.agents.push(loadedAgent);

      if (options.verbose) {
        console.log(`[CustomAgentLoader] Loaded agent: ${definition.name} (${filePath})`);
      }
    } catch (error) {
      result.errors.push({
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });

      if (options.verbose) {
        console.error(`[CustomAgentLoader] Failed to load ${filePath}: ${error}`);
      }
    }
  }

  return result;
}

/**
 * Load custom agents from multiple directories
 *
 * Agents from later directories with the same name will override earlier ones.
 *
 * @param agentsDirs - Array of directory paths to load agents from
 * @param options - Loader options
 * @returns Load result with agents and any errors
 *
 * @example
 * ```typescript
 * const result = await loadCustomAgents([
 *   './team-agents',
 *   './project-agents',
 * ]);
 *
 * console.log(`Loaded ${result.agents.length} agents`);
 * if (result.errors.length > 0) {
 *   console.warn('Some agents failed to load:', result.errors);
 * }
 * ```
 */
export async function loadCustomAgents(
  agentsDirs: string[],
  options: CustomAgentLoaderOptions = {}
): Promise<CustomAgentLoadResult> {
  const result: CustomAgentLoadResult = {
    agents: [],
    errors: [],
    sources: [],
  };

  if (agentsDirs.length === 0) {
    return result;
  }

  // Track agents by name for deduplication (later overrides earlier)
  const agentsByName = new Map<string, LoadedCustomAgent>();

  for (const dir of agentsDirs) {
    const dirResult = await loadAgentsFromDirectory(dir, options);

    // Merge errors
    result.errors.push(...dirResult.errors);

    // Merge sources
    result.sources.push(...dirResult.sources);

    // Merge agents (later overrides earlier)
    for (const agent of dirResult.agents) {
      if (agentsByName.has(agent.name)) {
        if (options.verbose) {
          console.log(
            `[CustomAgentLoader] Overriding agent "${agent.name}" with definition from ${agent.source_file}`
          );
        }
      }
      agentsByName.set(agent.name, agent);
    }
  }

  result.agents = Array.from(agentsByName.values());

  return result;
}

/**
 * Validate a custom agent definition string
 *
 * Useful for validating agent definitions before saving them.
 *
 * @param content - YAML content to validate
 * @param filename - Optional filename for error messages
 * @returns Validation result
 */
export function validateAgentDefinition(
  content: string,
  filename: string = 'agent.yaml'
): { valid: boolean; error?: string; definition?: CustomAgentDefinition } {
  try {
    const definition = parseAgentDefinition(content, filename);
    return { valid: true, definition };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get default trigger configuration
 */
export function getDefaultTriggerConfig(): Required<RuleTrigger> {
  return {
    files: [],
    exclude_files: [],
    content_patterns: [],
    file_status: [],
    min_changes: 0,
    min_files: CUSTOM_AGENT_DEFAULTS.triggers.min_files,
    match_mode: CUSTOM_AGENT_DEFAULTS.triggers.match_mode,
  };
}
