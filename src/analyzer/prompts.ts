/**
 * Prompt templates for diff analysis
 */

import { loadDiffAnalyzerSystemTemplate } from '../review/prompts/template-loader.js';

/**
 * System prompt for the diff analyzer
 * Loaded from template file for easier maintenance
 */
export const DIFF_ANALYSIS_SYSTEM_PROMPT = loadDiffAnalyzerSystemTemplate();

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
