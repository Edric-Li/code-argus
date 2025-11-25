/**
 * Local Diff Analyzer
 *
 * Fast, rule-based analysis without LLM calls.
 * Provides quick risk assessment and basic summaries.
 */

import type { DiffFile } from '../git/parser.js';
import type { AnalysisResult, ChangeAnalysis, RiskLevel } from './types.js';

/**
 * Patterns that indicate high-risk changes
 */
const HIGH_RISK_PATTERNS = [
  // Export changes
  /^[+-]\s*export\s+(default\s+)?(function|class|const|let|var|interface|type)/m,
  // Public API changes
  /^[+-]\s*public\s+/m,
  // Security-related
  /^[+-].*(?:password|secret|token|apikey|api_key|credential|auth)/im,
  // Database/SQL
  /^[+-].*(?:DELETE|DROP|TRUNCATE|ALTER\s+TABLE)/im,
  // Package.json dependencies
  /^[+-]\s*"(?:dependencies|devDependencies|peerDependencies)"/m,
];

/**
 * Patterns that indicate medium-risk changes
 */
const MEDIUM_RISK_PATTERNS = [
  // Function/method changes
  /^[+-]\s*(?:async\s+)?(?:function|const|let|var)\s+\w+\s*[=(]/m,
  // Class method changes
  /^[+-]\s*(?:private|protected|static|async)?\s*\w+\s*\([^)]*\)\s*[:{]/m,
  // Interface/type changes
  /^[+-]\s*(?:interface|type)\s+\w+/m,
  // Import changes
  /^[+-]\s*import\s+/m,
  // Error handling
  /^[+-].*(?:throw|catch|try)\s/m,
];

/**
 * Generate a brief summary based on diff content
 */
function generateSummary(content: string, type: 'add' | 'delete' | 'modify'): string {
  const lines = content.split('\n');
  const addedLines = lines.filter((l) => l.startsWith('+')).length;
  const removedLines = lines.filter((l) => l.startsWith('-')).length;

  // Check for specific patterns
  if (/export\s+(default\s+)?function/.test(content)) {
    return 'Exported function changes';
  }
  if (/export\s+(default\s+)?class/.test(content)) {
    return 'Exported class changes';
  }
  if (/interface\s+\w+/.test(content)) {
    return 'Interface definition changes';
  }
  if (/type\s+\w+\s*=/.test(content)) {
    return 'Type definition changes';
  }

  if (type === 'add') {
    return `New file (+${addedLines} lines)`;
  }
  if (type === 'delete') {
    return `File deleted (-${removedLines} lines)`;
  }

  return `Modified (+${addedLines}/-${removedLines} lines)`;
}

/**
 * Assess risk level based on diff content
 */
function assessRiskLevel(content: string, filePath: string): RiskLevel {
  // Config files are often high risk
  const configFiles = ['package.json', 'tsconfig.json', '.env', 'webpack.config', 'vite.config'];
  if (configFiles.some((cf) => filePath.includes(cf))) {
    return 'HIGH';
  }

  // Check high-risk patterns
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(content)) {
      return 'HIGH';
    }
  }

  // Check medium-risk patterns
  for (const pattern of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(content)) {
      return 'MEDIUM';
    }
  }

  return 'LOW';
}

/**
 * Local Diff Analyzer
 *
 * Performs fast, rule-based analysis without LLM calls.
 */
export class LocalDiffAnalyzer {
  /**
   * Analyze diff files using local rules
   */
  analyze(files: DiffFile[]): AnalysisResult {
    const changes: ChangeAnalysis[] = [];

    for (const file of files) {
      // Skip non-analyzable files
      if (file.category === 'lock' || file.category === 'asset' || file.category === 'generated') {
        continue;
      }

      const riskLevel = assessRiskLevel(file.content, file.path);
      const summary = generateSummary(file.content, file.type);

      changes.push({
        file_path: file.path,
        risk_level: riskLevel,
        semantic_hints: {
          summary,
        },
      });
    }

    return {
      changes,
      metadata: {
        total_files: files.length,
        analyzed_files: changes.length,
        skipped_files: files.length - changes.length,
        batches: 0,
        total_tokens: 0,
      },
    };
  }
}

/**
 * Create a local diff analyzer instance
 */
export function createLocalDiffAnalyzer(): LocalDiffAnalyzer {
  return new LocalDiffAnalyzer();
}
