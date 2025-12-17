/**
 * 审查模块常量
 */

/**
 * 所有 Agent 的默认模型
 * 使用 Opus 以获得最高质量的代码审查
 */
export const DEFAULT_AGENT_MODEL = 'claude-opus-4-5-20251101';

/**
 * 轻量级任务的默认模型
 * 用于 Agent 选择、自定义 Agent 匹配等简单分类任务
 */
export const DEFAULT_LIGHT_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * 实时去重的默认模型
 * 使用 Haiku 以提高速度和成本效率，因为每个重叠问题都会运行
 */
export const DEFAULT_REALTIME_DEDUP_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Agent 的最大思考 token 数（0 = 禁用扩展思考）
 * 代码审查结构化程度较高，扩展思考会增加延迟但收益不大
 */
export const DEFAULT_AGENT_MAX_THINKING_TOKENS = 0;

/**
 * 验证 Agent 的默认最大轮数（兜底值）
 * @deprecated 请使用 getValidatorMaxTurns(issueCount) 获取动态值
 */
export const DEFAULT_VALIDATOR_MAX_TURNS = 30;

/**
 * 根据 issue 数量计算验证器的 maxTurns
 *
 * 公式：基础轮数 + (issue 数 * 每 issue 轮数)
 * - 基础轮数：5（session 初始化开销）
 * - 每 issue 轮数：5（挑战模式最多 5 轮）
 * - 最小值：20（至少能处理 3 个 issues）
 * - 最大值：300（防止单个 session 过长）
 *
 * 示例：
 * - 1 issue: 5 + 5 = 20 轮 (最小值)
 * - 5 issues: 5 + 25 = 30 轮
 * - 10 issues: 5 + 50 = 55 轮
 * - 60+ issues: 300 轮 (封顶)
 *
 * 注意：实际轮数通常更少，因为：
 * - 大多数 issues 2-3 轮就会稳定（连续两轮一致即终止）
 * - 低置信度 issues 会被自动拒绝，不消耗轮数
 */
export function getValidatorMaxTurns(issueCount: number): number {
  const BASE_TURNS = 5;
  const TURNS_PER_ISSUE = 5; // 对应 MAX_CHALLENGE_ROUNDS
  const MIN_TURNS = 20;
  const MAX_TURNS = 300;

  // 验证输入：处理负数、NaN、Infinity 等无效值
  if (!Number.isFinite(issueCount) || issueCount < 0) {
    return MIN_TURNS;
  }

  const calculated = BASE_TURNS + issueCount * TURNS_PER_ISSUE;
  return Math.max(MIN_TURNS, Math.min(MAX_TURNS, calculated));
}

/**
 * 专业 Agent 的默认最大轮数
 */
export const DEFAULT_AGENT_MAX_TURNS = 30;

/**
 * 根据 diff 大小计算推荐的 maxTurns
 *
 * 公式：基础轮数 + (文件数 * 每文件轮数)
 * - 基础轮数：10（初始分析 + 总结）
 * - 每文件轮数：2（读取上下文 + 报告问题）
 * - 最小值：15
 * - 最大值：500
 *
 * 示例：
 * - 1 文件: 10 + 2 = 15 轮 (最小值)
 * - 10 文件: 10 + 20 = 30 轮
 * - 245+ 文件: 500 轮 (封顶)
 *
 * 优化说明（基于实际数据分析）：
 * - 94% 的有效问题在前 16 turns 内被发现
 * - 每文件实际平均只需 ~2.5 turns
 * - 降低 TURNS_PER_FILE 从 5 到 2 可节省 ~50% 成本
 */
export function getRecommendedMaxTurns(fileCount: number): number {
  const BASE_TURNS = 10;
  const TURNS_PER_FILE = 2;
  const MIN_TURNS = 15;
  const MAX_TURNS = 500;

  // 验证输入：处理负数、NaN、Infinity 等无效值
  if (!Number.isFinite(fileCount) || fileCount < 0) {
    return MIN_TURNS;
  }

  const calculated = BASE_TURNS + fileCount * TURNS_PER_FILE;
  return Math.max(MIN_TURNS, Math.min(MAX_TURNS, calculated));
}

/**
 * 验证的最低置信度阈值（旧版，请使用 getMinConfidenceForValidation 代替）
 * 低于此阈值的问题将自动拒绝，不进行验证
 * @deprecated 请使用 getMinConfidenceForValidation(severity) 获取动态阈值
 */
export const MIN_CONFIDENCE_FOR_VALIDATION = 0.5;

/**
 * 按严重程度划分的动态置信度阈值
 *
 * 关键问题即使置信度较低（0.2）也会验证，因为：
 * - 遗漏关键问题的代价非常高
 * - 宁可过度验证也不要遗漏安全/崩溃问题
 *
 * 建议问题需要更高的置信度（0.7），因为：
 * - 低置信度的建议会产生噪音
 * - 遗漏的影响较小
 */
export const CONFIDENCE_THRESHOLDS_BY_SEVERITY: Record<
  'critical' | 'error' | 'warning' | 'suggestion',
  number
> = {
  critical: 0.2, // 关键问题即使置信度很低也验证
  error: 0.4, // 错误问题阈值较低
  warning: 0.5, // 警告问题标准阈值
  suggestion: 0.7, // 建议问题更高阈值（减少噪音）
};

/**
 * 根据严重程度获取验证所需的最低置信度阈值
 *
 * @param severity - 问题严重程度
 * @returns 最低置信度阈值 (0-1)，未知类型返回默认值
 */
export function getMinConfidenceForValidation(
  severity: 'critical' | 'error' | 'warning' | 'suggestion'
): number {
  return CONFIDENCE_THRESHOLDS_BY_SEVERITY[severity] ?? MIN_CONFIDENCE_FOR_VALIDATION;
}

/**
 * 批量验证默认并发数
 */
export const DEFAULT_VALIDATION_CONCURRENCY = 3;

/**
 * 挑战模式：使用"反问确认"策略进行验证
 *
 * 流程：
 * - 第1轮：初始验证
 * - 第2轮：挑战 "你确定吗？"
 * - 第3轮（如有变化）：挑战 "请提供更具体的代码证据"
 * - 第4轮（如有变化）：魔鬼代言人 "请考虑反面论点"
 * - 第5轮（如有变化）：最后一轮 "给出最终判断"
 *
 * 终止条件：
 * - 连续两轮结果一致 -> 使用该结果
 * - 5轮后仍不一致 -> 多数投票决定
 */
export const DEFAULT_CHALLENGE_MODE = true;

/**
 * 最大挑战轮数
 * 支持最多5轮渐进式挑战策略
 */
export const MAX_CHALLENGE_ROUNDS = 5;

/**
 * 每个验证组的最大问题数
 * 同一文件的问题会分组验证，但每组不超过此数量
 * 超过的问题会拆分到多个组
 */
export const MAX_ISSUES_PER_GROUP = 5;

/**
 * Agent 执行失败时的最大重试次数
 * 用于处理瞬态错误（如网络超时、API 限流）
 */
export const MAX_AGENT_RETRIES = 2;

/**
 * Agent 重试前的基础延迟（毫秒）
 * 实际延迟 = BASE_DELAY * attempt（指数退避）
 */
export const AGENT_RETRY_DELAY_MS = 2000;
