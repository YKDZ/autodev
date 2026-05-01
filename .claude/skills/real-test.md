---
name: real-test
description: |
  在 YKDZ/autodev 仓库上对 autodev 系统进行端到端真实测试（非 Vitest E2E）。
  通过 Docker 启动 autodev orchestrator，然后在 GitHub 上用真实 issue 验证
  issue claim、PR 创建、worktree 创建、devcontainer 启动、decision 创建与解决、
  多轮文件编辑、PR @re-trigger 等全部功能。
  当 TODO_REAL_TEST.md 要求"真实测试"时使用此 skill。
---

# 真实测试 Skill（Real Test in Docker）

## 环境约束（必须理解）

本开发环境本身是一个 devcontainer，运行在宿主机上：

- **Dev container 路径** `/workspaces/autodev` = **宿主机路径** `/opt/dev/autodev`
- Docker daemon 属于宿主机，bind mount 使用的是**宿主机路径**
- autodev 容器需要与宿主机 Docker daemon 共享路径，因此所有持久化数据必须放在
  `/opt/dev/autodev/`（宿主机侧）= `/workspaces/autodev/`（dev container 侧）
- autodev 容器内的 `AUTO_DEV_WORKSPACE_ROOT` 与宿主机路径**完全相同**（DooD 要求）

## 文件布局

```
/workspaces/autodev/          (dev container 内，== /opt/dev/autodev/ 宿主机)
├── docker-compose.test.yml   # 测试用 compose 文件
├── autodev-data/             # orchestrator 工作区根 (== /opt/dev/autodev/autodev-data/)
│   ├── .git                  # worktree 依赖此目录（由 git clone 填充）
│   ├── tools/auto-dev/
│   │   ├── state/            # socket、DB、dist 副本
│   │   │   ├── auto-dev.sock
│   │   │   ├── autodev.db
│   │   │   ├── auto-dev      # CLI wrapper (bash)
│   │   │   └── dist/         # 每次 orchestrator 启动时从 /opt/auto-dev/dist/ 同步
│   │   ├── worktrees/        # 每个 issue 的 git worktree
│   │   │   └── issue-N/
│   │   └── logs/
│   │       └── <run-id>/audit.jsonl
└── ykdz-s-autodevbot.*.pem   # GitHub App 私钥（复制到 /opt/dev/autodev/）
```

## 准备步骤（首次）

### 1. 构建 Docker 镜像

```bash
cd /workspaces/autodev
pnpm build   # 或 vite build
docker build -t autodev:latest .
```

### 2. 准备私钥

```bash
cp /workspaces/autodev/ykdz-s-autodevbot.2026-04-28.private-key.pem \
   /opt/dev/autodev/ykdz-s-autodevbot.2026-04-28.private-key.pem
```

### 3. 初始化工作区仓库

工作区根必须是一个 git 仓库（worktree 需要 `.git`）：

```bash
WORKSPACE=/opt/dev/autodev/autodev-data
mkdir -p "$WORKSPACE"
# 如果还不是 git 仓库
if [ ! -d "$WORKSPACE/.git" ]; then
  git clone https://github.com/YKDZ/autodev.git "$WORKSPACE"
fi
```

### 4. 启动 orchestrator

```bash
cd /workspaces/autodev
docker compose -f docker-compose.test.yml up -d
docker logs autodev-test --follow   # 观察启动日志
```

期待看到：

```
[auto-dev] Decision socket listening on /opt/dev/autodev/autodev-data/tools/auto-dev/state/auto-dev.sock
[auto-dev] Running startup cleanup...
```

## 诊断命令

### 查看 orchestrator 日志

```bash
docker logs autodev-test 2>&1 | tail -50
docker logs autodev-test --follow 2>&1
docker logs autodev-test --since 5m 2>&1 | grep -E "error|Error|warn"
```

### 查看数据库状态

```bash
# 所有 runs
docker exec autodev-test node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/dev/autodev/autodev-data/tools/auto-dev/state/autodev.db');
console.log('runs:', JSON.stringify(db.prepare('SELECT id, status, issue_number FROM workflow_runs').all()));
console.log('decisions:', JSON.stringify(db.prepare('SELECT id, status, title FROM decision_blocks ORDER BY rowid DESC LIMIT 5').all()));
" 2>/dev/null | grep -v Warning
```

### 读取 audit log

```bash
RUN_ID="<run-uuid>"
docker exec autodev-test python3 -c "
import json
lines = open('/opt/dev/autodev/autodev-data/tools/auto-dev/logs/$RUN_ID/audit.jsonl').readlines()
for line in lines:
    e = json.loads(line)
    if e.get('type') == 'phase_transition':
        chunk = e['payload'].get('chunk', '')
        try:
            data = json.loads(chunk)
        except:
            continue
        if data.get('type') == 'assistant':
            for c in data['message'].get('content', []):
                if c.get('type') == 'tool_use' and c.get('name') == 'Bash':
                    print('CMD:', c['input'].get('command', '')[:300])
        if data.get('type') == 'user':
            for c in data['message'].get('content', []):
                if c.get('type') == 'tool_result':
                    print('RESULT:', str(c.get('content',''))[:300])
" 2>&1
```

### 手动测试 request-decision（回归）

```bash
# 在 devcontainer 镜像中直接测试
docker run --rm \
  --mount type=bind,source=/opt/dev/autodev/autodev-data/tools/auto-dev/state,target=/var/run/auto-dev \
  -e AUTO_DEV_SOCKET=/var/run/auto-dev/auto-dev.sock \
  -e AUTO_DEV_RUN_ID=test-run-manual \
  -e PATH=/var/run/auto-dev:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  vsc-autodev-963df81e7aab5602732c85e15e976c9837e3da81cb4a22bc3bef135641a7e69a:latest \
  bash -c 'auto-dev request-decision \
    --workflow-run-id "test-run-manual" \
    --title "Test?" \
    --options '"'"'["A","B"]'"'"' \
    --recommendation "A"' 2>&1
# 期待: {"error":"Decision limit reached",...} 而非 {"error":"Invalid JSON..."}
# "Decision limit reached" 说明 JSON/schema 验证已通过
```

### 验证 git worktree 是否可用

```bash
CONTAINER_ID="<worktree-container-id>"
docker exec "$CONTAINER_ID" bash -c 'git status 2>&1; git rev-parse --show-toplevel 2>&1'
# 期待: 正常显示 git status，不出现 "not a git repository"
```

## 已知 Bug 及修复记录

### Bug 1：`--options '["A","B"]'` 被报 "Invalid JSON in decision request"

- **根因**：socket server 用 `DecisionRequestSchema` 验证，`options` 期望
  `{key, label, description}[]` 对象数组，但 agent 传入字符串数组
- **修复**：`src/cli/request-decision.ts` — 将字符串元素自动转换为对象：
  ```ts
  if (typeof o === "string") return { key: o, label: o, description: o };
  ```

### Bug 2：State dir 里的 `dist` 不随新版本更新

- **根因**：`ensureStateDirs` 只在 `dist/` 不存在时复制，重启后旧版本继续生效
- **修复**：`src/state-store/state-store.ts` — 改为每次启动都强制同步
  （`cpSync(..., { recursive: true, force: true })`）

### Bug 3：Devcontainer 内 `git commit` 失败（"not a git repository"）

- **根因**：worktree 的 `.git` 文件指向 `gitdir: /opt/dev/autodev/autodev-data/.git/worktrees/issue-N`，
  但该路径未挂载进 devcontainer/fallback container
- **修复**：`src/workspace-manager/devcontainer-manager.ts` — 在启动 devcontainer
  和 fallback container 时，额外挂载主 repo 的 `.git` 目录：
  ```ts
  "--mount", `type=bind,source=${mainGitDir},target=${mainGitDir}`,
  ```

### Bug 4：socket-server 返回 "Invalid JSON" 实为 Zod schema 校验失败

- **现象**：`JSON.parse` 成功，但 `DecisionRequestSchema.parse` 抛出异常，
  catch 语句误将其报告为 "Invalid JSON"
- **注意**：排查时应区分"JSON 语法错误"与"schema 验证错误"，
  建议在 catch 里区分 `SyntaxError` 和其他错误

### Bug 5：Decision limit 计数包含所有 run 的历史 decision

- **现象**：`remainingDecisions: 0` 而 DB 里有大量旧 run 的 resolved decision
- **原因**：`decisionCount` 是 per-run 的，不是全局的；但 `pending` 状态的旧
  decision（从未被 resolve）会占用 slot
- **处理**：清理测试中遗留的 `pending` 状态 decision，或增大 `maxDecisionPerRun`

## 修改代码后的更新流程

每次修改源码后需要：

```bash
# 1. 类型检查
pnpm tsc --noEmit

# 2. 重新构建镜像
docker build -t autodev:latest .

# 3. 重启 orchestrator（state dir 里的 dist 会自动同步）
docker compose -f docker-compose.test.yml down
docker compose -f docker-compose.test.yml up -d

# 4. 验证 state dist 已更新
docker exec autodev-test grep -n "normalizedOptions\|要验证的关键字" \
  /opt/dev/autodev/autodev-data/tools/auto-dev/state/dist/cli/request-decision.js
```

## docker-compose.test.yml 要点

- `AUTO_DEV_WORKSPACE_ROOT` 与宿主机路径完全相同（`/opt/dev/autodev/autodev-data`）
- volumes 中 workspace data 也使用相同路径（`/opt/dev/autodev/autodev-data:/opt/dev/autodev/autodev-data`）
- Docker socket bind-mount（`/var/run/docker.sock`）允许 orchestrator 管理 devcontainer
- 私钥通过 `/run/secrets/` 只读挂载

## 测试完成标准

以下全部通过即测试完成：

- [x] Issue claim：orchestrator 检测到 `auto-dev:ready` label 并认领
- [x] Worktree 创建：`tools/auto-dev/worktrees/issue-N/` 存在
- [x] Devcontainer 启动：fallback container 或 devcontainer 启动成功
- [x] PR 创建：auto-dev bot 自动创建 PR 并附 init commit
- [x] Decision 创建：agent 运行 `auto-dev request-decision`，DB 出现 pending record
- [x] Decision 解决：`resolve-decision` 后 agent 继续执行
- [x] 文件编辑提交：agent 创建文件并 `git commit`，PR 显示 `additions > 0`
- [x] PR 推送：`tryPush` 将 agent commit 推到 remote
- [ ] PR @re-trigger：PR 评论 `@autodev` 触发 agent 在原 worktree 继续工作
