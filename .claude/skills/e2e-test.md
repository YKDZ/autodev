---
name: e2e-test
description: 运行 autodev 的端到端（E2E）生命周期测试，验证 issue 拾取、PR 创建、agent 提交、完成评论、@autodev 重新触发的完整流程
---

# E2E Lifecycle Test

运行 `src/e2e/lifecycle.test.ts` 验证 autodev 全流程工作正常。

## 环境变量要求

```bash
# 必需：启用 E2E 测试（否则测试被 skipIf 跳过）
AUTO_DEV_E2E_ENABLED=1

# GitHub App 认证
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY="$(cat /path/to/private-key.pem)"
GITHUB_APP_INSTALLATION_ID=<installation-id>

# Agent API
ANTHROPIC_BASE_URL=<api-base-url>  # 例如 https://api.deepseek.com/anthropic
ANTHROPIC_API_KEY=<api-key>
```

## 运行方式

```bash
cd /workspaces/autodev
pnpm vitest run src/e2e/lifecycle.test.ts --reporter=verbose --test-timeout=600000
```

## 测试流程

1. **beforeAll**: 克隆仓库到 `.e2e-workspace/e2e-<random>`，配置 git identity 和 auth URL，通过环境变量设置配置（不再使用 auto-dev.config.mjs），创建 agent 定义文件，创建 GitHub issue（标签 `auto-dev:ready`）
2. **Test 1 — 拾取与 PR 创建**: 等待协调器拾取 issue、创建 PR，验证 PR 评论包含 BOT_MARKER
3. **Test 2 — Agent 提交**: 等待 agent 至少完成一次提交到 PR
4. **Test 3 — 完成评论**: 验证协调器在 PR 上发布完成评论
5. **Test 4 — @autodev 重新触发**: 发布含 `@autodev` 的评论，等待 agent 再次提交并验证

## 配置说明

所有配置通过环境变量传入（替代旧的 `auto-dev.config.mjs`）：

| 环境变量                        | 默认值            | 说明                           |
| ------------------------------- | ----------------- | ------------------------------ |
| `AUTO_DEV_POLL_INTERVAL_SEC`    | 30                | 轮询间隔（秒）                 |
| `AUTO_DEV_MAX_DECISION_PER_RUN` | 20                | 每次运行最大决策数             |
| `AUTO_DEV_MAX_IMPL_CYCLES`      | 5                 | 最大实现循环数                 |
| `AUTO_DEV_DEFAULT_AGENT`        | `"full-pipeline"` | 默认 agent 名称                |
| `AUTO_DEV_AGENTS`               | 内置 5 个 agent   | JSON 字符串，覆盖 agent 注册表 |
| `AUTO_DEV_AGENTS_DIR`           | `.claude/agents`  | agent 定义文件目录             |

## 已知故障模式

### 1. Devcontainer 绑定挂载失败

症状: `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist`

原因: Docker 守护进程无法访问容器内部的路径（例如 `.e2e-workspace/e2e-xxx/tools/auto-dev/worktrees/issue-N`），因为该路径不在 Docker 主机上。

当前处理: `DevcontainerManager.start()` 会捕获异常并返回 `""`，协调器降级为本地执行 agent。

根本修复: 将工作树创建在 Docker 主机可访问的路径上（即 bind-mount 的卷内）。

### 2. 配置文件加载失败

症状: `[auto-dev] No auto-dev.config.{ts,mjs,js} found`

当前处理: 自动使用内置默认值。

### 3. Git push 网络超时

症状: `git push` 挂起 135+ 秒，然后 `Couldn't connect to server`

修复: `commitAndPush()` 使用 `GIT_HTTP_LOW_SPEED_TIME=20` + `GIT_HTTP_LOW_SPEED_LIMIT=1000`，并带退避重试（3 次）。

### 4. `--force-with-lease` 被拒绝

症状: `stale info` 错误

修复: `tryPush()` 改用 `--force`（仅协调器推送这些分支，强制推送安全）。

### 5. Auto-merge 提前触发

症状: PR 在 agent 提交之前就合并了

修复: 协调器的退出事件处理中，`tryPush()` 在 `enableAutoMerge()` 之前调用。

## 关键文件

- `src/e2e/lifecycle.test.ts` — E2E 测试主体
- `src/config/loader.ts` — 配置加载（环境变量）
- `src/orchestrator/orchestrator.ts` — 协调器主逻辑
- `src/workspace-manager/git-manager.ts` — Git 操作（init 空提交 + git exclude）
- `src/workspace-manager/devcontainer-manager.ts` — Devcontainer 管理（优雅降级）
- `Dockerfile` + `docker-entrypoint.sh` — Docker 部署配置

## 清理

测试的 `afterAll` 会自动：停止协调器、关闭并删除 PR 分支、关闭 issue、删除临时工作区。

## E2E Docker 测试

要在 Docker 容器中运行完整 E2E 测试（使用真实 devcontainer 配置）：

```bash
# 构建镜像
docker build -t auto-dev -f tools/auto-dev/Dockerfile .

# 启动容器（务必挂载仓库根目录）
docker run -d --name auto-dev-e2e \
  -v /workspaces/autodev:/workspace \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e GITHUB_REPOSITORY=YKDZ/autodev \
  -e GITHUB_APP_ID=<app-id> \
  -e GITHUB_APP_PRIVATE_KEY="$(cat /path/to/key)" \
  -e GITHUB_APP_INSTALLATION_ID=<id> \
  -e ANTHROPIC_BASE_URL=<url> \
  -e ANTHROPIC_API_KEY=<key> \
  auto-dev

# 查看日志
docker logs -f auto-dev-e2e
```

注意：容器入口脚本克隆到 `/opt/repo`，工作树也创建于此。要使 devcontainer 正常工作，需确保路径在 Docker 主机上可见。当前入口脚本在 `/opt/repo` 而非 `/workspace` 下操作，这是一个已知限制。
