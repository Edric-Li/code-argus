# 逻辑审查规范

> logic-reviewer 专用通用规则。

## 审查原则

- **看实际调用** - 不要孤立看函数，要看调用方如何使用
- **一致性优先** - 如果模块内风格一致，不要挑刺
- **证据驱动** - 只报告能证明有问题的，不报告"理论上可能"
- **尊重设计决定** - 返回空数组/提前返回通常是有意为之

## 必须检查

### 1. 错误处理

- catch 块是否正确处理（非空、有日志或用户提示）
- 异步操作是否有 loading/error 状态
- 关键操作是否有错误边界

### 2. 异步操作

- useEffect 是否有清理函数（定时器、订阅、事件监听）
- 组件卸载后是否还在 setState
- 是否有防止重复请求的机制
- async 函数是否正确 await

### 3. 状态管理

- 状态更新是否不可变（禁止 push/splice/直接修改）
- 闭包是否捕获了旧值

### 4. 事务与数据

- 多个数据库操作是否在事务中
- 空值是否正确处理（可选链、空值合并）
- 数组边界是否检查

## 常见逻辑错误

```typescript
// ❌ 未清理的副作用
useEffect(() => {
  const timer = setInterval(fn, 1000);
  // 缺少 return () => clearInterval(timer)
}, []);

// ❌ 组件卸载后 setState
useEffect(() => {
  fetchData().then(setData); // 组件可能已卸载
}, []);

// ❌ 直接修改状态
setState((prev) => {
  prev.items.push(item); // 错误：直接修改
  return prev;
});

// ❌ 闭包捕获旧值
useEffect(() => {
  const handler = () => console.log(count); // count 是旧值
  window.addEventListener('click', handler);
}, []); // 缺少 count 依赖

// ❌ 缺少 await
async function save() {
  validate(); // 如果 validate 是 async，这里丢失了 await
  doSave();
}
```

```java
// ❌ 同类方法调用事务失效
public void outer() {
  this.transactionalMethod(); // @Transactional 不生效
}

// ❌ 捕获异常导致事务不回滚
@Transactional
public void create() {
  try {
    mapper.insert(entity);
  } catch (Exception e) {
    log.error(e); // 事务不会回滚！
  }
}

// ❌ 空指针风险
User user = userMapper.selectById(id);
return user.getName(); // user 可能为 null
```

## 严重程度指南

- **critical**: 崩溃、数据损坏、死循环
- **error**: 正常使用会出现的 bug
- **warning**: 边缘情况的潜在 bug
- **suggestion**: 代码健壮性改进
