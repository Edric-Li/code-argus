/**
 * 智能分段策略模块
 *
 * 当 diff 超过阈值时，智能选择分段策略：
 * 1. 优先按语言分段（如果语言分布合理）
 * 2. 如果语言分布不均匀，按模块/目录分段
 * 3. 使用 Bin Packing 算法优化分段
 */

import type { DiffFile } from '../git/parser.js';
import { groupByLanguage, groupByModule, calculateGroupSize } from './preprocessor.js';

/**
 * 分段结果
 */
export interface Segment {
  /** 分段 ID */
  id: string;
  /** 分段名称（语言名或模块名） */
  name: string;
  /** 包含的文件 */
  files: DiffFile[];
  /** 分段大小（字节） */
  size: number;
  /** 分段类型 */
  type: 'language' | 'module' | 'mixed';
}

/**
 * 分段策略结果
 */
export interface SegmentationResult {
  /** 分段列表 */
  segments: Segment[];
  /** 使用的策略 */
  strategy: 'single' | 'language' | 'module' | 'mixed';
  /** 策略选择原因 */
  reason: string;
  /** 总文件数 */
  totalFiles: number;
  /** 总大小 */
  totalSize: number;
}

/**
 * 分段配置
 */
export interface SegmentationConfig {
  /** 分段大小限制（字节），默认 150KB */
  segmentSizeLimit: number;
  /** 语言合并阈值：小于总量此比例的语言会被合并 */
  languageMergePercent: number;
  /** 语言合并阈值：小于此大小的语言会被合并（字节） */
  languageMergeSize: number;
  /** 最大分段数 */
  maxSegments: number;
  /** 是否启用详细日志 */
  verbose?: boolean;
}

const DEFAULT_CONFIG: SegmentationConfig = {
  segmentSizeLimit: 150 * 1024, // 150KB
  languageMergePercent: 0.2, // 20%
  languageMergeSize: 50 * 1024, // 50KB
  maxSegments: 10,
  verbose: false,
};

/**
 * 执行智能分段
 *
 * @param diffFiles - diff 文件列表（已排除删除文件）
 * @param config - 分段配置
 * @returns 分段结果
 */
export function segmentDiff(
  diffFiles: DiffFile[],
  config: Partial<SegmentationConfig> = {}
): SegmentationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const totalSize = calculateGroupSize(diffFiles);
  const totalFiles = diffFiles.length;

  // 如果总大小未超限，不需要分段
  if (totalSize <= cfg.segmentSizeLimit) {
    return {
      segments: [
        {
          id: 'single',
          name: 'all',
          files: diffFiles,
          size: totalSize,
          type: 'mixed',
        },
      ],
      strategy: 'single',
      reason: `总大小 ${(totalSize / 1024).toFixed(1)}KB 未超过限制 ${(cfg.segmentSizeLimit / 1024).toFixed(0)}KB`,
      totalFiles,
      totalSize,
    };
  }

  if (cfg.verbose) {
    console.log(`[Segmentation] 总大小 ${(totalSize / 1024).toFixed(1)}KB 超过限制，开始分段...`);
  }

  // Step 1: 尝试按语言分段
  const languageResult = tryLanguageSegmentation(diffFiles, cfg);
  if (languageResult) {
    return languageResult;
  }

  // Step 2: 按模块分段
  const moduleResult = tryModuleSegmentation(diffFiles, cfg);
  if (moduleResult) {
    return moduleResult;
  }

  // Step 3: 混合分段（Bin Packing）
  return binPackingSegmentation(diffFiles, cfg);
}

/**
 * 尝试按语言分段
 */
function tryLanguageSegmentation(
  diffFiles: DiffFile[],
  cfg: SegmentationConfig
): SegmentationResult | null {
  const languageGroups = groupByLanguage(diffFiles);
  const totalSize = calculateGroupSize(diffFiles);

  // 计算每种语言的大小
  const languageSizes = new Map<string, number>();
  for (const [lang, files] of languageGroups) {
    languageSizes.set(lang, calculateGroupSize(files));
  }

  // 检查是否有任何语言超过限制
  let hasOversized = false;
  const segments: Segment[] = [];
  const smallLanguages: DiffFile[] = [];

  for (const [lang, files] of languageGroups) {
    const size = languageSizes.get(lang)!;
    const percent = size / totalSize;

    // 小语言合并到 "other"
    if (percent < cfg.languageMergePercent && size < cfg.languageMergeSize) {
      smallLanguages.push(...files);
      continue;
    }

    // 检查是否超过限制
    if (size > cfg.segmentSizeLimit) {
      hasOversized = true;
      // 语言分段不适用，需要进一步拆分
      break;
    }

    segments.push({
      id: `lang-${lang}`,
      name: lang,
      files,
      size,
      type: 'language',
    });
  }

  // 如果有语言超限，语言分段策略不适用
  if (hasOversized) {
    if (cfg.verbose) {
      console.log('[Segmentation] 存在超限语言，语言分段策略不适用');
    }
    return null;
  }

  // 添加小语言合并分段
  if (smallLanguages.length > 0) {
    const size = calculateGroupSize(smallLanguages);
    if (size <= cfg.segmentSizeLimit) {
      segments.push({
        id: 'lang-other',
        name: 'other',
        files: smallLanguages,
        size,
        type: 'language',
      });
    } else {
      // 小语言合并后仍超限，需要混合策略
      if (cfg.verbose) {
        console.log('[Segmentation] 小语言合并后仍超限，语言分段策略不适用');
      }
      return null;
    }
  }

  if (segments.length === 0) {
    return null;
  }

  return {
    segments,
    strategy: 'language',
    reason: `按语言分段: ${segments.map((s) => `${s.name}(${(s.size / 1024).toFixed(1)}KB)`).join(', ')}`,
    totalFiles: diffFiles.length,
    totalSize,
  };
}

/**
 * 尝试按模块分段
 */
function tryModuleSegmentation(
  diffFiles: DiffFile[],
  cfg: SegmentationConfig
): SegmentationResult | null {
  const totalSize = calculateGroupSize(diffFiles);

  // 尝试不同的目录深度
  for (const depth of [2, 1, 3]) {
    const moduleGroups = groupByModule(diffFiles, depth);
    const segments: Segment[] = [];
    let allFit = true;

    for (const [module, files] of moduleGroups) {
      const size = calculateGroupSize(files);

      if (size > cfg.segmentSizeLimit) {
        allFit = false;
        break;
      }

      segments.push({
        id: `module-${module.replace(/\//g, '-')}`,
        name: module,
        files,
        size,
        type: 'module',
      });
    }

    if (allFit && segments.length <= cfg.maxSegments) {
      // 使用 Bin Packing 优化合并小模块
      const optimizedSegments = optimizeSegmentsWithBinPacking(segments, cfg.segmentSizeLimit);

      return {
        segments: optimizedSegments,
        strategy: 'module',
        reason: `按模块分段 (深度=${depth}): ${optimizedSegments.length} 个分段`,
        totalFiles: diffFiles.length,
        totalSize,
      };
    }
  }

  return null;
}

/**
 * 使用 Bin Packing 合并小分段
 */
function optimizeSegmentsWithBinPacking(segments: Segment[], sizeLimit: number): Segment[] {
  // 按大小降序排序 (First-Fit Decreasing)
  const sorted = [...segments].sort((a, b) => b.size - a.size);

  const bins: Segment[] = [];

  for (const segment of sorted) {
    // 尝试放入现有 bin
    let placed = false;
    for (const bin of bins) {
      if (bin.size + segment.size <= sizeLimit) {
        // 合并到现有 bin
        bin.files.push(...segment.files);
        bin.size += segment.size;
        bin.name = bin.name.includes('+') ? bin.name : `${bin.name}+${segment.name}`;
        placed = true;
        break;
      }
    }

    if (!placed) {
      // 创建新 bin
      bins.push({
        id: `bin-${bins.length}`,
        name: segment.name,
        files: [...segment.files],
        size: segment.size,
        type: 'mixed',
      });
    }
  }

  return bins;
}

/**
 * 混合分段策略（当语言和模块分段都不适用时）
 */
function binPackingSegmentation(
  diffFiles: DiffFile[],
  cfg: SegmentationConfig
): SegmentationResult {
  const totalSize = calculateGroupSize(diffFiles);

  // 按文件大小降序排序
  const sorted = [...diffFiles].sort(
    (a, b) => Buffer.byteLength(b.content, 'utf8') - Buffer.byteLength(a.content, 'utf8')
  );

  const bins: Segment[] = [];

  for (const file of sorted) {
    const fileSize = Buffer.byteLength(file.content, 'utf8');

    // 如果单个文件就超限，单独成一个分段（无法进一步拆分）
    if (fileSize > cfg.segmentSizeLimit) {
      bins.push({
        id: `bin-${bins.length}`,
        name: file.path,
        files: [file],
        size: fileSize,
        type: 'mixed',
      });
      continue;
    }

    // 尝试放入现有 bin
    let placed = false;
    for (const bin of bins) {
      if (bin.size + fileSize <= cfg.segmentSizeLimit) {
        bin.files.push(file);
        bin.size += fileSize;
        placed = true;
        break;
      }
    }

    if (!placed) {
      bins.push({
        id: `bin-${bins.length}`,
        name: `segment-${bins.length + 1}`,
        files: [file],
        size: fileSize,
        type: 'mixed',
      });
    }
  }

  return {
    segments: bins,
    strategy: 'mixed',
    reason: `Bin Packing 分段: ${bins.length} 个分段`,
    totalFiles: diffFiles.length,
    totalSize,
  };
}

/**
 * 从分段重建 diff 内容
 *
 * @param segment - 分段
 * @returns 该分段的 diff 内容
 */
export function rebuildDiffFromSegment(segment: Segment): string {
  return segment.files.map((file) => file.content).join('\n');
}
