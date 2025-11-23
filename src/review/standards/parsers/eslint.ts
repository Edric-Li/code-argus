/**
 * ESLint Configuration Parser
 *
 * Supports:
 * - eslint.config.{js,mjs,cjs} (flat config)
 * - .eslintrc.{js,cjs,json,yaml,yml} (legacy)
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ESLintStandards } from '../../types.js';
import type { ParserResult } from '../types.js';
import { ESLINT_CONFIG_PATTERNS } from '../types.js';

/**
 * Find ESLint config file in the given directory
 */
export function findESLintConfig(repoPath: string): string | null {
  for (const pattern of ESLINT_CONFIG_PATTERNS) {
    const configPath = join(repoPath, pattern);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

/**
 * Parse ESLint flat config (eslint.config.js)
 * Note: We can't actually execute JS files, so we parse them heuristically
 */
async function parseFlatConfig(content: string): Promise<ESLintStandards> {
  const standards: ESLintStandards = {
    rules: {},
    extends: [],
    plugins: [],
  };

  // Extract rules from the config
  // Look for patterns like: rules: { ... }
  const rulesMatch = content.match(/rules\s*:\s*\{([^}]+)\}/g);
  if (rulesMatch) {
    for (const match of rulesMatch) {
      // Extract individual rules
      const rulePatterns = match.matchAll(
        /['"]?([@\w/-]+)['"]?\s*:\s*(['"](?:off|warn|error)['"]|\d|[[{][^\]},]+[\]}])/g
      );
      for (const [, ruleName, ruleValue] of rulePatterns) {
        if (ruleName) {
          standards.rules[ruleName] = ruleValue?.replace(/['"]/g, '') ?? 'off';
        }
      }
    }
  }

  // Extract plugins
  const pluginPatterns = [
    // import pluginName from '...'
    /import\s+(\w+)\s+from\s+['"](@?[\w/-]+)['"]/g,
    // plugins: [pluginName]
    /plugins\s*:\s*\[([^\]]+)\]/g,
  ];

  for (const pattern of pluginPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      if (match[2]?.includes('eslint')) {
        standards.plugins?.push(match[2]);
      }
    }
  }

  // Extract extends (for flat config, look for ...configs)
  const extendsMatches = content.matchAll(/\.\.\.(\w+)(?:\.configs?\.(\w+))?/g);
  for (const match of extendsMatches) {
    if (match[1]) {
      standards.extends?.push(match[2] ? `${match[1]}/${match[2]}` : match[1]);
    }
  }

  return standards;
}

/**
 * Parse legacy ESLint config (.eslintrc.json)
 */
async function parseLegacyJsonConfig(content: string): Promise<ESLintStandards> {
  const config = JSON.parse(content) as {
    rules?: Record<string, unknown>;
    extends?: string | string[];
    plugins?: string[];
  };

  return {
    rules: config.rules ?? {},
    extends: Array.isArray(config.extends)
      ? config.extends
      : config.extends
        ? [config.extends]
        : [],
    plugins: config.plugins ?? [],
  };
}

/**
 * Parse legacy ESLint config (.eslintrc.js)
 */
async function parseLegacyJsConfig(content: string): Promise<ESLintStandards> {
  const standards: ESLintStandards = {
    rules: {},
    extends: [],
    plugins: [],
  };

  // Extract rules
  const rulesMatch = content.match(/rules\s*:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s);
  if (rulesMatch?.[1]) {
    const rulesContent = rulesMatch[1];
    const rulePatterns = rulesContent.matchAll(
      /['"]?([@\w/-]+)['"]?\s*:\s*(['"](?:off|warn|error)['"]|\d|\[[\s\S]*?\])/g
    );
    for (const [, ruleName, ruleValue] of rulePatterns) {
      if (ruleName) {
        standards.rules[ruleName] = ruleValue?.replace(/^['"]|['"]$/g, '') ?? 'off';
      }
    }
  }

  // Extract extends
  const extendsMatch = content.match(/extends\s*:\s*\[([^\]]+)\]/);
  if (extendsMatch?.[1]) {
    const extends_ = extendsMatch[1].match(/['"]([^'"]+)['"]/g);
    if (extends_) {
      standards.extends = extends_.map((e) => e.replace(/['"]/g, ''));
    }
  } else {
    const singleExtend = content.match(/extends\s*:\s*['"]([^'"]+)['"]/);
    if (singleExtend?.[1]) {
      standards.extends = [singleExtend[1]];
    }
  }

  // Extract plugins
  const pluginsMatch = content.match(/plugins\s*:\s*\[([^\]]+)\]/);
  if (pluginsMatch?.[1]) {
    const plugins = pluginsMatch[1].match(/['"]([^'"]+)['"]/g);
    if (plugins) {
      standards.plugins = plugins.map((p) => p.replace(/['"]/g, ''));
    }
  }

  return standards;
}

/**
 * Parse ESLint configuration from the given repository
 */
export async function parseESLintConfig(repoPath: string): Promise<ParserResult<ESLintStandards>> {
  const configPath = findESLintConfig(repoPath);

  if (!configPath) {
    return { data: null, source: null };
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const fileName = configPath.split('/').pop() ?? '';

    let standards: ESLintStandards;

    if (fileName.startsWith('eslint.config.')) {
      // Flat config format
      standards = await parseFlatConfig(content);
    } else if (fileName.endsWith('.json') || fileName === '.eslintrc') {
      // JSON format
      standards = await parseLegacyJsonConfig(content);
    } else {
      // JS format
      standards = await parseLegacyJsConfig(content);
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
 * Convert ESLint standards to human-readable text for prompts
 */
export function eslintStandardsToText(standards: ESLintStandards): string {
  const lines: string[] = ['### ESLint Rules'];

  if (standards.extends && standards.extends.length > 0) {
    lines.push(`\nExtends: ${standards.extends.join(', ')}`);
  }

  if (standards.plugins && standards.plugins.length > 0) {
    lines.push(`Plugins: ${standards.plugins.join(', ')}`);
  }

  // Group rules by severity
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [rule, value] of Object.entries(standards.rules)) {
    const severity = Array.isArray(value) ? value[0] : value;
    if (severity === 'error' || severity === 2) {
      errors.push(rule);
    } else if (severity === 'warn' || severity === 1) {
      warnings.push(rule);
    }
  }

  if (errors.length > 0) {
    lines.push(
      `\nError-level rules: ${errors.slice(0, 20).join(', ')}${errors.length > 20 ? ` (+${errors.length - 20} more)` : ''}`
    );
  }

  if (warnings.length > 0) {
    lines.push(
      `Warning-level rules: ${warnings.slice(0, 10).join(', ')}${warnings.length > 10 ? ` (+${warnings.length - 10} more)` : ''}`
    );
  }

  return lines.join('\n');
}
