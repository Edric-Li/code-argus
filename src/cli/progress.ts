/* eslint-disable no-undef */
/**
 * CLI Progress Printer
 *
 * Provides real-time progress output for the review process in the terminal.
 */

/**
 * Progress printer options
 */
export interface ProgressPrinterOptions {
  /** Enable colored output (default: true if TTY) */
  colors?: boolean;
  /** Enable spinner animation (default: true if TTY) */
  spinner?: boolean;
}

/**
 * Validation status for streaming validation
 */
export type ValidationStatusType = 'confirmed' | 'rejected' | 'uncertain' | 'pending';

/**
 * Progress printer interface (for null object pattern)
 */
export interface IProgressPrinter {
  phase(step: number, total: number, message: string): void;
  success(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  progress(message: string): void;
  agent(name: string, status: 'running' | 'completed' | 'error', details?: string): void;
  agentActivity(name: string, activity: string): void;
  validation(current: number, total: number, issueId: string): void;
  complete(issues: number, time?: number): void;
  failed(message: string): void;
  divider(): void;
  stats(items: Array<{ label: string; value: string | number }>): void;

  // Streaming validation methods
  issueDiscovered(title: string, file: string, severity: string): void;
  issueValidated(title: string, status: ValidationStatusType, reason?: string): void;
  autoRejected(title: string, reason: string): void;
  validationRound(
    title: string,
    round: number,
    maxRounds: number,
    status: ValidationStatusType
  ): void;
  validationActivity(title: string, activity: string): void;
  validationSummary(stats: {
    total: number;
    confirmed: number;
    rejected: number;
    uncertain: number;
    autoRejected: number;
    deduplicated?: number;
    tokensUsed: number;
    timeMs: number;
  }): void;

  // Report output (for json-logs mode)
  report?(report: Record<string, unknown>): void;
}

/**
 * ANSI color codes
 */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

/**
 * Spinner frames
 */
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * CLI Progress Printer
 *
 * Outputs real-time progress information to the terminal.
 */
export class ProgressPrinter implements IProgressPrinter {
  private useColors: boolean;
  private useSpinner: boolean;
  private spinnerIndex = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private currentSpinnerLine = '';
  private startTime: number;
  private phaseStartTime: number;
  private stepStartTime: number;

  constructor(options: ProgressPrinterOptions = {}) {
    const isTTY = process.stdout.isTTY ?? false;
    this.useColors = options.colors ?? isTTY;
    this.useSpinner = options.spinner ?? isTTY;
    this.startTime = Date.now();
    this.phaseStartTime = Date.now();
    this.stepStartTime = Date.now();
  }

  /**
   * Color helper
   */
  private c(color: keyof typeof colors, text: string): string {
    if (!this.useColors) return text;
    return `${colors[color]}${text}${colors.reset}`;
  }

  /**
   * Get elapsed time string
   */
  private elapsed(from: 'start' | 'phase' | 'step' = 'phase'): string {
    const base =
      from === 'start'
        ? this.startTime
        : from === 'phase'
          ? this.phaseStartTime
          : this.stepStartTime;
    const ms = Date.now() - base;
    return this.formatDuration(ms);
  }

  /**
   * Format duration in ms to human-readable string
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    const remainingMs = ms % 1000;
    if (seconds < 60) {
      return remainingMs > 0 ? `${seconds}.${Math.floor(remainingMs / 100)}s` : `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  /**
   * Print a phase header
   */
  phase(step: number, total: number, message: string): void {
    this.stopSpinner();
    this.phaseStartTime = Date.now();
    this.stepStartTime = Date.now();
    console.log('');
    console.log(this.c('bold', this.c('blue', `[${step}/${total}] ${message}`)));
  }

  /**
   * Print a success message with elapsed time
   */
  success(message: string): void {
    this.stopSpinner();
    const elapsed = this.elapsed('step');
    console.log(`      ${this.c('green', '✓')} ${message} ${this.c('gray', `(${elapsed})`)}`);
    this.stepStartTime = Date.now(); // Reset for next step
  }

  /**
   * Print an info message
   */
  info(message: string): void {
    this.stopSpinner();
    console.log(`      ${this.c('cyan', 'ℹ')} ${message}`);
  }

  /**
   * Print a warning message
   */
  warn(message: string): void {
    this.stopSpinner();
    console.log(`      ${this.c('yellow', '⚠')} ${message}`);
  }

  /**
   * Print an error message
   */
  error(message: string): void {
    this.stopSpinner();
    console.log(`      ${this.c('red', '✗')} ${message}`);
  }

  /**
   * Print a progress item with spinner
   */
  progress(message: string): void {
    this.stopSpinner();
    this.currentSpinnerLine = message;

    if (this.useSpinner) {
      this.spinnerIndex = 0;
      this.writeSpinner();
      this.spinnerInterval = setInterval(() => {
        this.spinnerIndex = (this.spinnerIndex + 1) % spinnerFrames.length;
        this.writeSpinner();
      }, 80);
    } else {
      console.log(`      ${this.c('yellow', '⏳')} ${message}`);
    }
  }

  /**
   * Write spinner frame
   */
  private writeSpinner(): void {
    const frame = spinnerFrames[this.spinnerIndex];
    process.stdout.write(`\r      ${this.c('yellow', frame || '⏳')} ${this.currentSpinnerLine}`);
  }

  /**
   * Stop the spinner
   */
  private stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
      if (this.useSpinner && this.currentSpinnerLine) {
        // Clear the line
        process.stdout.write('\r' + ' '.repeat(this.currentSpinnerLine.length + 10) + '\r');
      }
      this.currentSpinnerLine = '';
    }
  }

  /**
   * Print agent status
   */
  agent(name: string, status: 'running' | 'completed' | 'error', details?: string): void {
    this.stopSpinner();
    const icon =
      status === 'running'
        ? this.c('yellow', '⏳')
        : status === 'completed'
          ? this.c('green', '✓')
          : this.c('red', '✗');
    const detailStr = details ? ` ${this.c('gray', `(${details})`)}` : '';
    console.log(`      ${icon} ${name}${detailStr}`);
  }

  /**
   * Print agent activity (tool use, thinking, etc.)
   */
  agentActivity(name: string, activity: string): void {
    // Use spinner to show activity, truncate if too long
    const maxLen = 60;
    const truncated = activity.length > maxLen ? activity.substring(0, maxLen) + '...' : activity;
    const msg = `${this.c('cyan', name)}: ${truncated}`;
    this.progress(msg);
  }

  /**
   * Print validation progress
   */
  validation(current: number, total: number, issueId: string): void {
    const percent = Math.round((current / total) * 100);
    const msg = `[${current}/${total}] ${issueId} ${this.c('gray', `(${percent}%)`)}`;
    this.progress(msg);
  }

  /**
   * Print final summary
   */
  complete(issues: number, time?: number): void {
    this.stopSpinner();
    const elapsed = time ?? Date.now() - this.startTime;
    const seconds = Math.floor(elapsed / 1000);
    console.log('');
    console.log(
      this.c('bold', this.c('green', `✅ 审查完成! 发现 ${issues} 个问题, 耗时 ${seconds}s`))
    );
    console.log('');
  }

  /**
   * Print error summary
   */
  failed(message: string): void {
    this.stopSpinner();
    console.log('');
    console.log(this.c('bold', this.c('red', `❌ 审查失败: ${message}`)));
    console.log('');
  }

  /**
   * Print a divider
   */
  divider(): void {
    this.stopSpinner();
    console.log(this.c('gray', '─'.repeat(50)));
  }

  /**
   * Print stats in a compact format
   */
  stats(items: Array<{ label: string; value: string | number }>): void {
    this.stopSpinner();
    const parts = items.map((item) => `${this.c('gray', item.label + ':')} ${item.value}`);
    console.log(`      ${parts.join('  ')}`);
  }

  // ============ Streaming Validation Methods ============

  /**
   * Print issue discovered (before validation)
   */
  issueDiscovered(title: string, file: string, severity: string): void {
    this.stopSpinner();
    const fileName = file.split('/').pop() || file;
    const severityIcon =
      severity === 'critical'
        ? this.c('red', '🔴')
        : severity === 'error'
          ? this.c('red', '🟠')
          : severity === 'warning'
            ? this.c('yellow', '🟡')
            : this.c('blue', '🔵');
    console.log(`      ${severityIcon} ${title} ${this.c('gray', `(${fileName})`)}`);
  }

  /**
   * Print issue validation completed
   */
  issueValidated(title: string, status: ValidationStatusType, reason?: string): void {
    this.stopSpinner();
    const icon =
      status === 'confirmed'
        ? this.c('green', '✅')
        : status === 'rejected'
          ? this.c('red', '❌')
          : this.c('yellow', '❓');
    const statusText =
      status === 'confirmed'
        ? this.c('green', '确认')
        : status === 'rejected'
          ? this.c('red', '拒绝')
          : this.c('yellow', '不确定');
    const reasonStr = reason ? ` | ${this.c('gray', reason)}` : '';
    console.log(`      ${icon} ${title} → ${statusText}${reasonStr}`);
  }

  /**
   * Print auto-rejected issue
   */
  autoRejected(title: string, reason: string): void {
    this.stopSpinner();
    console.log(`      ${this.c('gray', '⏭️')} ${title} ${this.c('gray', `(${reason})`)}`);
  }

  /**
   * Print validation round progress (real-time)
   */
  validationRound(
    title: string,
    round: number,
    maxRounds: number,
    status: ValidationStatusType
  ): void {
    const statusIcon =
      status === 'confirmed'
        ? this.c('green', '✓')
        : status === 'rejected'
          ? this.c('red', '✗')
          : this.c('yellow', '?');
    const truncatedTitle = title.length > 30 ? title.substring(0, 30) + '...' : title;
    const msg = `验证 [${round}/${maxRounds}] ${statusIcon} ${truncatedTitle}`;
    this.progress(msg);
  }

  /**
   * Print validation activity (heartbeat)
   */
  validationActivity(title: string, activity: string): void {
    const truncatedTitle = title.length > 25 ? title.substring(0, 25) + '...' : title;
    const msg = `${truncatedTitle} ${this.c('gray', activity)}`;
    this.progress(msg);
  }

  /**
   * Print validation summary
   */
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
    this.stopSpinner();
    const timeStr = this.formatDuration(stats.timeMs);
    const tokenStr =
      stats.tokensUsed > 1000 ? `${(stats.tokensUsed / 1000).toFixed(1)}k` : `${stats.tokensUsed}`;

    console.log('');
    console.log(this.c('bold', '      📊 验证统计:'));
    console.log(
      `         总计: ${stats.total} | ${this.c('green', `确认: ${stats.confirmed}`)} | ${this.c('red', `拒绝: ${stats.rejected}`)} | ${this.c('yellow', `不确定: ${stats.uncertain}`)}`
    );
    if (stats.deduplicated && stats.deduplicated > 0) {
      console.log(`         实时去重: ${stats.deduplicated} (重复问题)`);
    }
    if (stats.autoRejected > 0) {
      console.log(`         自动跳过: ${stats.autoRejected} (低置信度)`);
    }
    console.log(`         耗时: ${timeStr} | Tokens: ${tokenStr}`);
  }
}

/**
 * Create a progress printer instance
 */
export function createProgressPrinter(options?: ProgressPrinterOptions): ProgressPrinter {
  return new ProgressPrinter(options);
}

/**
 * Progress mode for createProgressPrinterWithMode
 */
export type ProgressMode = 'auto' | 'tty' | 'json' | 'silent';

/**
 * Extended options for mode-based progress printer creation
 */
export interface ProgressPrinterWithModeOptions {
  /** Progress output mode */
  mode?: ProgressMode;
  /** Verbose output (for json mode, includes debug events) */
  verbose?: boolean;
  /** Custom event handler (for json mode) */
  onEvent?: (event: unknown) => void;
}

/**
 * Default no-op progress printer for when progress is disabled
 */
export const nullProgressPrinter: IProgressPrinter = {
  phase: () => {},
  success: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  progress: () => {},
  agent: () => {},
  agentActivity: () => {},
  validation: () => {},
  complete: () => {},
  failed: () => {},
  divider: () => {},
  stats: () => {},
  // Streaming validation methods
  issueDiscovered: () => {},
  issueValidated: () => {},
  autoRejected: () => {},
  validationRound: () => {},
  validationActivity: () => {},
  validationSummary: () => {},
};
