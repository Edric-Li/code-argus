# Phoenix 项目审查规则示例

这是一个精简后的项目规则示例，只包含**项目特定**的规则。

通用规则（如 SQL 注入检测、N+1 查询、空指针检查等）由 `@argus/core` 的内置规则提供。

## 使用方式

```bash
# 使用内置规则 + 项目规则
npx argus review /path/to/phoenix-worker1 feature main --rules-dir=./.ai-review

# 等价于
npx argus review /path/to/phoenix-worker1 feature main --rules-dir=/path/to/phoenix-rules
```

## 文件说明

| 文件             | 说明                           |
| ---------------- | ------------------------------ |
| `global.md`      | 项目禁止项（前端/后端特有）    |
| `logic.md`       | Zustand useShallow 规范        |
| `performance.md` | useMemo/useCallback 使用策略   |
| `style.md`       | 组件结构、CSS Module、命名规范 |
| `security.md`    | 关键安全文件列表               |

## 规则合并逻辑

1. 先加载内置通用规则（industry-standard）
2. 再加载项目自定义规则（覆盖/扩展内置规则）

这样可以：

- 减少重复配置
- 保持通用规则的更新
- 只维护项目特定的部分
