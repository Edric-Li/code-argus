# Code Quality Standards

本项目配置了完整的代码质量保证工具链，确保代码的一致性、可维护性和高质量。

## 工具列表

### 1. TypeScript 严格模式

**配置文件**: `tsconfig.json`

```json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true
  }
}
```

**作用**: 在编译时捕获类型错误，提供最严格的类型检查。

### 2. ESLint

**配置文件**: `eslint.config.mjs`

- **Parser**: `@typescript-eslint/parser`
- **Plugins**: `@typescript-eslint/eslint-plugin`, `eslint-plugin-prettier`
- **规则集**: TypeScript recommended + Prettier

**运行**:

```bash
npm run lint        # 检查代码
npm run lint:fix    # 自动修复
```

### 3. Prettier

**配置文件**: `.prettierrc.json`

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

**运行**:

```bash
npm run format          # 格式化代码
npm run format:check    # 检查格式
```

### 4. Husky (Git Hooks)

**配置目录**: `.husky/`

#### pre-commit Hook

自动在提交前运行 `lint-staged`，对暂存的文件进行检查和格式化。

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx lint-staged
```

#### commit-msg Hook

检查 commit message 是否符合 Conventional Commits 规范。

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx --no -- commitlint --edit $1
```

### 5. lint-staged

**配置**: `package.json` 中的 `lint-staged` 字段

```json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md}": ["prettier --write"]
  }
}
```

**作用**: 只对 Git 暂存区的文件运行 linters，提高效率。

### 6. Commitlint

**配置文件**: `commitlint.config.mjs`

**规范**: Conventional Commits

**格式**: `<type>: <subject>`

**允许的类型**:

- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档变更
- `style`: 代码格式（不影响代码运行）
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试
- `chore`: 构建/工具变动
- `revert`: 回退
- `build`: 打包

## 工作流程

### 1. 开发时

```bash
# 编写代码
vim src/feature.ts

# 实时类型检查（使用 VS Code 等 IDE）
# 或手动运行
npm run type-check
```

### 2. 提交前

```bash
# 添加到暂存区
git add .

# 提交（自动触发 hooks）
git commit -m "feat: add new feature"
```

**自动执行流程**:

1. **pre-commit hook** 触发
2. **lint-staged** 运行
   - 对 `*.ts` 文件运行 `eslint --fix`
   - 对 `*.ts` 文件运行 `prettier --write`
   - 对 `*.json`, `*.md` 文件运行 `prettier --write`
3. 如果有修改，自动添加到 commit
4. **commit-msg hook** 触发
5. **commitlint** 检查 commit message 格式
6. 如果全部通过，提交成功

### 3. 手动检查

```bash
# 检查所有代码
npm run lint
npm run type-check
npm run format:check

# 修复问题
npm run lint:fix
npm run format
```

## Commit Message 示例

### ✅ 正确示例

```bash
git commit -m "feat: add intelligent diff parser"
git commit -m "fix: correct remote branch resolution"
git commit -m "docs: update README with examples"
git commit -m "refactor: extract categorizeFile function"
git commit -m "perf: optimize diff parsing performance"
git commit -m "chore: update dependencies"
```

### ❌ 错误示例

```bash
git commit -m "update code"           # 缺少 type
git commit -m "Added new feature"     # 错误的 type，应该是 feat
git commit -m "fix:no space"          # type 后缺少空格
git commit -m "WIP"                   # 不符合规范
```

## 配置文件清单

```
.
├── .husky/
│   ├── pre-commit          # Git pre-commit hook
│   └── commit-msg          # Git commit-msg hook
├── .prettierrc.json        # Prettier 配置
├── .prettierignore         # Prettier 忽略文件
├── eslint.config.mjs       # ESLint 配置
├── commitlint.config.mjs   # Commitlint 配置
├── tsconfig.json           # TypeScript 配置
└── package.json            # npm scripts 和 lint-staged 配置
```

## IDE 集成

### VS Code

推荐安装以下插件：

1. **ESLint** (`dbaeumer.vscode-eslint`)
2. **Prettier** (`esbenp.prettier-vscode`)
3. **EditorConfig** (`editorconfig.editorconfig`)

**设置** (`.vscode/settings.json`):

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

## 持续集成 (CI)

建议在 CI 环境中运行：

```bash
npm run type-check    # TypeScript 类型检查
npm run lint          # ESLint 检查
npm run format:check  # Prettier 格式检查
npm run build         # 构建检查
```

## 故障排除

### Husky hooks 不工作

```bash
# 重新安装 hooks
npm run prepare
```

### ESLint 缓存问题

```bash
# 清除缓存
rm -rf node_modules/.cache
npm run lint
```

### Prettier 和 ESLint 冲突

项目已配置 `eslint-config-prettier` 来禁用与 Prettier 冲突的 ESLint 规则。如果遇到冲突，请检查配置。

## 贡献指南

1. 遵循已配置的代码规范
2. 确保所有 lint 和格式检查通过
3. 使用规范的 commit message
4. 提交前运行 `npm run type-check`
