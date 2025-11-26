/**
 * Template Loader for Prompt Templates
 *
 * Loads prompt templates from markdown files.
 * Templates are cached in memory for performance.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IssueCategory } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_DIR = join(__dirname, 'templates');

/**
 * Cache for loaded templates
 */
const templateCache = new Map<string, string>();

/**
 * Load a template from file (with caching)
 */
function loadTemplate(filename: string): string {
  if (templateCache.has(filename)) {
    return templateCache.get(filename)!;
  }

  const filePath = join(TEMPLATE_DIR, filename);
  if (!existsSync(filePath)) {
    throw new Error(`Template not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  templateCache.set(filename, content);
  return content;
}

/**
 * Load base validation template
 */
export function loadBaseValidationTemplate(): string {
  return loadTemplate('base-validation.md');
}

/**
 * Load category-specific validation template
 */
export function loadCategoryValidationTemplate(category: IssueCategory): string {
  const filename = `${category}-validation.md`;
  return loadTemplate(filename);
}

/**
 * Clear all cached templates (useful for testing)
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}

/**
 * Preload all templates (useful for optimizing startup)
 */
export function preloadAllTemplates(): void {
  loadBaseValidationTemplate();
  const categories: IssueCategory[] = [
    'style',
    'security',
    'logic',
    'performance',
    'maintainability',
  ];
  for (const category of categories) {
    loadCategoryValidationTemplate(category);
  }
  // Preload common templates
  loadToolUsageTemplate();
  loadOutputFormatTemplate();
  loadDiffAnalysisTemplate();
  loadDiffAnalyzerSystemTemplate();
  loadIntentSystemTemplate();
  loadDeduplicationTemplate();
}

// ============================================================================
// Common Prompt Templates
// ============================================================================

/**
 * Load tool usage instructions template
 */
export function loadToolUsageTemplate(): string {
  return loadTemplate('tool-usage.md');
}

/**
 * Load output format instructions template
 */
export function loadOutputFormatTemplate(): string {
  return loadTemplate('output-format.md');
}

/**
 * Load diff analysis instructions template
 */
export function loadDiffAnalysisTemplate(): string {
  return loadTemplate('diff-analysis.md');
}

/**
 * Load diff analyzer system prompt template
 */
export function loadDiffAnalyzerSystemTemplate(): string {
  return loadTemplate('diff-analyzer-system.md');
}

/**
 * Load intent analysis system prompt template
 */
export function loadIntentSystemTemplate(): string {
  return loadTemplate('intent-system.md');
}

/**
 * Load deduplication prompt template
 */
export function loadDeduplicationTemplate(): string {
  return loadTemplate('deduplication.md');
}
