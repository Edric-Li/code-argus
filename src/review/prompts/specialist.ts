/**
 * Specialist Agent Prompt Builders
 *
 * Builds prompts for each specialized review agent.
 */

import type { AgentType, ProjectStandards } from '../types.js';
import type { ChangeAnalysis } from '../../analyzer/types.js';

/**
 * Context passed to specialist agents
 */
export interface SpecialistContext {
  /** Raw diff content */
  diff: string;
  /** File change analyses */
  fileAnalyses: ChangeAnalysis[];
  /** Project standards (as prompt text) */
  standardsText: string;
  /** Project-specific rules (optional) */
  projectRules?: string;
}

/**
 * Build the user prompt for a specialist agent
 */
export function buildSpecialistPrompt(agentType: AgentType, context: SpecialistContext): string {
  const sections: string[] = [];

  // Project Standards
  if (context.standardsText) {
    sections.push(context.standardsText);
    sections.push('');
  }

  // File Analysis Summary
  if (context.fileAnalyses.length > 0) {
    sections.push('## Changed Files Summary\n');
    for (const analysis of context.fileAnalyses) {
      const riskBadge =
        analysis.risk_level === 'HIGH'
          ? '[HIGH RISK]'
          : analysis.risk_level === 'MEDIUM'
            ? '[MEDIUM]'
            : '';
      sections.push(`- \`${analysis.file_path}\` ${riskBadge}`);
      if (analysis.semantic_hints?.summary) {
        sections.push(`  - ${analysis.semantic_hints.summary}`);
      }
    }
    sections.push('');
  }

  // Focus areas based on agent type
  sections.push(getAgentFocusInstructions(agentType));
  sections.push('');

  // Project-specific rules (if provided)
  if (context.projectRules) {
    sections.push(context.projectRules);
    sections.push('');
  }

  // The diff
  sections.push('## Code Changes (Diff)\n');
  sections.push('```diff');
  sections.push(context.diff);
  sections.push('```');
  sections.push('');

  // Task instruction
  sections.push('## Your Task\n');
  sections.push(
    'Analyze the code changes above and identify issues within your specialty area. ' +
      'Use the Read tool to get full file context when needed. ' +
      'Output your findings as valid JSON following the format in your instructions.'
  );

  return sections.join('\n');
}

/**
 * Get focus instructions based on agent type
 */
function getAgentFocusInstructions(agentType: AgentType): string {
  switch (agentType) {
    case 'security-reviewer':
      return `## Focus Priority

Based on the changes, pay special attention to:
1. Any code handling user input
2. Database queries and data access
3. Authentication/authorization logic
4. Credential or secret handling
5. External API interactions`;

    case 'logic-reviewer':
      return `## Focus Priority

Based on the changes, pay special attention to:
1. Error handling in async code
2. Null/undefined checks
3. Loop boundary conditions
4. Resource cleanup
5. State management`;

    case 'style-reviewer':
      return `## Focus Priority

Based on the changes, pay special attention to:
1. Naming consistency with existing code
2. Code organization and structure
3. Following project conventions
4. Readability improvements

## Over-Engineering Detection (过度设计检测)

**IMPORTANT**: Identify cases of over-engineering. Report these as issues with category "maintainability".

Signs of over-engineering to look for:
1. **Unnecessary abstraction**: Abstractions, wrappers, or helper functions used only once
2. **Premature generalization**: Designing for hypothetical future requirements that don't exist yet
3. **Pattern abuse**: Using design patterns (Factory, Strategy, etc.) where simple code would suffice
4. **Excessive configuration**: Too many config options for simple functionality
5. **Unused interfaces**: Defining interfaces, types, or functions that are not actually used
6. **Complex solutions for simple problems**: When 3 lines of straightforward code could replace 30 lines of "elegant" abstraction

When you find over-engineering:
- severity: "warning" or "suggestion"
- category: "maintainability"
- Explain why the simpler approach is better`;

    case 'performance-reviewer':
      return `## Focus Priority

Based on the changes, pay special attention to:
1. Database query patterns
2. Loop efficiency
3. Caching opportunities
4. Memory usage`;

    default:
      return '';
  }
}

/**
 * Build prompts for all specialist agents
 */
export function buildAllSpecialistPrompts(context: SpecialistContext): Map<AgentType, string> {
  const agents: AgentType[] = [
    'security-reviewer',
    'logic-reviewer',
    'style-reviewer',
    'performance-reviewer',
  ];

  const prompts = new Map<AgentType, string>();

  for (const agent of agents) {
    prompts.set(agent, buildSpecialistPrompt(agent, context));
  }

  return prompts;
}

/**
 * Context for validator agent
 */
export interface ValidatorContext {
  /** Issues to validate */
  issues: Array<{
    id: string;
    file: string;
    line_start: number;
    line_end: number;
    category: string;
    severity: string;
    title: string;
    description: string;
    code_snippet?: string;
    confidence: number;
  }>;
  /** Repository path for file access */
  repoPath: string;
}

/**
 * Build the user prompt for the validator agent
 */
export function buildValidatorPrompt(context: ValidatorContext): string {
  const sections: string[] = [];

  sections.push('## Issues to Validate\n');
  sections.push(`You have ${context.issues.length} issues to validate.\n`);
  sections.push(
    'For each issue, read the actual file and verify the issue exists at the reported location.\n'
  );

  sections.push('### Issues:\n');
  sections.push('```json');
  sections.push(JSON.stringify(context.issues, null, 2));
  sections.push('```\n');

  sections.push('## Your Task\n');
  sections.push('1. For each issue, use the Read tool to fetch the actual file content');
  sections.push('2. Verify the issue exists at the reported line numbers');
  sections.push('3. Check for any mitigating code that might handle the issue');
  sections.push('4. Output your validation results as JSON');
  sections.push(
    '5. **IMPORTANT**: Write all "related_context" and "reasoning" fields in Chinese\n'
  );

  sections.push('## Output Format\n');
  sections.push('```json');
  sections.push(`{
  "validated_issues": [
    {
      "original_id": "issue-id",
      "validation_status": "confirmed" | "rejected" | "uncertain",
      "final_confidence": 0.0-1.0,
      "grounding_evidence": {
        "checked_files": ["file1.ts", "file2.ts"],
        "checked_symbols": ["functionName", "className"],
        "related_context": "Description in Chinese of what you found",
        "reasoning": "Reasoning in Chinese for why you made this decision"
      }
    }
  ]
}`);
  sections.push('```');

  return sections.join('\n');
}

/**
 * Convert ProjectStandards to prompt text
 */
export function standardsToText(standards: ProjectStandards): string {
  const sections: string[] = [];

  sections.push('## Project Coding Standards\n');

  if (standards.typescript) {
    sections.push('### TypeScript');
    const ts = standards.typescript;
    if (ts.strict) sections.push('- Strict mode enabled');
    if (ts.noImplicitAny) sections.push('- No implicit any');
    if (ts.strictNullChecks) sections.push('- Strict null checks');
    if (ts.noUnusedLocals) sections.push('- No unused locals');
    if (ts.noUnusedParameters) sections.push('- No unused parameters');
    sections.push('');
  }

  if (standards.prettier) {
    sections.push('### Formatting');
    const p = standards.prettier;
    if (p.tabWidth) sections.push(`- Indentation: ${p.tabWidth} spaces`);
    if (p.semi !== undefined) sections.push(`- Semicolons: ${p.semi ? 'required' : 'none'}`);
    if (p.singleQuote !== undefined)
      sections.push(`- Quotes: ${p.singleQuote ? 'single' : 'double'}`);
    if (p.printWidth) sections.push(`- Max line width: ${p.printWidth}`);
    sections.push('');
  }

  if (standards.naming) {
    sections.push('### Naming Conventions');
    const n = standards.naming;
    if (n.files) sections.push(`- Files: ${n.files}`);
    if (n.functions) sections.push(`- Functions: ${n.functions}`);
    if (n.classes) sections.push(`- Classes: ${n.classes}`);
    if (n.constants) sections.push(`- Constants: ${n.constants}`);
    sections.push('');
  }

  return sections.join('\n');
}
