/**
 * Streaming Issue Collector
 *
 * Manages real-time issue collection with validation.
 * Agents report issues via MCP tool, and this collector handles:
 * 1. Async validation (non-blocking)
 * 2. Real-time status updates
 */

import type { RawIssue, ValidatedIssue, AgentType, ValidationStrategyConfig } from './types.js';
import { DEFAULT_VALIDATION_STRATEGIES } from './types.js';
import { createValidator, type IssueValidator } from './validator.js';
import { DEFAULT_VALIDATION_CONCURRENCY } from './constants.js';

/**
 * Issue report from an agent
 */
export interface IssueReport {
  file: string;
  line_start: number;
  line_end: number;
  severity: 'critical' | 'error' | 'warning' | 'suggestion';
  category: 'security' | 'logic' | 'performance' | 'style' | 'maintainability';
  title: string;
  description: string;
  suggestion?: string;
  code_snippet?: string;
  confidence: number;
}

/**
 * Result of reporting an issue
 */
export interface ReportResult {
  status: 'accepted' | 'error';
  issue_id?: string;
  message: string;
}

/**
 * Collector options
 */
export interface IssueCollectorOptions {
  repoPath: string;
  verbose?: boolean;
  skipValidation?: boolean;
  /** Custom validation strategies per agent type */
  validationStrategies?: Partial<Record<AgentType, ValidationStrategyConfig>>;
  /** Callback when a new issue is received (before validation) */
  onIssueReceived?: (issue: RawIssue) => void;
  /** Callback when an issue is validated */
  onIssueValidated?: (issue: ValidatedIssue) => void;
  /** Callback for status updates */
  onStatusUpdate?: (message: string) => void;
}

/**
 * Collector statistics
 */
export interface CollectorStats {
  totalReported: number;
  validated: number;
  validationPending: number;
  tokensUsed: number;
}

/**
 * Streaming Issue Collector
 *
 * Provides a central point for agents to report issues in real-time.
 */
export class IssueCollector {
  private options: Required<
    Omit<
      IssueCollectorOptions,
      'validationStrategies' | 'onIssueReceived' | 'onIssueValidated' | 'onStatusUpdate'
    >
  > &
    Pick<
      IssueCollectorOptions,
      'validationStrategies' | 'onIssueReceived' | 'onIssueValidated' | 'onStatusUpdate'
    >;

  private validator: IssueValidator;

  // Validation strategies (merged with defaults)
  private validationStrategies: Record<AgentType, ValidationStrategyConfig>;

  // Issue storage
  private rawIssues: Map<string, RawIssue> = new Map();
  private validatedIssues: Map<string, ValidatedIssue> = new Map();

  // Validation queue (for immediate validation)
  private validationQueue: Set<string> = new Set();
  private validationPromises: Map<string, Promise<ValidatedIssue>> = new Map();
  private pendingValidations: Array<() => Promise<void>> = [];
  private activeValidations = 0;
  private maxConcurrentValidations = DEFAULT_VALIDATION_CONCURRENCY;

  // Batch buffers (for batch-on-agent-complete strategy)
  private batchBuffers: Map<AgentType, RawIssue[]> = new Map();

  // Stats
  private stats: CollectorStats = {
    totalReported: 0,
    validated: 0,
    validationPending: 0,
    tokensUsed: 0,
  };

  // Issue ID counter
  private issueCounter = 0;

  constructor(options: IssueCollectorOptions) {
    this.options = {
      verbose: false,
      skipValidation: false,
      ...options,
    };

    // Merge custom strategies with defaults
    this.validationStrategies = {
      ...DEFAULT_VALIDATION_STRATEGIES,
      ...options.validationStrategies,
    };

    this.validator = createValidator({
      repoPath: options.repoPath,
      verbose: options.verbose,
    });
  }

  /**
   * Report a new issue from an agent
   *
   * This is the main entry point called by agents via MCP tool.
   * Validation strategy depends on the agent type:
   * - 'immediate': Start validation right away (default for most agents)
   * - 'batch-on-agent-complete': Buffer issues until agent completes, then batch validate
   */
  async reportIssue(report: IssueReport, sourceAgent: AgentType): Promise<ReportResult> {
    this.stats.totalReported++;

    // Generate unique ID
    const issueId = this.generateIssueId(sourceAgent);

    // Create raw issue
    const rawIssue: RawIssue = {
      id: issueId,
      file: report.file,
      line_start: report.line_start,
      line_end: report.line_end,
      category: report.category,
      severity: report.severity,
      title: report.title,
      description: report.description,
      suggestion: report.suggestion,
      code_snippet: report.code_snippet,
      confidence: report.confidence,
      source_agent: sourceAgent,
    };

    if (this.options.verbose) {
      console.log(`[Collector] Issue reported: ${issueId} - ${report.title}`);
    }

    // Store the raw issue
    this.rawIssues.set(issueId, rawIssue);

    // Notify about new issue received
    this.options.onIssueReceived?.(rawIssue);

    // Determine validation approach based on strategy
    if (this.options.skipValidation) {
      // Skip validation, mark as validated immediately
      const validatedIssue: ValidatedIssue = {
        ...rawIssue,
        validation_status: 'pending',
        grounding_evidence: {
          checked_files: [],
          checked_symbols: [],
          related_context: '',
          reasoning: 'Validation skipped',
        },
        final_confidence: rawIssue.confidence,
      };
      this.validatedIssues.set(issueId, validatedIssue);
      this.stats.validated++;
      this.options.onIssueValidated?.(validatedIssue);
    } else {
      const strategy = this.validationStrategies[sourceAgent];

      if (strategy.strategy === 'batch-on-agent-complete') {
        // Buffer issue for batch validation later
        this.addToBatchBuffer(sourceAgent, rawIssue);
      } else {
        // Start async validation immediately (non-blocking)
        this.startValidation(rawIssue);
      }
    }

    this.options.onStatusUpdate?.(`已接收问题: ${report.title}`);

    return {
      status: 'accepted',
      issue_id: issueId,
      message:
        this.validationStrategies[sourceAgent].strategy === 'batch-on-agent-complete'
          ? '问题已接收，等待批量验证...'
          : '问题已接收，正在验证...',
    };
  }

  /**
   * Add issue to batch buffer for later validation
   */
  private addToBatchBuffer(agent: AgentType, issue: RawIssue): void {
    const buffer = this.batchBuffers.get(agent) || [];
    buffer.push(issue);
    this.batchBuffers.set(agent, buffer);
    this.stats.validationPending++;

    if (this.options.verbose) {
      console.log(
        `[Collector] Issue ${issue.id} added to batch buffer for ${agent} (buffer size: ${buffer.length})`
      );
    }
  }

  /**
   * Flush batch buffer for a specific agent and start batch validation
   *
   * Call this when an agent completes to trigger batch validation for
   * agents using 'batch-on-agent-complete' strategy.
   */
  async flushAgentIssues(agent: AgentType): Promise<void> {
    const buffer = this.batchBuffers.get(agent);
    if (!buffer || buffer.length === 0) {
      if (this.options.verbose) {
        console.log(`[Collector] No buffered issues to flush for ${agent}`);
      }
      return;
    }

    if (this.options.verbose) {
      console.log(`[Collector] Flushing ${buffer.length} issues for ${agent} batch validation`);
    }

    // Clear buffer
    this.batchBuffers.set(agent, []);

    // Start batch validation
    await this.startBatchValidation(buffer, agent);
  }

  /**
   * Start async validation for an issue with concurrency control
   */
  private startValidation(issue: RawIssue): void {
    this.validationQueue.add(issue.id);
    this.stats.validationPending++;

    // Create a deferred promise that we can resolve later
    let resolvePromise!: (value: ValidatedIssue) => void;
    const validationPromise = new Promise<ValidatedIssue>((resolve) => {
      resolvePromise = resolve;
    });
    this.validationPromises.set(issue.id, validationPromise);

    // Queue the actual validation work
    const doValidation = async () => {
      try {
        const result = await this.validateIssue(issue);
        resolvePromise(result);
      } catch (error) {
        console.error(`[Collector] Validation failed for ${issue.id}:`, error);
        // Resolve with fallback on error
        const fallback: ValidatedIssue = {
          ...issue,
          validation_status: 'uncertain',
          grounding_evidence: {
            checked_files: [],
            checked_symbols: [],
            related_context: '',
            reasoning: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
          },
          final_confidence: issue.confidence * 0.5,
        };
        resolvePromise(fallback);
      } finally {
        this.activeValidations--;
        this.processNextValidation();
      }
    };

    // Either start immediately or queue
    if (this.activeValidations < this.maxConcurrentValidations) {
      this.activeValidations++;
      doValidation();
    } else {
      this.pendingValidations.push(doValidation);
    }
  }

  /**
   * Process next validation from queue
   */
  private processNextValidation(): void {
    if (
      this.pendingValidations.length > 0 &&
      this.activeValidations < this.maxConcurrentValidations
    ) {
      const next = this.pendingValidations.shift()!;
      this.activeValidations++;
      next();
    }
  }

  /**
   * Start batch validation for multiple issues from the same agent
   *
   * This is more efficient for agents like style-reviewer where
   * issues can be validated together in a single API call.
   */
  private async startBatchValidation(issues: RawIssue[], _agent: AgentType): Promise<void> {
    if (issues.length === 0) return;

    // Create promises for all issues
    const resolvers: Map<string, (value: ValidatedIssue) => void> = new Map();

    for (const issue of issues) {
      this.validationQueue.add(issue.id);
      const validationPromise = new Promise<ValidatedIssue>((resolve) => {
        resolvers.set(issue.id, resolve);
      });
      this.validationPromises.set(issue.id, validationPromise);
    }

    // Run batch validation
    try {
      const result = await this.validator.validateBatch(issues, this.maxConcurrentValidations);
      this.stats.tokensUsed += result.tokensUsed;

      // Process results
      for (const validatedIssue of result.issues) {
        this.validatedIssues.set(validatedIssue.id, validatedIssue);
        this.validationQueue.delete(validatedIssue.id);
        this.stats.validationPending--;
        this.stats.validated++;

        if (this.options.verbose) {
          console.log(
            `[Collector] Issue ${validatedIssue.id} batch-validated: ${validatedIssue.validation_status}`
          );
        }

        this.options.onIssueValidated?.(validatedIssue);

        // Resolve the promise
        const resolver = resolvers.get(validatedIssue.id);
        if (resolver) {
          resolver(validatedIssue);
        }
      }
    } catch (error) {
      console.error(`[Collector] Batch validation failed:`, error);

      // Fallback: mark all as uncertain
      for (const issue of issues) {
        const fallbackIssue: ValidatedIssue = {
          ...issue,
          validation_status: 'uncertain',
          grounding_evidence: {
            checked_files: [],
            checked_symbols: [],
            related_context: '',
            reasoning: `Batch validation error: ${error instanceof Error ? error.message : String(error)}`,
          },
          final_confidence: issue.confidence * 0.5,
        };

        this.validatedIssues.set(issue.id, fallbackIssue);
        this.validationQueue.delete(issue.id);
        this.stats.validationPending--;
        this.stats.validated++;

        this.options.onIssueValidated?.(fallbackIssue);

        const resolver = resolvers.get(issue.id);
        if (resolver) {
          resolver(fallbackIssue);
        }
      }
    }
  }

  /**
   * Validate a single issue
   */
  private async validateIssue(issue: RawIssue): Promise<ValidatedIssue> {
    try {
      const result = await this.validator.validate(issue);
      this.stats.tokensUsed += result.tokensUsed;

      // Store validated issue
      this.validatedIssues.set(issue.id, result.issue);
      this.validationQueue.delete(issue.id);
      this.stats.validationPending--;
      this.stats.validated++;

      if (this.options.verbose) {
        console.log(`[Collector] Issue ${issue.id} validated: ${result.issue.validation_status}`);
      }

      this.options.onIssueValidated?.(result.issue);

      return result.issue;
    } catch (error) {
      // On error, mark as uncertain
      const fallbackIssue: ValidatedIssue = {
        ...issue,
        validation_status: 'uncertain',
        grounding_evidence: {
          checked_files: [],
          checked_symbols: [],
          related_context: '',
          reasoning: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
        },
        final_confidence: issue.confidence * 0.5,
      };

      this.validatedIssues.set(issue.id, fallbackIssue);
      this.validationQueue.delete(issue.id);
      this.stats.validationPending--;
      this.stats.validated++;

      this.options.onIssueValidated?.(fallbackIssue);

      return fallbackIssue;
    }
  }

  /**
   * Generate a unique issue ID
   */
  private generateIssueId(agent: AgentType): string {
    const agentPrefix = agent.replace('-reviewer', '').substring(0, 3).toUpperCase();
    const counter = ++this.issueCounter;
    return `${agentPrefix}-${counter.toString().padStart(3, '0')}`;
  }

  /**
   * Wait for all pending validations to complete
   */
  async waitForValidations(): Promise<void> {
    const promises = Array.from(this.validationPromises.values());
    await Promise.allSettled(promises);
  }

  /**
   * Get all validated issues
   */
  getValidatedIssues(): ValidatedIssue[] {
    return Array.from(this.validatedIssues.values());
  }

  /**
   * Get collector statistics
   */
  getStats(): CollectorStats {
    return { ...this.stats };
  }

  /**
   * Reset the collector for a new review
   */
  reset(): void {
    this.rawIssues.clear();
    this.validatedIssues.clear();
    this.validationQueue.clear();
    this.validationPromises.clear();
    this.pendingValidations = [];
    this.activeValidations = 0;
    this.batchBuffers.clear();
    this.issueCounter = 0;
    this.stats = {
      totalReported: 0,
      validated: 0,
      validationPending: 0,
      tokensUsed: 0,
    };
  }
}

/**
 * Create an issue collector instance
 */
export function createIssueCollector(options: IssueCollectorOptions): IssueCollector {
  return new IssueCollector(options);
}
