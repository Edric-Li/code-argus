# Phoenix 代码风格补充规范

> 项目特定的风格规则。

## React 组件结构

组件必须遵循以下目录结构：

```
ComponentName/
├── index.tsx           # 导出
├── ComponentName.tsx   # 组件实现
└── ComponentName.module.css  # 样式
```

## CSS 规范

- **必须使用 CSS Module**，禁止内联样式
- 用 `classNames()` 库拼接 className，禁止模板字符串

```typescript
// ❌ 错误
<div className={`${styles.btn} ${isActive ? styles.active : ''}`}>

// ✅ 正确
<div className={classNames(styles.btn, { [styles.active]: isActive })}>
```

## TypeScript 规范

- 接口命名不用 `I` 前缀（`UserProps` 而非 `IUserProps`）
