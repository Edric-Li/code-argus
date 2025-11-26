/**
 * Rules Loader
 *
 * Loads project-specific review rules from external directories.
 * Supports multiple rules directories with merging.
 */

import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  RulesConfig,
  RulesLoaderOptions,
  CustomChecklistItem,
  RuleAgentType,
} from './types.js';
import { EMPTY_RULES_CONFIG, RULES_FILE_NAMES } from './types.js';

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read file content safely
 */
async function readFileContent(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse checklist YAML file
 */
async function parseChecklistFile(filePath: string): Promise<CustomChecklistItem[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);

    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate and filter valid checklist items
    return parsed.filter((item): item is CustomChecklistItem => {
      return (
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.category === 'string' &&
        typeof item.question === 'string' &&
        ['security', 'logic', 'performance', 'style', 'maintainability'].includes(item.category)
      );
    });
  } catch {
    return [];
  }
}

/**
 * Load rules from a single directory
 */
async function loadRulesFromDirectory(
  dirPath: string,
  options: RulesLoaderOptions = {}
): Promise<RulesConfig> {
  const resolvedPath = resolve(dirPath);

  // Check if directory exists
  if (!(await fileExists(resolvedPath))) {
    if (options.verbose) {
      console.log(`[RulesLoader] Directory not found: ${resolvedPath}`);
    }
    return EMPTY_RULES_CONFIG;
  }

  const config: RulesConfig = {
    agents: {},
    checklist: [],
    sources: [resolvedPath],
  };

  // Load global rules
  const globalPath = join(resolvedPath, RULES_FILE_NAMES.global);
  config.global = await readFileContent(globalPath);
  if (config.global && options.verbose) {
    console.log(`[RulesLoader] Loaded global rules from: ${globalPath}`);
  }

  // Load agent-specific rules
  for (const [agentType, fileName] of Object.entries(RULES_FILE_NAMES.agents)) {
    const filePath = join(resolvedPath, fileName);
    const content = await readFileContent(filePath);
    if (content) {
      config.agents[agentType as RuleAgentType] = content;
      if (options.verbose) {
        console.log(`[RulesLoader] Loaded ${agentType} rules from: ${filePath}`);
      }
    }
  }

  // Load custom checklist
  const checklistPath = join(resolvedPath, RULES_FILE_NAMES.checklist);
  if (await fileExists(checklistPath)) {
    config.checklist = await parseChecklistFile(checklistPath);
    if (config.checklist.length > 0 && options.verbose) {
      console.log(
        `[RulesLoader] Loaded ${config.checklist.length} checklist items from: ${checklistPath}`
      );
    }
  }

  return config;
}

/**
 * Merge multiple rules configs (later configs override earlier ones)
 */
function mergeRulesConfigs(configs: RulesConfig[]): RulesConfig {
  if (configs.length === 0) {
    return EMPTY_RULES_CONFIG;
  }

  if (configs.length === 1) {
    return configs[0]!;
  }

  const merged: RulesConfig = {
    agents: {},
    checklist: [],
    sources: [],
  };

  for (const config of configs) {
    // Merge global (append with separator)
    if (config.global) {
      merged.global = merged.global ? `${merged.global}\n\n---\n\n${config.global}` : config.global;
    }

    // Merge agent rules (append with separator)
    for (const [agentType, content] of Object.entries(config.agents)) {
      const existing = merged.agents[agentType as RuleAgentType];
      merged.agents[agentType as RuleAgentType] = existing
        ? `${existing}\n\n---\n\n${content}`
        : content;
    }

    // Merge checklist (append, later items with same ID override)
    const existingIds = new Set(merged.checklist.map((item) => item.id));
    for (const item of config.checklist) {
      if (existingIds.has(item.id)) {
        // Override existing
        const index = merged.checklist.findIndex((i) => i.id === item.id);
        if (index !== -1) {
          merged.checklist[index] = item;
        }
      } else {
        merged.checklist.push(item);
        existingIds.add(item.id);
      }
    }

    // Merge sources
    merged.sources.push(...config.sources);
  }

  return merged;
}

/**
 * Load rules from multiple directories
 *
 * Rules are merged in order, with later directories taking precedence.
 *
 * @param rulesDirs - Array of directory paths to load rules from
 * @param options - Loader options
 * @returns Merged rules configuration
 *
 * @example
 * ```typescript
 * const rules = await loadRules([
 *   './team-standards',
 *   './project-rules',
 * ]);
 * ```
 */
export async function loadRules(
  rulesDirs: string[],
  options: RulesLoaderOptions = {}
): Promise<RulesConfig> {
  if (rulesDirs.length === 0) {
    return EMPTY_RULES_CONFIG;
  }

  const configs: RulesConfig[] = [];

  for (const dir of rulesDirs) {
    const config = await loadRulesFromDirectory(dir, options);
    if (config.global || Object.keys(config.agents).length > 0 || config.checklist.length > 0) {
      configs.push(config);
    }
  }

  return mergeRulesConfigs(configs);
}

/**
 * Get rules content for a specific agent
 *
 * Combines global rules with agent-specific rules.
 *
 * @param rules - Rules configuration
 * @param agentType - Agent type to get rules for
 * @returns Combined rules content, or undefined if no rules
 */
export function getRulesForAgent(rules: RulesConfig, agentType: RuleAgentType): string | undefined {
  const agentRules = rules.agents[agentType];

  if (!rules.global && !agentRules) {
    return undefined;
  }

  const parts: string[] = [];

  if (rules.global) {
    parts.push('## Global Review Guidelines\n');
    parts.push(rules.global);
  }

  if (agentRules) {
    if (parts.length > 0) {
      parts.push('\n\n');
    }
    parts.push(`## ${formatAgentName(agentType)} Specific Guidelines\n`);
    parts.push(agentRules);
  }

  return parts.join('');
}

/**
 * Format agent type to human-readable name
 */
function formatAgentName(agentType: RuleAgentType): string {
  const names: Record<RuleAgentType, string> = {
    'security-reviewer': 'Security Review',
    'logic-reviewer': 'Logic Review',
    'style-reviewer': 'Style Review',
    'performance-reviewer': 'Performance Review',
  };
  return names[agentType] || agentType;
}

/**
 * Convert rules to prompt text
 *
 * Formats the rules configuration into a markdown section
 * suitable for injection into agent prompts.
 *
 * @param rules - Rules configuration
 * @param agentType - Optional agent type to get specific rules for
 * @returns Formatted prompt text
 */
export function rulesToPromptText(rules: RulesConfig, agentType?: RuleAgentType): string {
  // Return empty string for empty rules
  if (isEmptyRules(rules)) {
    return '';
  }

  if (agentType) {
    const content = getRulesForAgent(rules, agentType);
    if (!content) {
      return '';
    }
    return `## Project-Specific Review Guidelines\n\n> Loaded from: ${rules.sources.join(', ')}\n\n${content}`;
  }

  // Return all rules
  const sections: string[] = [];

  sections.push('## Project-Specific Review Guidelines\n');
  sections.push(`> Loaded from: ${rules.sources.join(', ')}\n`);

  if (rules.global) {
    sections.push('### Global Guidelines\n');
    sections.push(rules.global);
    sections.push('');
  }

  for (const [agentType, content] of Object.entries(rules.agents)) {
    sections.push(`### ${formatAgentName(agentType as RuleAgentType)} Guidelines\n`);
    sections.push(content);
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Check if rules config is empty
 */
export function isEmptyRules(rules: RulesConfig): boolean {
  return !rules.global && Object.keys(rules.agents).length === 0 && rules.checklist.length === 0;
}
