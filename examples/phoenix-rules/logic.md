# Phoenix 逻辑审查补充规范

> 项目特定的逻辑审查规则。

## Zustand 状态管理

- 选择多个状态时必须使用 `useShallow`

```typescript
// ❌ 错误：每次都创建新对象，导致无限重渲染
const { user, token } = useStore((state) => ({ user: state.user, token: state.token }));

// ✅ 正确：使用 useShallow
const { user, token } = useStore(useShallow((state) => ({ user: state.user, token: state.token })));
```
