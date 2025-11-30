/**
 * CLI Module
 *
 * Progress output and event system for code review.
 */

// Progress Printer
export {
  ProgressPrinter,
  createProgressPrinter,
  nullProgressPrinter,
  type IProgressPrinter,
  type ProgressPrinterOptions,
  type ValidationStatusType,
  type ProgressMode,
  type ProgressPrinterWithModeOptions,
} from './progress.js';

// Events
export {
  ReviewEventEmitter,
  createReviewEventEmitter,
  type ReviewEvent,
  type ReviewEventHandler,
  type ReviewStateSnapshot,
  type AgentState,
  type ReviewStartData,
  type PhaseData,
  type PhaseCompleteData,
  type AgentStartData,
  type AgentProgressData,
  type AgentCompleteData,
  type ValidationStartData,
  type ValidationProgressData,
  type ValidationIssueData,
  type ValidationCompleteData,
  type ReviewCompleteData,
  type ReviewErrorData,
  type LogData,
} from './events.js';

// Structured Progress Printer
export {
  StructuredProgressPrinter,
  createStructuredProgressPrinter,
  createDualProgressPrinter,
  type StructuredProgressOptions,
} from './structured-progress.js';

import {
  createProgressPrinter,
  nullProgressPrinter,
  type IProgressPrinter,
  type ProgressMode,
} from './progress.js';
import {
  createStructuredProgressPrinter,
  createDualProgressPrinter,
  type StructuredProgressOptions,
} from './structured-progress.js';
import type { ReviewEvent } from './events.js';

/**
 * Options for creating a progress printer with mode selection
 */
export interface CreateProgressPrinterOptions {
  /** Progress output mode */
  mode?: ProgressMode;
  /** Enable verbose output */
  verbose?: boolean;
  /** Custom event handler */
  onEvent?: (event: ReviewEvent) => void;
  /** Output stream for JSON mode (default: process.stderr) */
  jsonOutput?: NodeJS.WritableStream;
}

/**
 * Create a progress printer based on the specified mode
 *
 * @param options - Creation options
 * @returns Progress printer instance
 *
 * @example
 * ```typescript
 * // Auto-detect mode (TTY or silent)
 * const printer = createProgressPrinterWithMode({ mode: 'auto' });
 *
 * // Force JSON output for service integration
 * const printer = createProgressPrinterWithMode({
 *   mode: 'json',
 *   onEvent: (event) => {
 *     // Handle events programmatically
 *     if (event.type === 'agent:complete') {
 *       console.log(`Agent ${event.data.agent} completed`);
 *     }
 *   }
 * });
 *
 * // Get state snapshot anytime
 * const state = printer.getState?.();
 * ```
 */
export function createProgressPrinterWithMode(
  options: CreateProgressPrinterOptions = {}
): IProgressPrinter & {
  getState?: () => import('./events.js').ReviewStateSnapshot;
  getEmitter?: () => import('./events.js').ReviewEventEmitter;
} {
  const mode = options.mode ?? 'auto';
  const isTTY = process.stdout.isTTY ?? false;

  switch (mode) {
    case 'silent':
      return nullProgressPrinter;

    case 'json': {
      const structuredOptions: StructuredProgressOptions = {
        verbose: options.verbose,
        output: options.jsonOutput,
        onEvent: options.onEvent,
      };
      return createStructuredProgressPrinter(structuredOptions);
    }

    case 'tty':
      // If we have an event handler, create dual printer
      if (options.onEvent) {
        return createDualProgressPrinter(createProgressPrinter(), {
          silent: true,
          onEvent: options.onEvent,
        });
      }
      return createProgressPrinter();

    case 'auto':
    default:
      if (isTTY) {
        // TTY: use interactive printer, optionally with event tracking
        if (options.onEvent) {
          return createDualProgressPrinter(createProgressPrinter(), {
            silent: true,
            onEvent: options.onEvent,
          });
        }
        return createProgressPrinter();
      } else {
        // Non-TTY: use JSON output if onEvent provided, otherwise silent
        if (options.onEvent) {
          return createStructuredProgressPrinter({
            verbose: options.verbose,
            output: options.jsonOutput,
            onEvent: options.onEvent,
            silent: true, // Don't output JSON, just call handler
          });
        }
        return nullProgressPrinter;
      }
  }
}
