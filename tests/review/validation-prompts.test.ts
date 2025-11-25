import { describe, it, expect } from 'vitest';
import {
  buildValidationSystemPrompt,
  getValidationPromptConfig,
  VALIDATION_PROMPT_CONFIGS,
} from '../../src/review/prompts/validation.js';
import type { IssueCategory } from '../../src/review/types.js';

describe('Validation Prompts', () => {
  describe('VALIDATION_PROMPT_CONFIGS', () => {
    it('should have configs for all issue categories', () => {
      const categories: IssueCategory[] = [
        'style',
        'security',
        'logic',
        'performance',
        'maintainability',
      ];

      for (const category of categories) {
        expect(VALIDATION_PROMPT_CONFIGS[category]).toBeDefined();
        expect(VALIDATION_PROMPT_CONFIGS[category].category).toBe(category);
      }
    });

    it('should have validation focus for each category', () => {
      for (const config of Object.values(VALIDATION_PROMPT_CONFIGS)) {
        expect(config.validationFocus).toBeDefined();
        expect(config.validationFocus.length).toBeGreaterThan(0);
      }
    });

    it('should have rejection criteria for each category', () => {
      for (const config of Object.values(VALIDATION_PROMPT_CONFIGS)) {
        expect(config.rejectionCriteria).toBeDefined();
        expect(config.rejectionCriteria.length).toBeGreaterThan(0);
      }
    });

    it('should have additional system prompt for each category', () => {
      for (const config of Object.values(VALIDATION_PROMPT_CONFIGS)) {
        expect(config.additionalSystemPrompt).toBeDefined();
        expect(config.additionalSystemPrompt.length).toBeGreaterThan(0);
      }
    });
  });

  describe('buildValidationSystemPrompt', () => {
    it('should include base validation prompt', () => {
      const prompt = buildValidationSystemPrompt('security');
      // Should contain the base validation workflow
      expect(prompt).toContain('You are an expert code reviewer');
      expect(prompt).toContain('Validation workflow');
    });

    it('should include JSON format specification', () => {
      const prompt = buildValidationSystemPrompt('security');
      expect(prompt).toContain('validation_status');
      expect(prompt).toContain('grounding_evidence');
    });

    it('should include category-specific prompt for style', () => {
      const prompt = buildValidationSystemPrompt('style');
      expect(prompt).toContain('Style Issue Validation Rules');
      // Style-specific checks
      expect(prompt).toContain('Search similar files');
      expect(prompt).toContain('Check existing patterns');
    });

    it('should include category-specific prompt for security', () => {
      const prompt = buildValidationSystemPrompt('security');
      expect(prompt).toContain('Security Issue Validation Rules');
      // Security-specific checks
      expect(prompt).toContain('Trace data flow');
      expect(prompt).toContain('Check protection layers');
    });

    it('should include category-specific prompt for logic', () => {
      const prompt = buildValidationSystemPrompt('logic');
      expect(prompt).toContain('Logic Issue Validation Rules');
      // Logic-specific checks
      expect(prompt).toContain('Check tests');
      expect(prompt).toContain('Trace call chain');
    });

    it('should include category-specific prompt for performance', () => {
      const prompt = buildValidationSystemPrompt('performance');
      expect(prompt).toContain('Performance Issue Validation Rules');
      // Performance-specific checks
      expect(prompt).toContain('Analyze call frequency');
      expect(prompt).toContain('Check caching');
    });

    it('should include category-specific prompt for maintainability', () => {
      const prompt = buildValidationSystemPrompt('maintainability');
      expect(prompt).toContain('Maintainability Issue Validation Rules');
    });

    it('should produce different prompts for different categories', () => {
      const stylePrompt = buildValidationSystemPrompt('style');
      const securityPrompt = buildValidationSystemPrompt('security');
      const logicPrompt = buildValidationSystemPrompt('logic');

      // Should all have the base validation rules
      expect(stylePrompt).toContain('You are an expert code reviewer');
      expect(securityPrompt).toContain('You are an expert code reviewer');
      expect(logicPrompt).toContain('You are an expert code reviewer');

      // But should have different category-specific content
      expect(stylePrompt).not.toContain('Security Issue Validation Rules');
      expect(securityPrompt).not.toContain('Style Issue Validation Rules');
      expect(logicPrompt).not.toContain('Performance Issue Validation Rules');
    });
  });

  describe('getValidationPromptConfig', () => {
    it('should return correct config for each category', () => {
      expect(getValidationPromptConfig('style').category).toBe('style');
      expect(getValidationPromptConfig('security').category).toBe('security');
      expect(getValidationPromptConfig('logic').category).toBe('logic');
      expect(getValidationPromptConfig('performance').category).toBe('performance');
      expect(getValidationPromptConfig('maintainability').category).toBe('maintainability');
    });
  });

  describe('Style validation specific rules', () => {
    it('should emphasize checking existing patterns in project', () => {
      const config = getValidationPromptConfig('style');
      expect(config.validationFocus).toContain(
        'Check if the reported style matches existing project patterns'
      );
    });

    it('should have rejection criteria for project conventions', () => {
      const config = getValidationPromptConfig('style');
      expect(config.rejectionCriteria).toContain(
        'The problematic style is already widely used in the project (3+ instances)'
      );
    });
  });

  describe('Security validation specific rules', () => {
    it('should emphasize checking attack paths', () => {
      const config = getValidationPromptConfig('security');
      expect(config.validationFocus).toContain(
        'Check if security middleware or protective measures exist'
      );
    });

    it('should have rejection criteria for protected code paths', () => {
      const config = getValidationPromptConfig('security');
      expect(config.rejectionCriteria.some((r) => r.includes('validated/sanitized'))).toBe(true);
    });
  });
});
