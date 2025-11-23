# Code Argus Core

现代化的 TypeScript 项目，使用最新的 Node.js 规范。

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
# 运行主入口
npm run dev

# 执行任意 TypeScript 文件（快速验证）
npm run exec src/examples/demo.ts

# 类型检查
npm run type-check
```

### 构建

```bash
# 编译为 JavaScript
npm run build

# 运行编译后的代码
npm start
```

## 项目结构

```
src/
├── index.ts         # 主入口文件
├── core/            # 核心业务逻辑
├── utils/           # 工具函数
├── types/           # 类型定义
└── examples/        # 示例/验证代码
```

## 技术栈

- **TypeScript 5.7** - 类型安全
- **ES Modules** - 现代模块系统
- **tsx** - 快速执行 TypeScript
- **Node.js 22+** - 最新 Node.js 特性
