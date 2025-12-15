/**
 * Structured Progress Printer
 *
 * Outputs JSON Lines (NDJSON) for service integration.
 * Each line is a valid JSON object representing a review event.
 *
 * This is designed for non-TTY environments where external services
 * need to parse and track review progress programmatically.
 */

import type {
  IProgressPrinter,
  ValidationStatusType,
  ValidatedIssueInfo,
  AutoRejectedIssueInfo,
} from './progress.js';
import {
  ReviewEventEmitter,
  type ReviewEvent,
  type ReviewStateSnapshot,
  createReviewEventEmitter,
} from './events.js';
import type { AgentType } from '../review/types.js';

export interface StructuredProgressOptions {
  /**
   * Output stream to write JSON lines to (default: process.stderr)
   * Using stderr keeps stdout clean for the final report
   */
  output?: NodeJS.WritableStream;

  /**
   * Include debug-level events (default: false)
   */
  verbose?: boolean;

  /**
   * Event filter - only emit events of these types (default: all)
   */
  eventTypes?: ReviewEvent['type'][];

  /**
   * Custom event handler (in addition to JSON output)
   */
  onEvent?: (event: ReviewEvent) => void;

  /**
   * Disable JSON output, only use event handlers (default: false)
   */
  silent?: boolean;
}

/**
 * Structured Progress Printer
 *
 * Implements IProgressPrinter interface but outputs structured JSON lines.
 * This allows external services to parse review progress reliably.
 */
export class StructuredProgressPrinter implements IProgressPrinter {
  private output: NodeJS.WritableStream;
  private verbose: boolean;
  private eventTypes?: Set<ReviewEvent['type']>;
  private onEventHandler?: (event: ReviewEvent) => void;
  private silent: boolean;

  private emitter: ReviewEventEmitter;
  private startTime: number;
  private phaseStartTime: number;
  private stepStartTime: number;

  // Track current context for better event data
  private currentPhase = { step: 0, total: 0, name: '' };
  private agentStartTimes: Map<string, number> = new Map();

  constructor(options: StructuredProgressOptions = {}) {
    this.output = options.output ?? process.stderr;
    this.verbose = options.verbose ?? false;
    this.eventTypes = options.eventTypes ? new Set(options.eventTypes) : undefined;
    this.onEventHandler = options.onEvent;
    this.silent = options.silent ?? false;

    this.startTime = Date.now();
    this.phaseStartTime = Date.now();
    this.stepStartTime = Date.now();

    this.emitter = createReviewEventEmitter();

    // Subscribe to events and output JSON
    this.emitter.onEvent((event) => {
      // Filter events if eventTypes specified
      if (this.eventTypes && !this.eventTypes.has(event.type)) {
        return;
      }

      // Call custom handler if provided
      if (this.onEventHandler) {
        this.onEventHandler(event);
      }

      // Output JSON line
      if (!this.silent) {
        this.writeJson(event);
      }
    });
  }

  /**
   * Get the underlying event emitter for direct event subscription
   */
  getEmitter(): ReviewEventEmitter {
    return this.emitter;
  }

  /**
   * Get current state snapshot
   */
  getState(): ReviewStateSnapshot {
    return this.emitter.getState();
  }

  private writeJson(event: ReviewEvent): void {
    // 检查流是否可写，避免 ERR_STREAM_WRITE_AFTER_END 错误
    if (!this.output.writable) {
      return;
    }
    try {
      const line = JSON.stringify(event) + '\n';
      this.output.write(line);
    } catch {
      // 忽略写入错误，流可能已关闭
    }
  }

  private elapsed(from: 'start' | 'phase' | 'step' = 'phase'): number {
    const base =
      from === 'start'
        ? this.startTime
        : from === 'phase'
          ? this.phaseStartTime
          : this.stepStartTime;
    return Date.now() - base;
  }

  // ============ IProgressPrinter Implementation ============

  phase(step: number, total: number, message: string): void {
    // Complete previous phase if any
    if (this.currentPhase.step > 0 && this.currentPhase.step < step) {
      this.emitter.phaseComplete(
        this.currentPhase.step,
        this.currentPhase.total,
        this.currentPhase.name,
        this.elapsed('phase')
      );
    }

    this.phaseStartTime = Date.now();
    this.stepStartTime = Date.now();
    this.currentPhase = { step, total, name: message };

    this.emitter.phaseStart(step, total, message);
  }

  success(message: string): void {
    const elapsed = this.elapsed('step');
    this.emitter.log('info', message, { elapsedMs: elapsed, type: 'success' });
    this.stepStartTime = Date.now();
  }

  info(message: string): void {
    this.emitter.log('info', message);
  }

  warn(message: string): void {
    this.emitter.log('warn', message);
  }

  error(message: string): void {
    this.emitter.log('error', message);
  }

  progress(message: string): void {
    // In structured mode, progress messages become info logs
    // We don't need spinner animations
    if (this.verbose) {
      this.emitter.log('debug', message, { type: 'progress' });
    }
  }

  agent(name: string, status: 'running' | 'completed' | 'error', details?: string): void {
    const agentType = name as AgentType;

    if (status === 'running') {
      this.agentStartTimes.set(name, Date.now());
      this.emitter.agentStart(agentType);
    } else {
      const startTime = this.agentStartTimes.get(name) ?? Date.now();
      const elapsedMs = Date.now() - startTime;

      // Parse details to extract issue count
      let issuesFound = 0;
      if (details) {
        const match = details.match(/(\d+)\s*issues?/i);
        if (match && match[1]) {
          issuesFound = parseInt(match[1], 10);
        }
      }

      this.emitter.agentComplete(
        agentType,
        status === 'completed' ? 'completed' : 'error',
        issuesFound,
        elapsedMs,
        status === 'error' ? details : undefined
      );
    }
  }

  agentActivity(name: string, activity: string): void {
    this.emitter.agentProgress(name as AgentType, activity);
  }

  validation(current: number, total: number, issueId: string): void {
    // If this is the first validation call, emit validation:start
    const state = this.emitter.getState();
    if (state.validation.status === 'idle') {
      this.emitter.validationStart(total);
    }

    this.emitter.validationProgress(current, total, issueId, issueId);
  }

  complete(issues: number, _time?: number): void {
    // Complete the last phase
    if (this.currentPhase.step > 0) {
      this.emitter.phaseComplete(
        this.currentPhase.step,
        this.currentPhase.total,
        this.currentPhase.name,
        this.elapsed('phase')
      );
    }

    this.emitter.reviewComplete(issues);
  }

  failed(message: string): void {
    this.emitter.reviewError(message, this.currentPhase.name);
  }

  divider(): void {
    // No-op in structured mode
  }

  stats(items: Array<{ label: string; value: string | number }>): void {
    const data: Record<string, string | number> = {};
    for (const item of items) {
      data[item.label] = item.value;
    }
    this.emitter.log('info', 'stats', data);
  }

  // ============ Streaming Validation Methods ============

  issueDiscovered(
    title: string,
    file: string,
    severity: string,
    line?: number,
    description?: string,
    suggestion?: string
  ): void {
    this.emitter.validationIssue(
      this.generateIssueId(title, file),
      title,
      file,
      severity,
      'discovered',
      undefined, // reason
      undefined, // round
      undefined, // maxRounds
      line,
      description,
      suggestion
    );
  }

  issueValidated(issue: ValidatedIssueInfo): void {
    // Map ValidationStatusType to our status
    const statusMap: Record<
      ValidationStatusType,
      'confirmed' | 'rejected' | 'uncertain' | 'discovered'
    > = {
      confirmed: 'confirmed',
      rejected: 'rejected',
      uncertain: 'uncertain',
      pending: 'discovered',
    };

    this.emitter.validationIssue(
      this.generateIssueId(issue.title, issue.file),
      issue.title,
      issue.file,
      issue.severity,
      statusMap[issue.status],
      issue.reason,
      undefined, // round
      undefined, // maxRounds
      issue.line,
      issue.description,
      issue.suggestion
    );
  }

  autoRejected(issue: AutoRejectedIssueInfo): void {
    this.emitter.validationIssue(
      this.generateIssueId(issue.title, issue.file),
      issue.title,
      issue.file,
      issue.severity,
      'auto_rejected',
      issue.reason,
      undefined, // round
      undefined, // maxRounds
      issue.line,
      issue.description,
      issue.suggestion
    );
  }

  validationRound(
    title: string,
    round: number,
    maxRounds: number,
    status: ValidationStatusType
  ): void {
    // Emit as progress event with round info
    this.emitter.validationProgress(
      round,
      maxRounds,
      this.generateIssueId(title),
      title,
      `Round ${round}/${maxRounds}: ${status}`
    );
  }

  validationActivity(title: string, activity: string): void {
    if (this.verbose) {
      this.emitter.log('debug', `Validation: ${title}`, { activity });
    }
  }

  validationSummary(stats: {
    total: number;
    confirmed: number;
    rejected: number;
    uncertain: number;
    autoRejected: number;
    deduplicated?: number;
    tokensUsed: number;
    timeMs: number;
  }): void {
    this.emitter.validationComplete({
      total: stats.total,
      confirmed: stats.confirmed,
      rejected: stats.rejected,
      uncertain: stats.uncertain,
      autoRejected: stats.autoRejected,
      deduplicated: stats.deduplicated ?? 0,
      elapsedMs: stats.timeMs,
      tokensUsed: stats.tokensUsed,
    });
  }

  /**
   * Output the final review report as an event
   */
  report(reviewReport: Record<string, unknown>): void {
    this.emitter.report(reviewReport);
  }

  // ============ Extended Methods for Service Integration ============

  /**
   * Initialize review with full context (call at the start)
   */
  initReview(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string,
    agents: AgentType[]
  ): void {
    this.startTime = Date.now();
    this.emitter.reviewStart({
      repoPath,
      sourceBranch,
      targetBranch,
      agents,
    });
  }

  /**
   * Generate a simple issue ID from title and optional file
   */
  private generateIssueId(title: string, file?: string): string {
    const base = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 30);
    if (file) {
      const fileName =
        file
          .split('/')
          .pop()
          ?.replace(/[^a-z0-9.]+/gi, '') ?? '';
      return `${base}-${fileName}`.slice(0, 50);
    }
    return base;
  }
}

/**
 * Create a structured progress printer
 */
export function createStructuredProgressPrinter(
  options?: StructuredProgressOptions
): StructuredProgressPrinter {
  return new StructuredProgressPrinter(options);
}

/**
 * Create a progress printer that outputs to both TTY and JSON
 * Useful for debugging or dual-mode operation
 */
export function createDualProgressPrinter(
  ttyPrinter: IProgressPrinter,
  structuredOptions?: StructuredProgressOptions
): IProgressPrinter & {
  getState: () => ReviewStateSnapshot;
  getEmitter: () => ReviewEventEmitter;
} {
  const structured = new StructuredProgressPrinter({
    ...structuredOptions,
    silent: true, // Don't output JSON, just track state
  });

  return {
    // State access
    getState: () => structured.getState(),
    getEmitter: () => structured.getEmitter(),

    // Delegate to both
    phase: (step, total, message) => {
      ttyPrinter.phase(step, total, message);
      structured.phase(step, total, message);
    },
    success: (message) => {
      ttyPrinter.success(message);
      structured.success(message);
    },
    info: (message) => {
      ttyPrinter.info(message);
      structured.info(message);
    },
    warn: (message) => {
      ttyPrinter.warn(message);
      structured.warn(message);
    },
    error: (message) => {
      ttyPrinter.error(message);
      structured.error(message);
    },
    progress: (message) => {
      ttyPrinter.progress(message);
      structured.progress(message);
    },
    agent: (name, status, details) => {
      ttyPrinter.agent(name, status, details);
      structured.agent(name, status, details);
    },
    agentActivity: (name, activity) => {
      ttyPrinter.agentActivity(name, activity);
      structured.agentActivity(name, activity);
    },
    validation: (current, total, issueId) => {
      ttyPrinter.validation(current, total, issueId);
      structured.validation(current, total, issueId);
    },
    complete: (issues, time) => {
      ttyPrinter.complete(issues, time);
      structured.complete(issues, time);
    },
    failed: (message) => {
      ttyPrinter.failed(message);
      structured.failed(message);
    },
    divider: () => {
      ttyPrinter.divider();
      structured.divider();
    },
    stats: (items) => {
      ttyPrinter.stats(items);
      structured.stats(items);
    },
    issueDiscovered: (title, file, severity, line, description, suggestion) => {
      ttyPrinter.issueDiscovered(title, file, severity, line, description, suggestion);
      structured.issueDiscovered(title, file, severity, line, description, suggestion);
    },
    issueValidated: (issue) => {
      ttyPrinter.issueValidated(issue);
      structured.issueValidated(issue);
    },
    autoRejected: (issue) => {
      ttyPrinter.autoRejected(issue);
      structured.autoRejected(issue);
    },
    validationRound: (title, round, maxRounds, status) => {
      ttyPrinter.validationRound(title, round, maxRounds, status);
      structured.validationRound(title, round, maxRounds, status);
    },
    validationActivity: (title, activity) => {
      ttyPrinter.validationActivity(title, activity);
      structured.validationActivity(title, activity);
    },
    validationSummary: (stats) => {
      ttyPrinter.validationSummary(stats);
      structured.validationSummary(stats);
    },
    report: (reportData) => {
      ttyPrinter.report?.(reportData);
      structured.report(reportData);
    },
  };
}
