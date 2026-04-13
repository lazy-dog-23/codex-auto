# codex-auto

这是 `codex-autonomy` 的产品源码仓库，不是某个活跃自治目标仓库。这里维护的是通用控制面、模板、CLI、测试和示例约定；真正被安装和被自治推进的，是你指定的目标仓库。

`codex-supervisor` 负责安装、体检、状态汇总、提案/任务流转、prompt 输出和必要的阻断处理，不直接碰 Codex 内部数据库、automation TOML、SQLite 或其他未公开接口。

## 快速开始

1. 确认本机有 Node.js 22、npm、Git、PowerShell 7。
2. 在本仓库运行 `npm --prefix tools/codex-supervisor run build` 生成 `dist/cli.js`。
3. 任选一种方式准备本机 CLI：在源码仓库里直接用 `node tools/codex-supervisor/dist/cli.js ...`，或者先把 `tools/codex-supervisor` 作为本机本地包安装后使用 `codex-autonomy ...`。
4. 把控制面安装到目标仓库：`node tools/codex-supervisor/dist/cli.js install --target <repoB>` 或 `codex-autonomy install --target <repoB>`。
5. 在目标仓库运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1`。
6. 在目标仓库运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`，这是 worker 的唯一正式验收门。
7. 在目标仓库运行 `codex-autonomy doctor` 查看环境与控制面健康状况；目标仓库成为 Git 仓库后，再运行 `codex-autonomy prepare-worktree` 创建专用 background worktree。
8. 初次本地闭环可以直接走：`codex-autonomy intake-goal ...` -> `codex-autonomy generate-proposal` -> `codex-autonomy approve-proposal <goal-id>`。

## 日常命令

- 源码仓库内：`node tools/codex-supervisor/dist/cli.js <command>`。
- 目标仓库内：`codex-autonomy <command>`。
- `codex-autonomy install --target <repo>`：把控制面安装到目标仓库，不覆盖已有文件。
- `codex-autonomy bootstrap`：补齐当前仓库缺失控制面文件；非 Git 目录允许执行，但不会进入可运行 automation 态。
- `codex-autonomy doctor`：检查 Node、Git、PowerShell、Codex 进程、关键文件、schema、锁、worktree 健康。
- `codex-autonomy intake-goal --title <title> --objective <objective> --run-mode <sprint|cruise>`：把自然语言目标规范化为待确认 goal。
- `codex-autonomy generate-proposal [--goal-id <goalId>]`：为最早的可生成 `awaiting_confirmation` goal 生成本地保守 proposal fallback，不物化 `tasks.json`，也不会覆盖已有待确认 proposal。
- `codex-autonomy approve-proposal <goal-id>`：把提案物化为任务并激活该 goal。
- `codex-autonomy set-run-mode <goal-id> <sprint|cruise>`：切换目标运行模式。
- `codex-autonomy review`：执行 review gate 并返回是否允许后续提交或合并。
- `codex-autonomy report`：输出当前 goal、任务、verify/review/commit 的摘要。
- `codex-autonomy status`：汇总 goal、任务、blockers、上次结果、是否适合下一轮 automation。
- `codex-autonomy prepare-worktree`：创建或校验专用 background worktree；主仓库或 background worktree dirty 时会拒绝继续。
- `codex-autonomy emit-automation-prompts`：输出 Planner / Worker / Reviewer / Reporter / Sprint runner 五类 prompt 与建议 cadence。
- `codex-autonomy pause` / `resume`：暂停或恢复自治循环。
- `codex-autonomy unblock <task-id>`：关闭对应 blocker，并按依赖与 ready 窗口策略恢复任务到 `ready` 或 `queued`。
- `codex-autonomy merge-autonomy-branch`：在 review 通过且无 blocker 时，把 `codex/autonomy` fast-forward 合并回当前干净分支。

## Repo 控制面

- `AGENTS.md`：硬规则与运行约定。
- `.agents/skills/$autonomy-plan`、`$autonomy-work`、`$autonomy-intake`、`$autonomy-review`、`$autonomy-report`、`$autonomy-sprint`：repo skills。
- `.codex/environments/environment.toml`：Windows setup 与 `verify` / `smoke` / `review` actions。
- `.codex/config.toml`：repo 级兜底配置，给新 turn 提供 `model = "gpt-5.4"`、`model_reasoning_effort = "xhigh"`、`service_tier = "fast"`。
- `autonomy/goals.json`、`autonomy/proposals.json`、`autonomy/tasks.json`、`autonomy/state.json`、`autonomy/settings.json`、`autonomy/results.json`、`autonomy/blockers.json`：自治真源。
- `autonomy/journal.md`：每次 run 只追加一条记录。
- `scripts/verify.ps1`：唯一验收门。
- `scripts/review.ps1`：效果检查门。

## 运行模型

仓库当前支持 `goal / proposal / task` 三层数据，以及 `sprint / cruise` 两种运行模式，再配合 `review / report` 两个收口动作。

- `goal`：目标本体，先进入 `awaiting_confirmation`，确认后进入 `approved` / `active`。
- `proposal`：Planner 对当前 goal 生成的首版任务提案。
- `task`：真正被 worker 执行的最小工作单元。
- `cruise cadence`：稳态巡航频率，指 Planner / Worker / Reviewer 在后台按固定周期醒来检查是否有可推进项。
- `sprint heartbeat`：冲刺 runner 的唤醒间隔，不是任务时长。它只决定多久再醒一次，不代表一轮必须跑满这么久。
- `kickoff`：goal 刚确认或需要立即推进时的立刻启动动作。kickoff 会先跑一轮，不等下一次 cadence / heartbeat。

冲刺模式的关键边界：

- 当前 goal 完成后，如果还有下一个 `approved` goal，同轮可以直接接续，不等下一次 heartbeat。
- `sprint_active=false` 或 `paused=true` 时，不继续推进新的 plan / work / review，只做状态检查和汇报。
- 遇到 blocker、`review_pending`、仓库 dirty 或没有可做任务时，当前轮停止。

## Reporter 与汇报

Reporter 的策略是“成功汇总、异常即时回线程”。

- 正常成功：先落到 Inbox / journal / results，等 heartbeat 汇总回线程。
- 异常、`blocked`、`review_pending`、commit 失败：立即回线程，避免用户长时间等不到信号。
- 这意味着“完成了”不等于“立刻刷线程”，而是“先记录，再按汇总节奏回报”；只有异常需要打断这个节奏。

## Automation 说明

`emit-automation-prompts` 会输出五类 prompt：

- Planner
- Worker
- Reviewer
- Reporter
- Sprint runner

关于模型字段要注意一件事：

- 心跳 automation 的模型字段在不同持久化路径里不一定都能保留。
- 所以 repo 里的 `.codex/config.toml` 是兜底配置，负责给当前项目和新 turn 提供稳定默认值。
- 也就是说，automation 侧能配置时用 automation 配置，不能持久化时靠 repo `.codex/config.toml` 托底。

## Background Worktree

- 默认路径：仓库同级目录下的 `<repo-name>.__codex_bg`。
- 默认分支：`codex/background`。
- supervisor 只准备和校验 worktree；自治流程可以自动 commit 到 `codex/autonomy`，但不会自动 `push`、`PR`、`merge` 或 `deploy`。

## Git safe.directory

`scripts/setup.windows.ps1` 会在检测到当前目录是 Git 仓库时，幂等地把主仓库和已存在的 background worktree 写入全局 `safe.directory`。`prepare-worktree` 在创建或校验 background worktree 后，也会自动补齐主仓库和 background worktree 的 `safe.directory`，避免 Windows 上的 dubious ownership 阻塞 Git 命令。

## 任务样例

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "task-example",
      "goal_id": "goal-example",
      "title": "Add a minimal smoke assertion",
      "status": "queued",
      "priority": "P1",
      "depends_on": [],
      "acceptance": ["smoke script passes"],
      "file_hints": ["scripts/smoke.ps1"],
      "retry_count": 0,
      "last_error": null,
      "updated_at": "2026-04-12T00:00:00Z",
      "commit_hash": null,
      "review_status": "not_reviewed"
    }
  ]
}
```

## 运行边界

- 产品源码仓库和活跃目标仓库是两件事。这个仓库维护产品源码，安装后才把控制面落到目标仓库。
- `install` 的 `automation_ready` 只表示环境前置条件基本齐全；目标仓库仍然需要 `report_thread_id` 和可推进 goal/task，`status` 才会变成 `ready_for_automation=true`。
- 自动提交只允许进入 `codex/autonomy`，不会自动 `push`、`PR`、`merge` 或 `deploy`。
- 当前受控 commit helper 只会 stage 自治控制面 allowlist：`autonomy/*`、`AGENTS.md`、`.agents/skills/*`、`.codex/*`、`scripts/*`；混入其他路径会直接拒绝提交。
- 非 Git 目录允许 `bootstrap`，但 `status` 不会给出可运行 automation 的结论。
- `ready_for_automation=false` 常见原因包括：没有 active goal、存在 blocker、仓库 dirty、background worktree 缺失或 dirty、Codex app 未运行、cycle lock 正在占用、目标仍在等待首次确认。
