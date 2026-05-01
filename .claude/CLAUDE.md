---
description: autodev 项目概览，适用于所有文件
applyTo: "**/*"
---

# Autodev 项目概览

## 用途

Autodev 是一个 **GitHub 驱动的 AI 代码助手编排系统**。它监听带有 `auto-dev:ready` 标签的 GitHub Issue，自动为每个 Issue 创建独立的 git worktree 和 devcontainer，然后在容器内启动 AI agent（Claude Code）执行编码任务，并将结果以 PR 的形式提交回 GitHub。

核心流程：
1. Orchestrator 轮询 GitHub，发现带标签的 Issue
2. 为该 Issue 创建专属 git worktree 和 devcontainer（支持 devcontainer CLI 或 fallback docker run）
3. 在容器内以 `claude --agent <name>` 方式启动 AI agent
4. Agent 可通过 Unix socket 向 orchestrator 请求人工决策（`auto-dev request-decision`）
5. Agent 完成后创建 PR，orchestrator 发布完成评论
6. 在 PR 中 `@autodev <指令>` 可重新触发 agent 在原 worktree 继续工作

## 技术栈

| 层次 | 技术 |
|------|------|
| 运行时 | Node.js 24，TypeScript ESM |
| 构建 | Vite 8 + `unplugin-dts` |
| 测试 | Vitest 4 |
| 代码质量 | oxlint（含 type-aware）、oxfmt |
| 状态存储 | Node.js 内置 `node:sqlite`（`DatabaseSync`，实验性） |
| Schema 校验 | Zod 4 |
| GitHub 集成 | GitHub App JWT 认证 + `gh` CLI |
| AI Agent | Claude Code（`claude` CLI），通过 ANTHROPIC_* 环境变量配置 |
| 容器化 | Docker（Docker-outside-of-Docker），可用 devcontainer CLI 或 fallback docker run |
| 进程间通信 | Unix Domain Socket（agent ↔ orchestrator 决策请求） |

## 目录结构

```
src/
  cli.ts                   # CLI 入口，注册所有子命令
  index.ts                 # 库导出
  orchestrator/            # 主编排器：Issue 轮询、PR 触发、工作流管理
  workspace-manager/       # Git worktree 创建、devcontainer 启动/停止
  agent-dispatcher/        # Agent 调用适配层（Claude Code adapter）
  decision-service/        # Unix socket 服务端 + 决策管理（DB 读写）
  state-store/             # SQLite 状态存储、锁文件、目录初始化
  config/                  # 配置 schema、加载器、类型定义
  cli/                     # 各子命令实现（start/stop/status/request-decision 等）
  shared/                  # 公共工具：logger、gh-cli 包装、comment 模板、schema、类型
  audit-logger/            # Agent 运行日志（audit.jsonl）
  validation/              # 验证门（运行前检查）
  pr-manager/              # PR 创建与更新
  branch-manager/          # 分支管理
  ssh/                     # SSH 配置（远程 workspace 支持）
  e2e/                     # 端到端测试
  integration/             # 集成测试
```

## 关键配置字段（`AutoDevConfig`）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `defaultAgent` | `"full-pipeline"` | 默认 agent 名称 |
| `pollIntervalSec` | `30` | Issue 轮询间隔（秒） |
| `maxDecisionPerRun` | `20` | 每次运行最大人工决策数 |
| `maxImplCycles` | `5` | 最大实现循环次数 |
| `maxConcurrentRuns` | `3` | 最大并发运行数 |

## 常用命令

```bash
# 开发
pnpm typecheck       # TypeScript 类型检查
pnpm lint            # oxlint 检查
pnpm test            # 单元测试

# CLI
auto-dev start       # 启动 orchestrator
auto-dev status      # 查看运行状态
auto-dev decisions   # 列出待处理决策
auto-dev resolve-decision <id> --choice <value>   # 解决决策
auto-dev request-decision ...  # （在 agent 容器内）请求人工决策
```

## 内置 Agent 列表

| Agent | 说明 |
|-------|------|
| `full-pipeline` | brainstorm → iplan → impl → review → fix 完整流程 |
| `one-shot-fix` | 直接从 Issue 错误描述调查并修复 |
| `spec-only` | 仅生成设计规格并发布到 Issue |
| `impl-only` | 跳过设计，直接实现 |
| `retrigger` | 对已有 PR 分支应用后续指令 |
