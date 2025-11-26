/**
 * Agent Selector Tests
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeFileCharacteristics,
  selectAgentsByRules,
  selectAgents,
} from '../../src/review/agent-selector.js';
import type { DiffFile, FileCategory } from '../../src/git/parser.js';

// Helper to create mock DiffFile
function createDiffFile(
  path: string,
  category: FileCategory = 'source',
  type: 'add' | 'delete' | 'modify' = 'modify'
): DiffFile {
  return { path, category, type, content: `diff content for ${path}` };
}

describe('analyzeFileCharacteristics', () => {
  it('should identify source code files', () => {
    const files = [createDiffFile('src/index.ts'), createDiffFile('src/utils.js')];
    const result = analyzeFileCharacteristics(files);

    expect(result.hasSourceCode).toBe(true);
    expect(result.hasOnlyStyles).toBe(false);
    expect(result.totalFiles).toBe(2);
  });

  it('should identify style-only changes', () => {
    const files = [createDiffFile('src/styles/main.css'), createDiffFile('src/styles/theme.scss')];
    const result = analyzeFileCharacteristics(files);

    expect(result.hasSourceCode).toBe(false);
    expect(result.hasOnlyStyles).toBe(true);
    expect(result.totalFiles).toBe(2);
  });

  it('should identify security-sensitive files', () => {
    const files = [createDiffFile('src/auth/login.ts'), createDiffFile('src/utils/password.ts')];
    const result = analyzeFileCharacteristics(files);

    expect(result.hasSecuritySensitive).toBe(true);
  });

  it('should identify test files', () => {
    const files = [
      createDiffFile('src/__tests__/utils.test.ts'),
      createDiffFile('src/components/Button.spec.tsx'),
    ];
    const result = analyzeFileCharacteristics(files);

    expect(result.hasTests).toBe(true);
    expect(result.hasSourceCode).toBe(true);
  });

  it('should identify config files', () => {
    const files = [
      createDiffFile('package.json', 'config'),
      createDiffFile('tsconfig.json', 'config'),
    ];
    const result = analyzeFileCharacteristics(files);

    expect(result.hasConfig).toBe(true);
  });

  it('should identify documentation files', () => {
    const files = [createDiffFile('README.md', 'data'), createDiffFile('docs/api.md', 'data')];
    const result = analyzeFileCharacteristics(files);

    expect(result.hasDocs).toBe(true);
  });

  it('should identify database-related files', () => {
    const files = [
      createDiffFile('db/migrations/001_init.sql'),
      createDiffFile('prisma/schema.prisma'),
    ];
    const result = analyzeFileCharacteristics(files);

    expect(result.hasDatabase).toBe(true);
  });

  it('should identify template files', () => {
    const files = [createDiffFile('templates/index.html'), createDiffFile('views/page.ejs')];
    const result = analyzeFileCharacteristics(files);

    expect(result.hasTemplates).toBe(true);
  });

  it('should handle empty file list', () => {
    const result = analyzeFileCharacteristics([]);

    expect(result.totalFiles).toBe(0);
    expect(result.hasSourceCode).toBe(false);
    expect(result.hasOnlyStyles).toBe(false);
  });
});

describe('selectAgentsByRules', () => {
  it('should select all agents for TypeScript files', () => {
    const characteristics = analyzeFileCharacteristics([
      createDiffFile('src/index.ts'),
      createDiffFile('src/utils.ts'),
    ]);
    const result = selectAgentsByRules(characteristics);

    expect(result.agents).toContain('security-reviewer');
    expect(result.agents).toContain('logic-reviewer');
    expect(result.agents).toContain('performance-reviewer');
    expect(result.agents).toContain('style-reviewer');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should skip security and performance for style-only changes', () => {
    const characteristics = analyzeFileCharacteristics([
      createDiffFile('src/styles/main.css'),
      createDiffFile('src/styles/theme.scss'),
    ]);
    const result = selectAgentsByRules(characteristics);

    expect(result.agents).not.toContain('security-reviewer');
    expect(result.agents).not.toContain('logic-reviewer');
    expect(result.agents).toContain('style-reviewer');
    // Performance might still be included for large CSS files
  });

  it('should include security for auth-related files', () => {
    const characteristics = analyzeFileCharacteristics([createDiffFile('src/auth/login.ts')]);
    const result = selectAgentsByRules(characteristics);

    expect(result.agents).toContain('security-reviewer');
    expect(result.reasons['security-reviewer']).toContain('安全敏感文件');
  });

  it('should include security for database files', () => {
    const characteristics = analyzeFileCharacteristics([createDiffFile('db/queries.sql')]);
    const result = selectAgentsByRules(characteristics);

    expect(result.agents).toContain('security-reviewer');
    expect(result.agents).toContain('logic-reviewer');
    expect(result.agents).toContain('performance-reviewer');
  });

  it('should include security for template files (XSS risk)', () => {
    const characteristics = analyzeFileCharacteristics([createDiffFile('views/page.html')]);
    const result = selectAgentsByRules(characteristics);

    expect(result.agents).toContain('security-reviewer');
    expect(result.reasons['security-reviewer']).toContain('XSS');
  });

  it('should have lower confidence for docs-only changes', () => {
    const characteristics = analyzeFileCharacteristics([
      createDiffFile('README.md', 'data'),
      createDiffFile('docs/guide.md', 'data'),
    ]);
    const result = selectAgentsByRules(characteristics);

    expect(result.confidence).toBeLessThan(0.8);
  });

  it('should have lower confidence for mixed file types', () => {
    const characteristics = analyzeFileCharacteristics([
      createDiffFile('src/index.ts'),
      createDiffFile('styles/main.css'),
      createDiffFile('README.md', 'data'),
      createDiffFile('package.json', 'config'),
    ]);
    // Manually set multiple categories
    characteristics.categories.add('source');
    characteristics.categories.add('data');
    characteristics.categories.add('config');

    const result = selectAgentsByRules(characteristics);

    expect(result.confidence).toBeLessThanOrEqual(0.8);
  });
});

describe('selectAgents', () => {
  it('should return empty agents for empty diff', async () => {
    const result = await selectAgents([]);

    expect(result.agents).toHaveLength(0);
    expect(result.usedLLM).toBe(false);
    expect(result.confidence).toBe(1.0);
  });

  it('should use rule-based selection for clear cases', async () => {
    const files = [createDiffFile('src/index.ts'), createDiffFile('src/utils.ts')];
    const result = await selectAgents(files, { disableLLM: true });

    expect(result.usedLLM).toBe(false);
    expect(result.agents.length).toBeGreaterThan(0);
  });

  it('should respect forced agents', async () => {
    const files = [createDiffFile('src/index.ts')];
    const result = await selectAgents(files, {
      forceAgents: ['security-reviewer'],
    });

    expect(result.agents).toEqual(['security-reviewer']);
    expect(result.usedLLM).toBe(false);
    expect(result.confidence).toBe(1.0);
  });

  it('should skip LLM when disableLLM is true', async () => {
    const files = [createDiffFile('README.md', 'data')];
    const result = await selectAgents(files, { disableLLM: true });

    expect(result.usedLLM).toBe(false);
  });

  it('should handle mixed file types correctly', async () => {
    const files = [
      createDiffFile('src/auth/login.ts'),
      createDiffFile('src/styles/auth.css'),
      createDiffFile('README.md', 'data'),
    ];
    const result = await selectAgents(files, { disableLLM: true });

    // Should include security due to auth file
    expect(result.agents).toContain('security-reviewer');
    // Should include logic due to source code
    expect(result.agents).toContain('logic-reviewer');
    // Should include style due to CSS and source
    expect(result.agents).toContain('style-reviewer');
  });
});

describe('Edge cases', () => {
  it('should handle generated files', () => {
    const files = [
      createDiffFile('dist/bundle.js', 'generated'),
      createDiffFile('build/index.js', 'generated'),
    ];
    const characteristics = analyzeFileCharacteristics(files);
    const result = selectAgentsByRules(characteristics);

    // Generated files have .js extension so hasSourceCode is true,
    // but the category is 'generated' so fewer agents may be needed
    expect(characteristics.categories.has('generated')).toBe(true);
    // Should still include agents since these are JS files
    expect(result.agents.length).toBeGreaterThan(0);
  });

  it('should handle lock files', () => {
    const files = [
      createDiffFile('package-lock.json', 'lock'),
      createDiffFile('yarn.lock', 'lock'),
    ];
    const characteristics = analyzeFileCharacteristics(files);
    const result = selectAgentsByRules(characteristics);

    // Lock files alone shouldn't trigger any agents
    expect(result.agents).not.toContain('logic-reviewer');
    expect(result.agents).not.toContain('performance-reviewer');
  });

  it('should handle Vue/Svelte files as source code', () => {
    const files = [createDiffFile('src/App.vue'), createDiffFile('src/components/Button.svelte')];
    const characteristics = analyzeFileCharacteristics(files);

    expect(characteristics.hasSourceCode).toBe(true);
  });

  it('should handle Python files', () => {
    const files = [createDiffFile('app/main.py'), createDiffFile('tests/test_main.py')];
    const characteristics = analyzeFileCharacteristics(files);

    expect(characteristics.hasSourceCode).toBe(true);
    expect(characteristics.hasTests).toBe(true);
  });

  it('should handle Go files', () => {
    const files = [createDiffFile('main.go'), createDiffFile('main_test.go')];
    const characteristics = analyzeFileCharacteristics(files);

    expect(characteristics.hasSourceCode).toBe(true);
    expect(characteristics.hasTests).toBe(true);
  });

  it('should handle Rust files', () => {
    const files = [createDiffFile('src/main.rs'), createDiffFile('src/lib.rs')];
    const characteristics = analyzeFileCharacteristics(files);

    expect(characteristics.hasSourceCode).toBe(true);
  });
});
