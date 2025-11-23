/**
 * Prettier Configuration Parser
 *
 * Supports:
 * - .prettierrc.{json,yaml,yml,js,cjs,mjs}
 * - prettier.config.{js,cjs,mjs}
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PrettierStandards } from '../../types.js';
import type { ParserResult } from '../types.js';
import { PRETTIER_CONFIG_PATTERNS } from '../types.js';

/**
 * Find Prettier config file in the given directory
 */
export function findPrettierConfig(repoPath: string): string | null {
  for (const pattern of PRETTIER_CONFIG_PATTERNS) {
    const configPath = join(repoPath, pattern);
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  // Also check package.json for prettier field
  const packageJsonPath = join(repoPath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      // We'll check this in the parse function
      return packageJsonPath;
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Parse JSON Prettier config
 */
function parseJsonConfig(content: string): PrettierStandards {
  return JSON.parse(content) as PrettierStandards;
}

/**
 * Parse YAML Prettier config (simplified)
 */
function parseYamlConfig(content: string): PrettierStandards {
  const standards: PrettierStandards = {};

  // Simple YAML parsing for common options
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      if (key && value !== undefined) {
        const trimmedValue = value.trim();

        // Parse value
        if (trimmedValue === 'true') {
          standards[key] = true;
        } else if (trimmedValue === 'false') {
          standards[key] = false;
        } else if (/^\d+$/.test(trimmedValue)) {
          standards[key] = parseInt(trimmedValue, 10);
        } else {
          standards[key] = trimmedValue.replace(/^['"]|['"]$/g, '');
        }
      }
    }
  }

  return standards;
}

/**
 * Parse JS Prettier config (heuristic)
 */
function parseJsConfig(content: string): PrettierStandards {
  const standards: PrettierStandards = {};

  // Extract common options using regex
  const optionPatterns: [string, RegExp][] = [
    ['tabWidth', /tabWidth\s*:\s*(\d+)/],
    ['useTabs', /useTabs\s*:\s*(true|false)/],
    ['semi', /semi\s*:\s*(true|false)/],
    ['singleQuote', /singleQuote\s*:\s*(true|false)/],
    ['printWidth', /printWidth\s*:\s*(\d+)/],
    ['trailingComma', /trailingComma\s*:\s*['"](\w+)['"]/],
    ['bracketSpacing', /bracketSpacing\s*:\s*(true|false)/],
    ['arrowParens', /arrowParens\s*:\s*['"](\w+)['"]/],
    ['endOfLine', /endOfLine\s*:\s*['"](\w+)['"]/],
  ];

  for (const [key, pattern] of optionPatterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      const value = match[1];
      if (value === 'true') {
        standards[key] = true;
      } else if (value === 'false') {
        standards[key] = false;
      } else if (/^\d+$/.test(value)) {
        standards[key] = parseInt(value, 10);
      } else {
        standards[key] = value;
      }
    }
  }

  return standards;
}

/**
 * Parse Prettier configuration from the given repository
 */
export async function parsePrettierConfig(
  repoPath: string
): Promise<ParserResult<PrettierStandards>> {
  const configPath = findPrettierConfig(repoPath);

  if (!configPath) {
    return { data: null, source: null };
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const fileName = configPath.split('/').pop() ?? '';

    let standards: PrettierStandards;

    if (fileName === 'package.json') {
      // Check for prettier field in package.json
      const pkg = JSON.parse(content) as { prettier?: PrettierStandards };
      if (pkg.prettier) {
        standards = pkg.prettier;
      } else {
        return { data: null, source: null };
      }
    } else if (fileName.endsWith('.json') || fileName === '.prettierrc') {
      standards = parseJsonConfig(content);
    } else if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
      standards = parseYamlConfig(content);
    } else {
      // JS format
      standards = parseJsConfig(content);
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
 * Convert Prettier standards to human-readable text for prompts
 */
export function prettierStandardsToText(standards: PrettierStandards): string {
  const lines: string[] = ['### Code Formatting (Prettier)'];

  const descriptions: Record<string, (value: unknown) => string> = {
    tabWidth: (v) => `Indentation: ${v} spaces`,
    useTabs: (v) => (v ? 'Use tabs for indentation' : 'Use spaces for indentation'),
    semi: (v) => (v ? 'Semicolons required' : 'No semicolons'),
    singleQuote: (v) => (v ? 'Single quotes' : 'Double quotes'),
    printWidth: (v) => `Max line width: ${v}`,
    trailingComma: (v) => `Trailing commas: ${v}`,
    bracketSpacing: (v) => (v ? 'Spaces in object brackets' : 'No spaces in object brackets'),
    arrowParens: (v) => `Arrow function parens: ${v}`,
    endOfLine: (v) => `Line endings: ${v}`,
  };

  lines.push('');

  for (const [key, value] of Object.entries(standards)) {
    const descFn = descriptions[key];
    if (descFn) {
      lines.push(`- ${descFn(value)}`);
    }
  }

  return lines.join('\n');
}
