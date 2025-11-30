/**
 * Review Event System
 *
 * Provides structured events for tracking review progress.
 * Designed for both interactive CLI and service integration.
 */

import { EventEmitter } from 'events';
import type { AgentType } from '../review/types.js';

// ============ Event Data Types ============

export interface ReviewStartData {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  incremental: boolean;
  agents: AgentType[];
  timestamp: string;
}

export interface PhaseData {
  phase: number;
  totalPhases: number;
  name: string;
  timestamp: string;
}

export interface PhaseCompleteData extends PhaseData {
  elapsedMs: number;
  details?: Record<string, unknown>;
}

export interface AgentStartData {
  agent: AgentType;
  timestamp: string;
}

export interface AgentProgressData {
  agent: AgentType;
  activity: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface AgentCompleteData {
  agent: AgentType;
  status: 'completed' | 'error';
  issuesFound: number;
  elapsedMs: number;
  error?: string;
  timestamp: string;
}

export interface ValidationStartData {
  totalIssues: number;
  timestamp: string;
}

export interface ValidationProgressData {
  current: number;
  total: number;
  issueId: string;
  issueTitle: string;
  activity?: string;
  timestamp: string;
}

export interface ValidationIssueData {
  issueId: string;
  title: string;
  file: string;
  severity: string;
  status: 'discovered' | 'confirmed' | 'rejected' | 'uncertain' | 'auto_rejected' | 'deduplicated';
  reason?: string;
  round?: number;
  maxRounds?: number;
  timestamp: string;
}

export interface ValidationCompleteData {
  total: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  autoRejected: number;
  deduplicated: number;
  elapsedMs: number;
  tokensUsed: number;
  timestamp: string;
}

export interface ReviewCompleteData {
  totalIssues: number;
  elapsedMs: number;
  timestamp: string;
}

export interface ReviewErrorData {
  error: string;
  phase?: string;
  timestamp: string;
}

export interface LogData {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface ReportData {
  /** Full review report (ReviewReport type) */
  report: Record<string, unknown>;
  timestamp: string;
}

// ============ Event Union Type ============

export type ReviewEvent =
  | { type: 'review:start'; data: ReviewStartData }
  | { type: 'review:complete'; data: ReviewCompleteData }
  | { type: 'review:error'; data: ReviewErrorData }
  | { type: 'phase:start'; data: PhaseData }
  | { type: 'phase:complete'; data: PhaseCompleteData }
  | { type: 'agent:start'; data: AgentStartData }
  | { type: 'agent:progress'; data: AgentProgressData }
  | { type: 'agent:complete'; data: AgentCompleteData }
  | { type: 'validation:start'; data: ValidationStartData }
  | { type: 'validation:progress'; data: ValidationProgressData }
  | { type: 'validation:issue'; data: ValidationIssueData }
  | { type: 'validation:complete'; data: ValidationCompleteData }
  | { type: 'log'; data: LogData }
  | { type: 'report'; data: ReportData };

// ============ State Snapshot ============

export interface AgentState {
  status: 'pending' | 'running' | 'completed' | 'error';
  issuesFound: number;
  elapsedMs: number;
  currentActivity?: string;
  error?: string;
}

export interface ReviewStateSnapshot {
  status: 'idle' | 'running' | 'completed' | 'failed';
  phase: {
    current: number;
    total: number;
    name: string;
  };
  agents: Record<string, AgentState>;
  validation: {
    status: 'idle' | 'running' | 'completed';
    total: number;
    completed: number;
    confirmed: number;
    rejected: number;
    uncertain: number;
    autoRejected: number;
    deduplicated: number;
    currentIssue?: string;
  };
  issues: {
    raw: number;
    deduplicated: number;
    validated: number;
  };
  timing: {
    startedAt: string;
    elapsedMs: number;
  };
  error?: string;
}

// ============ Event Emitter ============

export type ReviewEventHandler = (event: ReviewEvent) => void;

export class ReviewEventEmitter extends EventEmitter {
  private state: ReviewStateSnapshot;
  private startTime: number;

  constructor() {
    super();
    this.startTime = Date.now();
    this.state = this.createInitialState();
  }

  private createInitialState(): ReviewStateSnapshot {
    return {
      status: 'idle',
      phase: { current: 0, total: 0, name: '' },
      agents: {},
      validation: {
        status: 'idle',
        total: 0,
        completed: 0,
        confirmed: 0,
        rejected: 0,
        uncertain: 0,
        autoRejected: 0,
        deduplicated: 0,
      },
      issues: { raw: 0, deduplicated: 0, validated: 0 },
      timing: { startedAt: new Date().toISOString(), elapsedMs: 0 },
    };
  }

  private timestamp(): string {
    return new Date().toISOString();
  }

  private updateElapsed(): void {
    this.state.timing.elapsedMs = Date.now() - this.startTime;
  }

  /**
   * Get current state snapshot (read-only copy)
   */
  getState(): ReviewStateSnapshot {
    this.updateElapsed();
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Subscribe to all events
   */
  onEvent(handler: ReviewEventHandler): void {
    this.on('event', handler);
  }

  /**
   * Unsubscribe from events
   */
  offEvent(handler: ReviewEventHandler): void {
    this.off('event', handler);
  }

  private emitEvent(event: ReviewEvent): void {
    this.updateElapsed();
    this.emit('event', event);
  }

  // ============ Event Emitters ============

  reviewStart(data: Omit<ReviewStartData, 'timestamp'>): void {
    this.startTime = Date.now();
    this.state = this.createInitialState();
    this.state.status = 'running';
    this.state.timing.startedAt = this.timestamp();

    // Initialize agent states
    for (const agent of data.agents) {
      this.state.agents[agent] = {
        status: 'pending',
        issuesFound: 0,
        elapsedMs: 0,
      };
    }

    this.emitEvent({
      type: 'review:start',
      data: { ...data, timestamp: this.timestamp() },
    });
  }

  reviewComplete(totalIssues: number): void {
    this.state.status = 'completed';
    this.state.issues.validated = totalIssues;
    this.updateElapsed();

    this.emitEvent({
      type: 'review:complete',
      data: {
        totalIssues,
        elapsedMs: this.state.timing.elapsedMs,
        timestamp: this.timestamp(),
      },
    });
  }

  reviewError(error: string, phase?: string): void {
    this.state.status = 'failed';
    this.state.error = error;

    this.emitEvent({
      type: 'review:error',
      data: { error, phase, timestamp: this.timestamp() },
    });
  }

  phaseStart(phase: number, totalPhases: number, name: string): void {
    this.state.phase = { current: phase, total: totalPhases, name };

    this.emitEvent({
      type: 'phase:start',
      data: { phase, totalPhases, name, timestamp: this.timestamp() },
    });
  }

  phaseComplete(
    phase: number,
    totalPhases: number,
    name: string,
    elapsedMs: number,
    details?: Record<string, unknown>
  ): void {
    this.emitEvent({
      type: 'phase:complete',
      data: { phase, totalPhases, name, elapsedMs, details, timestamp: this.timestamp() },
    });
  }

  agentStart(agent: AgentType): void {
    if (this.state.agents[agent]) {
      this.state.agents[agent].status = 'running';
      this.state.agents[agent].currentActivity = 'Starting...';
    }

    this.emitEvent({
      type: 'agent:start',
      data: { agent, timestamp: this.timestamp() },
    });
  }

  agentProgress(agent: AgentType, activity: string, details?: Record<string, unknown>): void {
    if (this.state.agents[agent]) {
      this.state.agents[agent].currentActivity = activity;
    }

    this.emitEvent({
      type: 'agent:progress',
      data: { agent, activity, details, timestamp: this.timestamp() },
    });
  }

  agentComplete(
    agent: AgentType,
    status: 'completed' | 'error',
    issuesFound: number,
    elapsedMs: number,
    error?: string
  ): void {
    if (this.state.agents[agent]) {
      this.state.agents[agent].status = status;
      this.state.agents[agent].issuesFound = issuesFound;
      this.state.agents[agent].elapsedMs = elapsedMs;
      this.state.agents[agent].currentActivity = undefined;
      if (error) {
        this.state.agents[agent].error = error;
      }
    }

    // Update raw issues count
    if (status === 'completed') {
      this.state.issues.raw += issuesFound;
    }

    this.emitEvent({
      type: 'agent:complete',
      data: { agent, status, issuesFound, elapsedMs, error, timestamp: this.timestamp() },
    });
  }

  validationStart(totalIssues: number): void {
    this.state.validation.status = 'running';
    this.state.validation.total = totalIssues;

    this.emitEvent({
      type: 'validation:start',
      data: { totalIssues, timestamp: this.timestamp() },
    });
  }

  validationProgress(
    current: number,
    total: number,
    issueId: string,
    issueTitle: string,
    activity?: string
  ): void {
    this.state.validation.completed = current;
    this.state.validation.currentIssue = issueTitle;

    this.emitEvent({
      type: 'validation:progress',
      data: { current, total, issueId, issueTitle, activity, timestamp: this.timestamp() },
    });
  }

  validationIssue(
    issueId: string,
    title: string,
    file: string,
    severity: string,
    status: ValidationIssueData['status'],
    reason?: string,
    round?: number,
    maxRounds?: number
  ): void {
    // Update validation counts
    switch (status) {
      case 'confirmed':
        this.state.validation.confirmed++;
        break;
      case 'rejected':
        this.state.validation.rejected++;
        break;
      case 'uncertain':
        this.state.validation.uncertain++;
        break;
      case 'auto_rejected':
        this.state.validation.autoRejected++;
        break;
      case 'deduplicated':
        this.state.validation.deduplicated++;
        this.state.issues.deduplicated++;
        break;
    }

    this.emitEvent({
      type: 'validation:issue',
      data: {
        issueId,
        title,
        file,
        severity,
        status,
        reason,
        round,
        maxRounds,
        timestamp: this.timestamp(),
      },
    });
  }

  validationComplete(stats: Omit<ValidationCompleteData, 'timestamp'>): void {
    this.state.validation.status = 'completed';
    this.state.validation.confirmed = stats.confirmed;
    this.state.validation.rejected = stats.rejected;
    this.state.validation.uncertain = stats.uncertain;
    this.state.validation.autoRejected = stats.autoRejected;
    this.state.validation.deduplicated = stats.deduplicated;
    this.state.validation.currentIssue = undefined;

    this.emitEvent({
      type: 'validation:complete',
      data: { ...stats, timestamp: this.timestamp() },
    });
  }

  log(level: LogData['level'], message: string, details?: Record<string, unknown>): void {
    this.emitEvent({
      type: 'log',
      data: { level, message, details, timestamp: this.timestamp() },
    });
  }

  report(reviewReport: Record<string, unknown>): void {
    this.emitEvent({
      type: 'report',
      data: { report: reviewReport, timestamp: this.timestamp() },
    });
  }
}

/**
 * Create a new event emitter instance
 */
export function createReviewEventEmitter(): ReviewEventEmitter {
  return new ReviewEventEmitter();
}
