/**
 * Diff Processing Module
 *
 * 提供 diff 预处理、分段和优化功能
 */

export {
  preprocessDiff,
  formatDeletedFilesContext,
  needsSegmentation,
  groupByLanguage,
  groupByModule,
  calculateGroupSize,
  type PreprocessedDiff,
  type PreprocessorConfig,
} from './preprocessor.js';

export {
  segmentDiff,
  rebuildDiffFromSegment,
  type Segment,
  type SegmentationResult,
  type SegmentationConfig,
} from './segmentation.js';
