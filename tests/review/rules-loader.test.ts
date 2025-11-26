import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadRules,
  getRulesForAgent,
  rulesToPromptText,
  isEmptyRules,
  EMPTY_RULES_CONFIG,
  RULES_FILE_NAMES,
} from '../../src/review/rules/index.js';

describe('Rules Loader', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for tests
    testDir = join(tmpdir(), `argus-rules-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadRules', () => {
    it('should return empty config for empty array', async () => {
      const rules = await loadRules([]);
      expect(rules).toEqual(EMPTY_RULES_CONFIG);
    });

    it('should return empty config for non-existent directory', async () => {
      const rules = await loadRules(['/non/existent/path']);
      expect(isEmptyRules(rules)).toBe(true);
    });

    it('should load global.md file', async () => {
      const globalContent = '# Global Rules\n\n- Rule 1\n- Rule 2';
      await writeFile(join(testDir, 'global.md'), globalContent);

      const rules = await loadRules([testDir]);

      expect(rules.global).toBe(globalContent);
      expect(rules.sources).toContain(testDir);
    });

    it('should load agent-specific rules', async () => {
      const securityContent = '# Security Rules\n\n- Check for SQL injection';
      const logicContent = '# Logic Rules\n\n- Validate error handling';

      await writeFile(join(testDir, 'security.md'), securityContent);
      await writeFile(join(testDir, 'logic.md'), logicContent);

      const rules = await loadRules([testDir]);

      expect(rules.agents['security-reviewer']).toBe(securityContent);
      expect(rules.agents['logic-reviewer']).toBe(logicContent);
      expect(rules.agents['style-reviewer']).toBeUndefined();
    });

    it('should load checklist.yaml file', async () => {
      const checklistContent = `
- id: custom-01
  category: security
  question: Is JWT token validated?
- id: custom-02
  category: logic
  question: Are edge cases handled?
`;
      await writeFile(join(testDir, 'checklist.yaml'), checklistContent);

      const rules = await loadRules([testDir]);

      expect(rules.checklist).toHaveLength(2);
      expect(rules.checklist[0]).toEqual({
        id: 'custom-01',
        category: 'security',
        question: 'Is JWT token validated?',
      });
    });

    it('should merge multiple directories', async () => {
      const dir1 = join(testDir, 'team');
      const dir2 = join(testDir, 'project');
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });

      await writeFile(join(dir1, 'global.md'), 'Team global rules');
      await writeFile(join(dir1, 'security.md'), 'Team security rules');
      await writeFile(join(dir2, 'global.md'), 'Project global rules');
      await writeFile(join(dir2, 'logic.md'), 'Project logic rules');

      const rules = await loadRules([dir1, dir2]);

      // Global should be merged with separator
      expect(rules.global).toContain('Team global rules');
      expect(rules.global).toContain('Project global rules');
      expect(rules.global).toContain('---'); // Separator

      // Agent rules should be from respective dirs
      expect(rules.agents['security-reviewer']).toBe('Team security rules');
      expect(rules.agents['logic-reviewer']).toBe('Project logic rules');

      // Sources should include both
      expect(rules.sources).toHaveLength(2);
    });

    it('should handle invalid checklist entries gracefully', async () => {
      const checklistContent = `
- id: valid-01
  category: security
  question: Valid question?
- invalid: entry
- id: missing-category
  question: No category
- id: valid-02
  category: logic
  question: Another valid question?
`;
      await writeFile(join(testDir, 'checklist.yaml'), checklistContent);

      const rules = await loadRules([testDir]);

      // Only valid entries should be included
      expect(rules.checklist).toHaveLength(2);
      expect(rules.checklist[0]?.id).toBe('valid-01');
      expect(rules.checklist[1]?.id).toBe('valid-02');
    });
  });

  describe('getRulesForAgent', () => {
    it('should return undefined for empty rules', () => {
      const result = getRulesForAgent(EMPTY_RULES_CONFIG, 'security-reviewer');
      expect(result).toBeUndefined();
    });

    it('should return global rules only when no agent-specific rules', async () => {
      await writeFile(join(testDir, 'global.md'), 'Global guidelines');
      const rules = await loadRules([testDir]);

      const result = getRulesForAgent(rules, 'security-reviewer');

      expect(result).toContain('Global Review Guidelines');
      expect(result).toContain('Global guidelines');
    });

    it('should combine global and agent-specific rules', async () => {
      await writeFile(join(testDir, 'global.md'), 'Global guidelines');
      await writeFile(join(testDir, 'security.md'), 'Security specific rules');
      const rules = await loadRules([testDir]);

      const result = getRulesForAgent(rules, 'security-reviewer');

      expect(result).toContain('Global Review Guidelines');
      expect(result).toContain('Global guidelines');
      expect(result).toContain('Security Review Specific Guidelines');
      expect(result).toContain('Security specific rules');
    });

    it('should return agent-specific rules only when no global rules', async () => {
      await writeFile(join(testDir, 'logic.md'), 'Logic specific rules');
      const rules = await loadRules([testDir]);

      const result = getRulesForAgent(rules, 'logic-reviewer');

      expect(result).not.toContain('Global');
      expect(result).toContain('Logic Review Specific Guidelines');
      expect(result).toContain('Logic specific rules');
    });
  });

  describe('rulesToPromptText', () => {
    it('should return empty string for empty rules', () => {
      const result = rulesToPromptText(EMPTY_RULES_CONFIG);
      expect(result).toBe('');
    });

    it('should format rules for specific agent', async () => {
      await writeFile(join(testDir, 'security.md'), 'Security rules');
      const rules = await loadRules([testDir]);

      const result = rulesToPromptText(rules, 'security-reviewer');

      expect(result).toContain('Project-Specific Review Guidelines');
      expect(result).toContain('Loaded from:');
      expect(result).toContain('Security rules');
    });

    it('should format all rules when no agent specified', async () => {
      await writeFile(join(testDir, 'global.md'), 'Global rules');
      await writeFile(join(testDir, 'security.md'), 'Security rules');
      const rules = await loadRules([testDir]);

      const result = rulesToPromptText(rules);

      expect(result).toContain('Project-Specific Review Guidelines');
      expect(result).toContain('Global Guidelines');
      expect(result).toContain('Security Review Guidelines');
    });
  });

  describe('isEmptyRules', () => {
    it('should return true for empty config', () => {
      expect(isEmptyRules(EMPTY_RULES_CONFIG)).toBe(true);
    });

    it('should return false when global rules exist', async () => {
      await writeFile(join(testDir, 'global.md'), 'Some rules');
      const rules = await loadRules([testDir]);
      expect(isEmptyRules(rules)).toBe(false);
    });

    it('should return false when agent rules exist', async () => {
      await writeFile(join(testDir, 'style.md'), 'Style rules');
      const rules = await loadRules([testDir]);
      expect(isEmptyRules(rules)).toBe(false);
    });

    it('should return false when checklist exists', async () => {
      const checklistContent = `
- id: test-01
  category: security
  question: Test?
`;
      await writeFile(join(testDir, 'checklist.yaml'), checklistContent);
      const rules = await loadRules([testDir]);
      expect(isEmptyRules(rules)).toBe(false);
    });
  });

  describe('RULES_FILE_NAMES', () => {
    it('should have correct file name mappings', () => {
      expect(RULES_FILE_NAMES.global).toBe('global.md');
      expect(RULES_FILE_NAMES.agents['security-reviewer']).toBe('security.md');
      expect(RULES_FILE_NAMES.agents['logic-reviewer']).toBe('logic.md');
      expect(RULES_FILE_NAMES.agents['style-reviewer']).toBe('style.md');
      expect(RULES_FILE_NAMES.agents['performance-reviewer']).toBe('performance.md');
      expect(RULES_FILE_NAMES.checklist).toBe('checklist.yaml');
    });
  });
});
