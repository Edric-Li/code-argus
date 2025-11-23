# @argus/core

自动化代码审查的独立 CLI 工具 - Git Diff 提取与分析

## 功能特性

- 使用三点式 Diff (`git diff targetBranch...sourceBranch`) 提取代码变更
- 基于 Merge Base 对比，只显示源分支的实际变更
- TypeScript 编写，类型安全
- 使用 Node.js 原生 `child_process`，无第三方依赖
- 完善的错误处理

## 快速开始

### 安装依赖

```bash
npm install
```

### 使用方法

#### 命令格式

```bash
npm run dev <repoPath> <sourceBranch> <targetBranch>
```

或直接使用 tsx：

```bash
tsx src/index.ts <repoPath> <sourceBranch> <targetBranch>
```

#### 参数说明

- `repoPath` - Git 仓库路径（可以使用相对路径或绝对路径）
- `sourceBranch` - 源分支（包含新代码的开发分支）
- `targetBranch` - 目标分支（要合并进去的主分支，作为基准）

#### 示例

```bash
# 比较当前仓库的 feature 分支与 main 分支
npm run dev . feature/new-feature main

# 比较指定仓库路径
npm run dev /path/to/repo feature/auth-system main

# 比较 develop 和 master 分支
npm run dev ~/projects/my-app develop master
```

## 项目结构

```
src/
├── index.ts           # CLI 入口点，参数解析和输出
├── git/
│   ├── type.ts       # Git 操作相关的类型定义
│   └── diff.ts       # Git Diff 核心逻辑
├── utils/            # 工具函数
├── types/            # 通用类型定义
└── examples/         # 示例代码
```

## 技术栈

- **TypeScript 5.7** - 类型安全，严格模式
- **ES Modules** - 现代模块系统 (`"type": "module"`)
- **tsx** - 快速执行 TypeScript（无需预编译）
- **Node.js 22+** - 最新 Node.js 特性
- **原生 child_process** - 直接调用 Git 命令

## 开发命令

```bash
# 运行 CLI（需要提供参数）
npm run dev <repoPath> <sourceBranch> <targetBranch>

# 代码质量
npm run lint              # 运行 ESLint 检查
npm run lint:fix          # 自动修复 ESLint 问题
npm run format            # 格式化代码（Prettier）
npm run format:check      # 检查代码格式

# 类型检查
npm run type-check

# 编译为 JavaScript
npm run build

# 运行编译后的代码
npm start
```

## 代码质量工具

项目配置了完整的代码质量保证工具链：

### ESLint

- **配置文件**: `eslint.config.mjs`
- **功能**: TypeScript 代码检查
- **规则**: 基于 `@typescript-eslint/recommended`
- **使用**: `npm run lint` 或 `npm run lint:fix`

### Prettier

- **配置文件**: `.prettierrc.json`
- **功能**: 代码格式化
- **风格**: 单引号、分号、100 字符宽度
- **使用**: `npm run format` 或 `npm run format:check`

### Husky + lint-staged

- **Git Hooks**: 在提交前自动运行代码检查
- **pre-commit**: 自动格式化和修复暂存的文件
- **commit-msg**: 检查 commit message 格式

### Commitlint

- **配置文件**: `commitlint.config.mjs`
- **规范**: Conventional Commits
- **格式**: `<type>: <subject>`
- **类型**:
  - `feat`: 新功能
  - `fix`: 修复 bug
  - `docs`: 文档变更
  - `style`: 代码格式
  - `refactor`: 重构
  - `perf`: 性能优化
  - `test`: 测试
  - `chore`: 构建/工具变动

**Commit 示例**:

```bash
git commit -m "feat: add diff parser with intelligent categorization"
git commit -m "fix: correct remote branch handling in getDiff"
git commit -m "docs: update README with usage examples"
```

## 工作原理

### 三点式 Diff

使用 `git diff targetBranch...sourceBranch` 命令：

1. Git 首先找到两个分支的 Merge Base（共同祖先）
2. 然后比较 Merge Base 和 sourceBranch 的差异
3. 这样可以只显示 sourceBranch 上的实际变更，排除 targetBranch 上的其他提交

### 示例场景

```
main:     A --- B --- C
                \
feature:         D --- E
```

- `git diff main...feature` 只显示 D 和 E 的变更
- Merge Base 是 B
- 结果等同于 `git diff B..E`

## 错误处理

工具会检测并报告以下错误：

- 仓库路径不存在
- 路径不是有效的 Git 仓库
- 分支不存在或无效
- Git 命令执行失败

## 后续规划

- [ ] 支持输出格式化（JSON、Markdown）
- [ ] 集成 AI 代码审查
- [ ] 支持多仓库批量处理
- [ ] 添加配置文件支持
- [ ] 生成代码审查报告

## License

MIT
