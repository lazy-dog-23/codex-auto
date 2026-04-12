# codex-auto

Windows 原生 Codex 自治项目，控制面全部放在 repo 内，`codex-supervisor` 只负责初始化、体检、worktree 准备、状态汇总和 prompt 输出。

## 快速开始

1. 确认本机有 Node.js 22、npm、Git、PowerShell 7。
2. 在仓库根目录运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1`。
3. 运行 `npm --prefix tools/codex-supervisor run build` 生成 `dist/cli.js`。
4. 运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`，这是唯一正式验收门。
5. 运行 `node tools/codex-supervisor/dist/cli.js doctor` 查看环境与控制面健康状况。
6. 目录已经是 Git 仓库后，再运行 `node tools/codex-supervisor/dist/cli.js prepare-worktree` 创建专用 background worktree。

## 日常命令

- `node tools/codex-supervisor/dist/cli.js bootstrap`：补齐缺失控制面文件；非 Git 目录允许执行，但不会进入可运行 automation 态。
- `node tools/codex-supervisor/dist/cli.js doctor`：检查 Node、Git、PowerShell、Codex 进程、关键文件、schema、锁、worktree 健康。
- `node tools/codex-supervisor/dist/cli.js status`：汇总任务数量、当前状态、blockers、上次结果、是否适合下一轮 automation。
- `node tools/codex-supervisor/dist/cli.js prepare-worktree`：创建或校验专用 background worktree；主仓库或 background worktree dirty 时会拒绝继续。
- `node tools/codex-supervisor/dist/cli.js emit-automation-prompts`：输出 Planner / Worker prompt 与建议 cadence。
- `node tools/codex-supervisor/dist/cli.js unblock <task-id>`：关闭对应 blocker，并按依赖与 ready 窗口策略恢复任务到 `ready` 或 `queued`。

## Repo 控制面

- `AGENTS.md`：硬规则与运行约定。
- `.agents/skills/$autonomy-plan`、`.agents/skills/$autonomy-work`：Planner / Worker repo skill。
- `.codex/environments/environment.toml`：Windows setup 与 `verify` / `smoke` actions。
- `autonomy/tasks.json`、`autonomy/state.json`、`autonomy/blockers.json`：任务、状态、blocker 真源。
- `autonomy/journal.md`：每次 run 只追加一条记录。
- `scripts/verify.ps1`：唯一验收门。

## Background Worktree

- 默认路径：仓库同级目录下的 `<repo-name>.__codex_bg`。
- 默认分支：`codex/background`。
- supervisor 只准备和校验 worktree，不会自动 `commit`、`push` 或 `deploy`。

## Git safe.directory

`scripts/setup.windows.ps1` 会在检测到当前目录是 Git 仓库时，幂等地把主仓库和已存在的 background worktree 写入全局 `safe.directory`。`prepare-worktree` 在创建或校验 background worktree 后，也会自动补齐主仓库和 background worktree 的 `safe.directory`，避免 Windows 上的 dubious ownership 阻塞 Git 命令。

## 任务样例

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "task-example",
      "title": "Add a minimal smoke assertion",
      "status": "queued",
      "priority": "P1",
      "depends_on": [],
      "acceptance": ["smoke script passes"],
      "file_hints": ["scripts/smoke.ps1"],
      "retry_count": 0,
      "last_error": null,
      "updated_at": "2026-04-12T00:00:00Z"
    }
  ]
}
```

## 运行边界

- 第一版允许改代码和跑验证，但禁止自动 `commit`、`push`、`deploy`。
- 非 Git 目录允许 `bootstrap`，但 `status` 不会给出可运行 automation 的结论。
- `ready_for_automation=false` 常见原因包括：没有任务、存在 blocker、仓库 dirty、background worktree 缺失或 dirty、Codex app 未运行、cycle lock 正在占用。
