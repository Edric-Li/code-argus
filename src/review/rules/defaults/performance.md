# 性能审查规范

> performance-reviewer 专用通用规则。

## 审查原则

- **先确认热路径** - 只关注 runtime 高频代码，配置/启动代码不需要优化
- **避免过度优化** - 小数据量不报（几十个元素的 map/filter 不是问题）
- **有数据支撑** - 不要凭感觉说"可能有性能问题"，要能说明调用频率

## 必须检查

### 数据库性能

- **N+1 查询**: 循环中查数据库
- **无分页列表查询**: 可能返回大量数据
- **SELECT \***: 应只查需要的字段
- **循环中的数据库操作**: 应改为批量

### 前端性能

- 渲染时是否创建新对象/数组作为 props（导致子组件重渲染）
- 长列表（>100项）是否用虚拟滚动或分页
- 大组件是否用 lazy() 代码分割
- 第三方库是否按需导入

### 网络性能

- 是否有防止重复请求的机制
- 频繁触发的操作是否有防抖/节流
- 组件卸载时是否取消未完成请求

### 内存管理

- 定时器是否清理
- 事件监听是否移除
- 大数据是否分批处理

## 常见性能问题

```typescript
// ❌ 渲染时创建新对象（每次渲染都是新引用）
<Child style={{ color: 'red' }} />
<Child options={[1, 2, 3]} />

// ❌ 全量导入
import _ from 'lodash';
// ✅ 按需导入
import debounce from 'lodash/debounce';

// ❌ 未清理定时器
useEffect(() => {
  setInterval(fn, 1000);
}, []);
```

```java
// ❌ N+1 查询
List<Order> orders = orderMapper.selectAll();
for (Order order : orders) {
  order.setItems(itemMapper.selectByOrderId(order.getId())); // N 次查询
}

// ✅ 批量查询
List<Order> orders = orderMapper.selectAll();
List<String> orderIds = orders.stream().map(Order::getId).toList();
Map<String, List<Item>> itemsMap = itemMapper.selectByOrderIds(orderIds)
    .stream().collect(groupingBy(Item::getOrderId));

// ❌ 循环删除
for (String id : ids) {
  mapper.deleteById(id);
}
// ✅ 批量删除
mapper.deleteByIds(ids);
```

## 性能阈值参考

| 指标         | 警告阈值          |
| ------------ | ----------------- |
| 列表项数量   | >100 项考虑虚拟化 |
| API 响应时间 | >3s 需要优化      |
| 组件渲染时间 | >16ms 需要关注    |

## 严重程度指南

- **critical**: 导致页面卡死、OOM
- **error**: 明显影响用户体验的性能问题
- **warning**: 可优化但影响有限
- **suggestion**: 性能最佳实践
