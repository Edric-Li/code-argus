/**
 * Template Loader for Validation Prompts
 *
 * Loads prompt templates from markdown files.
 * Templates are cached in memory for performance.
 */

import { readFileSync } from 'node:fs';
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
}
