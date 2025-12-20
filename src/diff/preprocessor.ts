/**
 * Diff Preprocessor Module
 *
 * 预处理 diff 内容：
 * 1. 过滤删除文件（通用规则）：删除文件只保留文件名列表，不传内容
 * 2. 计算 diff 大小
 * 3. 检测是否需要分段审核
 */

import { parseDiff, type DiffFile } from '../git/parser.js';

/**
 * 预处理后的 diff 结果
 */
export interface PreprocessedDiff {
  /** 处理后的 diff 内容（删除文件内容已移除） */
  processedDiff: string;
  /** 处理后的 diff 大小（字节） */
  processedSize: number;
  /** 删除的文件列表 */
  deletedFiles: string[];
  /** 解析后的 diff 文件（不含删除文件） */
  diffFiles: DiffFile[];
  /** 原始统计信息 */
  stats: {
    originalSize: number;
    originalFileCount: number;
    deletedFileCount: number;
    modifiedFileCount: number;
    addedFileCount: number;
    savedBytes: number;
  };
}

/**
 * 预处理配置
 */
export interface PreprocessorConfig {
  /** 分段阈值（字节），默认 150KB */
  segmentSizeLimit: number;
  /** 是否启用详细日志 */
  verbose?: boolean;
}

const DEFAULT_CONFIG: PreprocessorConfig = {
  segmentSizeLimit: 150 * 1024, // 150KB
  verbose: false,
};

/**
 * 从 diff 中提取删除文件的内容并移除
 *
 * @param rawDiff - 原始 diff 内容
 * @returns 预处理后的结果
 */
export function preprocessDiff(
  rawDiff: string,
  config: Partial<PreprocessorConfig> = {}
): PreprocessedDiff {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!rawDiff || !rawDiff.trim()) {
    return {
      processedDiff: '',
      processedSize: 0,
      deletedFiles: [],
      diffFiles: [],
      stats: {
        originalSize: 0,
        originalFileCount: 0,
        deletedFileCount: 0,
        modifiedFileCount: 0,
        addedFileCount: 0,
        savedBytes: 0,
      },
    };
  }

  const originalSize = Buffer.byteLength(rawDiff, 'utf8');

  // 解析 diff 获取文件信息
  const allDiffFiles = parseDiff(rawDiff);

  // 分离删除文件和其他文件
  const deletedFiles: string[] = [];
  const nonDeletedFiles: DiffFile[] = [];

  for (const file of allDiffFiles) {
    if (file.type === 'delete') {
      deletedFiles.push(file.path);
    } else {
      nonDeletedFiles.push(file);
    }
  }

  // 重建 diff：移除删除文件的具体内容
  let processedDiff = rawDiff;

  if (deletedFiles.length > 0) {
    // 使用正则匹配并移除删除文件的 diff 块
    for (const deletedPath of deletedFiles) {
      // 转义路径中的特殊字符
      const escapedPath = deletedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 匹配从 "diff --git" 到下一个 "diff --git" 或文件末尾的内容
      const regex = new RegExp(
        `diff --git a\\/${escapedPath} b\\/${escapedPath}[\\s\\S]*?(?=diff --git|$)`,
        'g'
      );
      processedDiff = processedDiff.replace(regex, '');
    }
  }

  const processedSize = Buffer.byteLength(processedDiff, 'utf8');
  const savedBytes = originalSize - processedSize;

  const stats = {
    originalSize,
    originalFileCount: allDiffFiles.length,
    deletedFileCount: deletedFiles.length,
    modifiedFileCount: nonDeletedFiles.filter((f) => f.type === 'modify').length,
    addedFileCount: nonDeletedFiles.filter((f) => f.type === 'add').length,
    savedBytes,
  };

  if (cfg.verbose && deletedFiles.length > 0) {
    console.log(
      `[Preprocessor] 过滤删除文件: ${deletedFiles.length} 个, 节省 ${(savedBytes / 1024).toFixed(1)}KB`
    );
  }

  return {
    processedDiff,
    processedSize,
    deletedFiles,
    diffFiles: nonDeletedFiles,
    stats,
  };
}

/**
 * 生成删除文件上下文字符串（用于传递给 logic-reviewer）
 *
 * @param deletedFiles - 删除文件列表
 * @returns 格式化的上下文字符串
 */
export function formatDeletedFilesContext(deletedFiles: string[]): string {
  if (deletedFiles.length === 0) {
    return '';
  }

  const header = `## 删除的文件 (${deletedFiles.length} 个)\n\n以下文件在此 PR 中被删除：\n`;
  const fileList = deletedFiles.map((f) => `- ${f}`).join('\n');

  return `${header}${fileList}\n`;
}

/**
 * 检查是否需要分段审核
 *
 * @param processedSize - 预处理后的 diff 大小
 * @param config - 配置
 * @returns 是否需要分段
 */
export function needsSegmentation(
  processedSize: number,
  config: Partial<PreprocessorConfig> = {}
): boolean {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return processedSize > cfg.segmentSizeLimit;
}

/**
 * 按语言分组 diff 文件
 *
 * @param diffFiles - diff 文件列表
 * @returns 按语言分组的结果
 */
export function groupByLanguage(diffFiles: DiffFile[]): Map<string, DiffFile[]> {
  const groups = new Map<string, DiffFile[]>();

  for (const file of diffFiles) {
    const lang = detectLanguage(file.path);
    if (!groups.has(lang)) {
      groups.set(lang, []);
    }
    groups.get(lang)!.push(file);
  }

  return groups;
}

/**
 * 按模块/目录分组 diff 文件
 *
 * @param diffFiles - diff 文件列表
 * @param depth - 目录深度，默认 2（如 src/components）
 * @returns 按模块分组的结果
 */
export function groupByModule(diffFiles: DiffFile[], depth: number = 2): Map<string, DiffFile[]> {
  const groups = new Map<string, DiffFile[]>();

  for (const file of diffFiles) {
    const module = extractModule(file.path, depth);
    if (!groups.has(module)) {
      groups.set(module, []);
    }
    groups.get(module)!.push(file);
  }

  return groups;
}

/**
 * 检测文件语言
 */
function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';

  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    java: 'java',
    kt: 'kotlin',
    py: 'python',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    swift: 'swift',
    m: 'objc',
    mm: 'objc',
    scala: 'scala',
    css: 'css',
    scss: 'css',
    less: 'css',
    html: 'html',
    vue: 'vue',
    svelte: 'svelte',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    xml: 'xml',
    md: 'markdown',
  };

  return langMap[ext] || 'other';
}

/**
 * 提取模块路径
 */
function extractModule(path: string, depth: number): string {
  const parts = path.split('/');
  if (parts.length <= depth) {
    return parts.slice(0, -1).join('/') || 'root';
  }
  return parts.slice(0, depth).join('/');
}

/**
 * 计算文件组的总大小
 */
export function calculateGroupSize(files: DiffFile[]): number {
  return files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
}
