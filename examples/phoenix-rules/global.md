# Phoenix 项目规范

> 项目特定规则，与内置通用规则配合使用。

## 项目禁止项

### 前端 (React/TypeScript)

- `any` 类型（使用具体类型或 `unknown`）
- 内联样式 `style={{}}`（使用 CSS Module）
- 字符串拼接 className（使用 `classNames()` 库）
- JSX 内联函数 `onClick={() => ...}`（抽离为具名函数）
- 未使用的导入/变量

### 后端 (Java/Spring)

- 字符串拼接 SQL（使用参数化查询 `@Param`）
- `@Autowired` 字段注入（使用 `@RequiredArgsConstructor`）
- 空 catch 块（至少要有日志）
- 日志字符串拼接（使用占位符 `{}`）
