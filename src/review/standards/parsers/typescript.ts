/**
 * TypeScript Configuration Parser
 *
 * Parses tsconfig.json to extract coding standards
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { TypeScriptStandards } from '../../types.js';
import type { ParserResult } from '../types.js';
import { TSCONFIG_PATTERNS } from '../types.js';

/**
 * Find TypeScript config file in the given directory
 */
export function findTSConfig(repoPath: string): string | null {
  for (const pattern of TSCONFIG_PATTERNS) {
    const configPath = join(repoPath, pattern);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

/**
 * Parse JSON with comments (JSONC) - simple implementation
 */
function parseJSONC(content: string): unknown {
  // Remove single-line comments
  const withoutSingleLine = content.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  const withoutComments = withoutSingleLine.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove trailing commas
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');

  return JSON.parse(withoutTrailingCommas);
}

/**
 * Relevant compiler options for code standards
 */
const RELEVANT_OPTIONS = [
  'strict',
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'noImplicitThis',
  'useUnknownInCatchVariables',
  'alwaysStrict',
  'noUnusedLocals',
  'noUnusedParameters',
  'exactOptionalPropertyTypes',
  'noImplicitReturns',
  'noFallthroughCasesInSwitch',
  'noUncheckedIndexedAccess',
  'noImplicitOverride',
  'noPropertyAccessFromIndexSignature',
  'allowUnreachableCode',
  'allowUnusedLabels',
] as const;

/**
 * Parse TypeScript config and resolve extends
 */
async function parseTSConfigWithExtends(
  configPath: string,
  visited: Set<string> = new Set()
): Promise<Record<string, unknown>> {
  // Prevent circular references
  if (visited.has(configPath)) {
    return {};
  }
  visited.add(configPath);

  const content = await readFile(configPath, 'utf-8');
  const config = parseJSONC(content) as {
    extends?: string;
    compilerOptions?: Record<string, unknown>;
  };

  let baseOptions: Record<string, unknown> = {};

  // Handle extends
  if (config.extends) {
    const extendsPaths = Array.isArray(config.extends) ? config.extends : [config.extends];

    for (const extendsPath of extendsPaths) {
      let resolvedPath: string;

      if (extendsPath.startsWith('.')) {
        // Relative path
        resolvedPath = join(dirname(configPath), extendsPath);
        if (!resolvedPath.endsWith('.json')) {
          resolvedPath += '.json';
        }
      } else {
        // Try to resolve from node_modules (simplified)
        const nodeModulesPath = join(dirname(configPath), 'node_modules', extendsPath);
        if (existsSync(nodeModulesPath)) {
          resolvedPath = nodeModulesPath;
        } else if (existsSync(nodeModulesPath + '.json')) {
          resolvedPath = nodeModulesPath + '.json';
        } else {
          // Skip unresolvable extends
          continue;
        }
      }

      if (existsSync(resolvedPath)) {
        const parentOptions = await parseTSConfigWithExtends(resolvedPath, visited);
        baseOptions = { ...baseOptions, ...parentOptions };
      }
    }
  }

  // Merge with current config
  return { ...baseOptions, ...(config.compilerOptions ?? {}) };
}

/**
 * Parse TypeScript configuration from the given repository
 */
export async function parseTSConfig(repoPath: string): Promise<ParserResult<TypeScriptStandards>> {
  const configPath = findTSConfig(repoPath);

  if (!configPath) {
    return { data: null, source: null };
  }

  try {
    const compilerOptions = await parseTSConfigWithExtends(configPath);

    // Extract only relevant options
    const standards: TypeScriptStandards = {};

    for (const option of RELEVANT_OPTIONS) {
      if (option in compilerOptions) {
        standards[option] = compilerOptions[option] as boolean;
      }
    }

    return { data: standards, source: configPath };
  } catch (error) {
    return {
      data: null,
      source: configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Convert TypeScript standards to human-readable text for prompts
 */
export function tsStandardsToText(standards: TypeScriptStandards): string {
  const lines: string[] = ['### TypeScript Standards'];

  const enabledStrict: string[] = [];
  const disabledChecks: string[] = [];

  // Categorize options
  const optionDescriptions: Record<string, string> = {
    strict: 'Strict mode enabled',
    noImplicitAny: 'No implicit any types',
    strictNullChecks: 'Strict null checks',
    strictFunctionTypes: 'Strict function types',
    strictBindCallApply: 'Strict bind/call/apply',
    strictPropertyInitialization: 'Strict property initialization',
    noImplicitThis: 'No implicit this',
    useUnknownInCatchVariables: 'Use unknown in catch variables',
    alwaysStrict: 'Always strict mode',
    noUnusedLocals: 'No unused locals',
    noUnusedParameters: 'No unused parameters',
    exactOptionalPropertyTypes: 'Exact optional property types',
    noImplicitReturns: 'No implicit returns',
    noFallthroughCasesInSwitch: 'No fallthrough cases in switch',
    noUncheckedIndexedAccess: 'No unchecked indexed access',
    noImplicitOverride: 'No implicit override',
    noPropertyAccessFromIndexSignature: 'No property access from index signature',
    allowUnreachableCode: 'Allow unreachable code',
    allowUnusedLabels: 'Allow unused labels',
  };

  for (const [option, value] of Object.entries(standards)) {
    const description = optionDescriptions[option] ?? option;
    if (value === true) {
      enabledStrict.push(description);
    } else if (value === false && option.startsWith('allow')) {
      enabledStrict.push(description.replace('Allow', 'Disallow'));
    } else if (value === false) {
      disabledChecks.push(description);
    }
  }

  if (enabledStrict.length > 0) {
    lines.push(`\nEnabled checks:`);
    for (const check of enabledStrict) {
      lines.push(`- ${check}`);
    }
  }

  if (disabledChecks.length > 0) {
    lines.push(`\nDisabled checks:`);
    for (const check of disabledChecks) {
      lines.push(`- ${check}`);
    }
  }

  return lines.join('\n');
}
