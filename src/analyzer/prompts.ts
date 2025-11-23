/**
 * Prompt templates for diff analysis
 */

/**
 * System prompt for the diff analyzer
 */
export const DIFF_ANALYSIS_SYSTEM_PROMPT = `You are a code change analyzer. You analyze git diffs and extract detailed semantic information.

Your task:
1. Identify which files were modified
2. Extract SPECIFIC changes: which interfaces/types changed, which functions changed, what parameters were added/removed
3. Assess risk level based on change type

Risk Level Rules:
- HIGH: Changes to exported function/component signatures, interface/type definitions, breaking API changes
- MEDIUM: Internal logic changes, non-exported function modifications, implementation details
- LOW: Comments, formatting, styling, documentation, default value changes only

Be SPECIFIC - always include the exact names of changed interfaces, functions, and parameters.
Output ONLY valid JSON, no explanations or markdown.`;

/**
 * Build user prompt with diff content
 */
export function buildUserPrompt(diffs: string): string {
  return `Analyze the following git diff and output JSON:

\`\`\`diff
${diffs}
\`\`\`

Output Format (JSON only, no markdown):
{
  "changes": [
    {
      "file_path": "path/to/file.ts",
      "risk_level": "HIGH" | "MEDIUM" | "LOW",
      "semantic_hints": {
        "interfaces": [
          {
            "name": "InterfaceName",
            "added_fields": ["fieldName1"],
            "removed_fields": [],
            "modified_fields": []
          }
        ],
        "functions": [
          {
            "name": "functionName",
            "change_type": "signature" | "implementation" | "new" | "deleted",
            "added_params": ["paramName"],
            "removed_params": [],
            "is_exported": true
          }
        ],
        "exports": {
          "added": ["exportName"],
          "removed": []
        },
        "summary": "Brief description of what changed"
      }
    }
  ]
}

Rules:
- For React components, treat them as functions
- Include ALL changed interfaces and functions by name
- "signature" means parameters or return type changed
- "implementation" means only internal logic changed
- Omit empty arrays, but always include at least one of: interfaces, functions, or summary`;
}
