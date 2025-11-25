/**
 * Diff Analyzer
 * Analyzes git diffs using LLM to extract semantic changes and risk levels
 */

import type { DiffFile } from '../git/parser.js';
import { llm, type ChatResponse } from '../llm/index.js';
import { withRetry, withConcurrency } from '../utils/index.js';
import {
  type AnalysisResult,
  type ChangeAnalysis,
  type LLMAnalysisResponse,
  type DiffAnalyzerConfig,
  DEFAULT_ANALYZER_CONFIG,
} from './types.js';
import { DIFF_ANALYSIS_SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
import { extractJSON } from '../review/utils/json-parser.js';

/**
 * Batch of files to analyze together
 */
interface FileBatch {
  files: DiffFile[];
  estimatedTokens: number;
}

/**
 * DiffAnalyzer class
 * Analyzes git diffs using LLM with batching and concurrency control
 */
export class DiffAnalyzer {
  private config: DiffAnalyzerConfig;

  constructor(config: Partial<DiffAnalyzerConfig> = {}) {
    this.config = { ...DEFAULT_ANALYZER_CONFIG, ...config };
  }

  /**
   * Analyze diff files and return semantic analysis
   *
   * @param files - Array of parsed diff files
   * @returns Analysis result with changes and metadata
   */
  async analyze(files: DiffFile[]): Promise<AnalysisResult> {
    // Step 1: Filter analyzable files
    const { analyzable, skipped } = this.filterAnalyzableFiles(files);

    if (analyzable.length === 0) {
      return {
        changes: [],
        metadata: {
          total_files: files.length,
          analyzed_files: 0,
          skipped_files: skipped.length,
          batches: 0,
          total_tokens: 0,
        },
      };
    }

    // Step 2: Create batches based on token limits
    const batches = this.createBatches(analyzable);

    // Step 3: Analyze batches with concurrency control
    const batchTasks = batches.map((batch) => () => this.analyzeBatchWithRetry(batch));

    const batchResults = await withConcurrency(batchTasks, this.config.maxConcurrency);

    // Step 4: Merge results
    const allChanges: ChangeAnalysis[] = [];
    let totalTokens = 0;

    for (const result of batchResults) {
      allChanges.push(...result.changes);
      totalTokens += result.tokens;
    }

    return {
      changes: allChanges,
      metadata: {
        total_files: files.length,
        analyzed_files: analyzable.length,
        skipped_files: skipped.length,
        batches: batches.length,
        total_tokens: totalTokens,
      },
    };
  }

  /**
   * Filter files that should be analyzed
   * Skips lock, asset, and generated files
   */
  private filterAnalyzableFiles(files: DiffFile[]): {
    analyzable: DiffFile[];
    skipped: DiffFile[];
  } {
    const analyzable: DiffFile[] = [];
    const skipped: DiffFile[] = [];

    for (const file of files) {
      if (file.category === 'lock' || file.category === 'asset' || file.category === 'generated') {
        skipped.push(file);
      } else {
        analyzable.push(file);
      }
    }

    return { analyzable, skipped };
  }

  /**
   * Estimate token count for content
   * Rough estimate: 1 character ≈ 0.35 tokens for code
   */
  private estimateTokens(content: string): number {
    return Math.ceil(content.length * 0.35);
  }

  /**
   * Create batches of files based on token limits
   */
  private createBatches(files: DiffFile[]): FileBatch[] {
    const batches: FileBatch[] = [];
    let currentBatch: FileBatch = { files: [], estimatedTokens: 0 };

    // Reserve tokens for system prompt and output
    const reservedTokens = 3000;
    const maxContentTokens = this.config.maxTokensPerBatch - reservedTokens;

    for (const file of files) {
      const fileTokens = this.estimateTokens(file.content);

      // If single file exceeds limit, put it in its own batch
      if (fileTokens > maxContentTokens) {
        // If current batch has files, push it first
        if (currentBatch.files.length > 0) {
          batches.push(currentBatch);
          currentBatch = { files: [], estimatedTokens: 0 };
        }
        // Add oversized file as its own batch
        batches.push({ files: [file], estimatedTokens: fileTokens });
        continue;
      }

      // If adding this file would exceed limit, start new batch
      if (currentBatch.estimatedTokens + fileTokens > maxContentTokens) {
        if (currentBatch.files.length > 0) {
          batches.push(currentBatch);
        }
        currentBatch = { files: [], estimatedTokens: 0 };
      }

      currentBatch.files.push(file);
      currentBatch.estimatedTokens += fileTokens;
    }

    // Don't forget the last batch
    if (currentBatch.files.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /**
   * Build diff content string from files
   */
  private buildDiffContent(files: DiffFile[]): string {
    return files
      .map((file) => {
        const header = `=== File: ${file.path} (${file.type}) ===`;
        return `${header}\n${file.content}`;
      })
      .join('\n\n');
  }

  /**
   * Analyze a single batch with retry logic
   */
  private async analyzeBatchWithRetry(
    batch: FileBatch
  ): Promise<{ changes: ChangeAnalysis[]; tokens: number }> {
    return withRetry(
      () => this.analyzeBatch(batch),
      this.config.maxRetries,
      this.config.retryDelayMs
    );
  }

  /**
   * Analyze a single batch of files
   */
  private async analyzeBatch(
    batch: FileBatch
  ): Promise<{ changes: ChangeAnalysis[]; tokens: number }> {
    const diffContent = this.buildDiffContent(batch.files);
    const userPrompt = buildUserPrompt(diffContent);

    const response: ChatResponse = await llm.chatWithMetadata(
      DIFF_ANALYSIS_SYSTEM_PROMPT,
      userPrompt
    );

    // Parse response as JSON
    const parsed = this.parseResponse(response.content, batch.files);

    return {
      changes: parsed,
      tokens: response.metadata.totalTokens ?? 0,
    };
  }

  /**
   * Parse LLM response into structured analysis
   */
  private parseResponse(content: string, batchFiles: DiffFile[]): ChangeAnalysis[] {
    try {
      // Use robust JSON extraction with repair capabilities
      const jsonStr = extractJSON(content);
      if (!jsonStr) {
        throw new Error('No JSON found in response');
      }

      const parsed: LLMAnalysisResponse = JSON.parse(jsonStr);

      // Validate and normalize the response
      if (!parsed.changes || !Array.isArray(parsed.changes)) {
        throw new Error('Invalid response format: missing changes array');
      }

      // Ensure all files in batch have analysis
      const analyzedPaths = new Set(parsed.changes.map((c) => c.file_path));
      const batchPaths = new Set(batchFiles.map((f) => f.path));

      // Add default analysis for any missing files
      for (const file of batchFiles) {
        if (!analyzedPaths.has(file.path)) {
          parsed.changes.push({
            file_path: file.path,
            risk_level: 'LOW',
            semantic_hints: {
              summary: 'No significant changes detected',
            },
          });
        }
      }

      // Filter out any files not in the batch (hallucinations)
      return parsed.changes.filter((c) => batchPaths.has(c.file_path));
    } catch (error) {
      // If parsing fails, return default analysis for all files
      console.error('Failed to parse LLM response:', error);
      return batchFiles.map((file) => ({
        file_path: file.path,
        risk_level: 'MEDIUM' as const,
        semantic_hints: {
          summary: 'Unable to analyze - parse error',
        },
      }));
    }
  }
}

/**
 * Create a diff analyzer with default configuration
 */
export function createDiffAnalyzer(config?: Partial<DiffAnalyzerConfig>): DiffAnalyzer {
  return new DiffAnalyzer(config);
}
