# 代码风格规范

> style-reviewer 专用通用规则。

## 审查原则

- **一致性优先** - 遵循项目已有风格，不强推个人偏好
- **不吹毛求疵** - 只报告影响可读性/可维护性的问题
- **尊重工具** - 如果项目有 ESLint/Prettier，风格问题交给工具

## 必须检查

### TypeScript

- 禁止 `any` 类型，使用具体类型或 `unknown`
- 公共 API / 导出函数需要返回类型
- 避免类型断言（`as`），优先使用类型守卫

### 命名规范

- 变量/函数: camelCase
- 类/接口/类型: PascalCase
- 常量: UPPER_SNAKE_CASE 或 camelCase
- 文件名: 与默认导出一致

### React 组件

- 事件处理建议抽离为具名函数
- 列表 key 用稳定 ID，避免 index
- 避免过深的 JSX 嵌套（>4层考虑拆分）

### Java

- 用构造注入，避免字段注入（`@Autowired`）
- 日志用占位符 `log.info("User: {}", name)`，禁止字符串拼接
- 方法命名：`getXxx`/`listXxx`/`createXxx`/`updateXxx`/`deleteXxx`

## 常见风格问题

```typescript
// ❌ any 类型
function process(data: any) { ... }
// ✅ 具体类型
function process(data: UserData) { ... }

// ❌ 类型断言
const user = data as User;
// ✅ 类型守卫
if (isUser(data)) { ... }
```

```java
// ❌ 字段注入
@Autowired
private UserMapper userMapper;

// ✅ 构造注入
@RequiredArgsConstructor
public class UserServiceImpl {
    private final UserMapper userMapper;
}

// ❌ 日志拼接
log.info("User " + userName + " created");

// ✅ 占位符
log.info("User {} created", userName);
```

## 严重程度指南

- **error**: 违反项目明确禁止的规则
- **warning**: 降低代码可读性/可维护性
- **suggestion**: 可以改进但不强制
