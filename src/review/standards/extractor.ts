/**
 * Standards Extractor
 *
 * Extracts project coding standards from configuration files
 * and converts them to prompt-friendly text.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStandards, NamingConventions } from '../types.js';
import type { ExtractorOptions } from './types.js';
import { DEFAULT_EXTRACTOR_OPTIONS } from './types.js';
import {
  parseESLintConfig,
  parseTSConfig,
  parsePrettierConfig,
  eslintStandardsToText,
  tsStandardsToText,
  prettierStandardsToText,
} from './parsers/index.js';

/**
 * Infer naming conventions from existing files in the repository
 */
async function inferNamingConventions(repoPath: string): Promise<NamingConventions> {
  const conventions: NamingConventions = {};

  try {
    // Check src directory for file naming patterns
    const srcPath = join(repoPath, 'src');
    const files = await readdir(srcPath, { recursive: true });

    const tsFiles = files.filter(
      (f) => typeof f === 'string' && (f.endsWith('.ts') || f.endsWith('.tsx'))
    );

    if (tsFiles.length > 0) {
      // Analyze file naming
      const fileNames = tsFiles.map((f) => {
        const name =
          typeof f === 'string'
            ? f
                .split('/')
                .pop()
                ?.replace(/\.(ts|tsx)$/, '')
            : '';
        return name ?? '';
      });

      // Count patterns
      const patterns = {
        kebab: 0,
        camel: 0,
        pascal: 0,
        snake: 0,
      };

      for (const name of fileNames) {
        if (!name) continue;
        if (name.includes('-')) patterns.kebab++;
        else if (name.includes('_')) patterns.snake++;
        else if (name[0] === name[0]?.toUpperCase()) patterns.pascal++;
        else patterns.camel++;
      }

      // Determine dominant pattern
      const maxPattern = Object.entries(patterns).reduce((a, b) => (a[1] > b[1] ? a : b));

      if (maxPattern[1] > fileNames.length * 0.5) {
        const patternMap: Record<string, NamingConventions['files']> = {
          kebab: 'kebab-case',
          camel: 'camelCase',
          pascal: 'PascalCase',
          snake: 'snake_case',
        };
        conventions.files = patternMap[maxPattern[0]];
      }
    }
  } catch {
    // Ignore errors, naming inference is optional
  }

  // Set common defaults
  conventions.functions = 'camelCase';
  conventions.classes = 'PascalCase';
  conventions.constants = 'SCREAMING_SNAKE_CASE';
  conventions.variables = 'camelCase';

  return conventions;
}

/**
 * Extract all project standards from configuration files
 */
export async function extractStandards(
  repoPath: string,
  options: ExtractorOptions = {}
): Promise<ProjectStandards> {
  const opts = { ...DEFAULT_EXTRACTOR_OPTIONS, ...options };
  const standards: ProjectStandards = {
    source: [],
  };

  // Extract ESLint standards
  if (opts.eslint) {
    const result = await parseESLintConfig(repoPath);
    if (result.data) {
      standards.eslint = result.data;
      if (result.source) {
        standards.source.push(result.source);
      }
    }
  }

  // Extract TypeScript standards
  if (opts.typescript) {
    const result = await parseTSConfig(repoPath);
    if (result.data) {
      standards.typescript = result.data;
      if (result.source) {
        standards.source.push(result.source);
      }
    }
  }

  // Extract Prettier standards
  if (opts.prettier) {
    const result = await parsePrettierConfig(repoPath);
    if (result.data) {
      standards.prettier = result.data;
      if (result.source) {
        standards.source.push(result.source);
      }
    }
  }

  // Infer naming conventions
  if (opts.inferNaming) {
    standards.naming = await inferNamingConventions(repoPath);
  }

  return standards;
}

/**
 * Convert naming conventions to human-readable text
 */
function namingConventionsToText(conventions: NamingConventions): string {
  const lines: string[] = ['### Naming Conventions'];

  const descriptions: Record<string, string> = {
    files: 'Files',
    functions: 'Functions/Methods',
    classes: 'Classes/Interfaces',
    constants: 'Constants',
    variables: 'Variables',
  };

  lines.push('');

  for (const [key, value] of Object.entries(conventions)) {
    if (value) {
      const label = descriptions[key] ?? key;
      lines.push(`- ${label}: \`${value}\``);
    }
  }

  return lines.join('\n');
}

/**
 * Convert project standards to prompt-friendly text
 */
export function standardsToPromptText(standards: ProjectStandards): string {
  const sections: string[] = [];

  sections.push('## Project Coding Standards');
  sections.push('');
  sections.push(`> Auto-extracted from: ${standards.source.join(', ') || 'No config files found'}`);
  sections.push('');

  if (standards.typescript) {
    sections.push(tsStandardsToText(standards.typescript));
    sections.push('');
  }

  if (standards.eslint) {
    sections.push(eslintStandardsToText(standards.eslint));
    sections.push('');
  }

  if (standards.prettier) {
    sections.push(prettierStandardsToText(standards.prettier));
    sections.push('');
  }

  if (standards.naming) {
    sections.push(namingConventionsToText(standards.naming));
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Create a standards object with prompt text helper
 */
export async function createStandards(
  repoPath: string,
  options?: ExtractorOptions
): Promise<ProjectStandards & { asPromptText: () => string }> {
  const standards = await extractStandards(repoPath, options);

  return {
    ...standards,
    asPromptText: () => standardsToPromptText(standards),
  };
}
