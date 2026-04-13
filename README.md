# codex-auto

这是 `codex-autonomy` 的产品源码仓库，不是某个活跃自治目标仓库。这里维护的是通用控制面、模板、CLI、测试和示例约定；真正被安装和被自治推进的，是你指定的目标仓库。

`codex-supervisor` 负责安装、体检、状态汇总、提案/任务流转、prompt 输出和必要的阻断处理，不直接碰 Codex 内部数据库、automation TOML、SQLite 或其他未公开接口。

## 快速开始

1. 确认本机有 Node.js 22、npm、Git、PowerShell 7。
2. 运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1`，把 `codex-autonomy` 构建并安装到全局 npm 前缀。
3. 在目标仓库优先使用 `codex-autonomy ...`。例如：`codex-autonomy install --target <repoB>`。
4. 在目标仓库运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1`。
5. 在目标仓库运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`，这是 worker 的唯一正式验收门。
6. 在目标仓库运行 `codex-autonomy doctor` 查看环境与控制面健康状况；目标仓库成为 Git 仓库后，再运行 `codex-autonomy prepare-worktree` 创建专用 background worktree。
7. 初次本地闭环推荐先显式绑定线程，再走目标流：`codex-autonomy bind-thread --report-thread-id <thread-id>` -> `codex-autonomy intake-goal ...` -> `codex-autonomy generate-proposal` -> `codex-autonomy approve-proposal --goal-id <goalId>`。仓库第一次绑定原线程时，`--report-thread-id` 不能省略。

## 日常命令

- 标准路径：`codex-autonomy <command>`。
- `codex-autonomy install --target <repo>`：把控制面安装到目标仓库，不覆盖已有文件。
- `codex-autonomy upgrade-managed --target <repo> [--apply]`：生成或应用受管控制面的引导式升级计划。
- `codex-autonomy rebaseline-managed --target <repo>`：把 advisory managed drift 重新登记为当前仓库的 repo-specific 基线，不改文件内容，只更新 `autonomy/install.json` 元数据。
- `codex-autonomy bind-thread --report-thread-id <threadId>`：把目标仓库的原线程绑定为唯一汇报线程。
- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1`：构建并安装 `codex-autonomy` 到全局 npm 前缀。
- `codex-autonomy bootstrap`：补齐当前仓库缺失控制面文件；非 Git 目录允许执行，但不会进入可运行 automation 态。
- `codex-autonomy doctor`：检查 Node、Git、PowerShell、Codex 进程、关键文件、schema、锁、worktree 健康。
- `codex-autonomy intake-goal --title <title> --objective <objective> --run-mode <sprint|cruise> [--report-thread-id <threadId>]`：把自然语言目标规范化为待确认 goal。仓库第一次绑定原线程时必须提供 `--report-thread-id`；后续沿用已绑定线程时可以省略。
- `codex-autonomy generate-proposal [--goal-id <goalId>]`：为最早的可生成 `awaiting_confirmation` goal 生成本地保守 proposal fallback，不物化 `tasks.json`，也不会覆盖已有待确认 proposal。
- `codex-autonomy approve-proposal --goal-id <goalId>`：把提案物化为任务并激活该 goal。
- `codex-autonomy set-run-mode <goal-id> <sprint|cruise>`：切换目标运行模式。
- `codex-autonomy review`：执行 review gate；基础检查会跑 `smoke`、控制面一致性检查，以及可选的 `scripts/review.local.ps1`。
- `codex-autonomy report`：输出当前 goal、任务、verify/review/commit 的摘要。
- `codex-autonomy status`：汇总 goal、任务、blockers、上次结果、是否适合下一轮 automation。
- `codex-autonomy prepare-worktree`：创建或校验专用 background worktree；主仓库或 background worktree dirty 时会拒绝继续。
- `codex-autonomy emit-automation-prompts`：输出 Planner / Worker / Reviewer / Reporter / Sprint runner 五类 prompt 与建议 cadence。
- `codex-autonomy pause` / `resume`：暂停或恢复自治循环。
- `codex-autonomy unblock <task-id>`：关闭对应 blocker，并按依赖与 ready 窗口策略恢复任务到 `ready` 或 `queued`。
- `codex-autonomy merge-autonomy-branch`：在 review 通过且无 blocker 时，把 `codex/autonomy` fast-forward 合并回当前干净分支。

## 开发者回退

- 如果还没做全局安装，或者只是在源码仓库里临时验证，可以先构建再用源码入口：`npm --prefix tools/codex-supervisor run build` 后执行 `node tools/codex-supervisor/dist/cli.js <command>`。
- 这是回退路径，不是日常标准路径；标准安装后应优先使用 `codex-autonomy <command>`。

## Repo 控制面

- `AGENTS.md`：硬规则与运行约定。
- `.agents/skills/$autonomy-plan`、`$autonomy-work`、`$autonomy-intake`、`$autonomy-review`、`$autonomy-report`、`$autonomy-sprint`：repo skills。
- `.codex/environments/environment.toml`：Windows setup 与 `verify` / `smoke` / `review` actions。
- `.codex/config.toml`：repo 级兜底配置，给新 turn 提供 `model = "gpt-5.4"`、`model_reasoning_effort = "xhigh"`、`service_tier = "fast"`。
- `autonomy/goals.json`、`autonomy/proposals.json`、`autonomy/tasks.json`、`autonomy/state.json`、`autonomy/settings.json`、`autonomy/results.json`、`autonomy/blockers.json`：自治真源。
- `autonomy/verification.json`：goal 级 closeout gate；体检、安全、健壮性类 goal 只有在 required verification axis 清零后才能真正完成。
- `autonomy/results.json` 是线程摘要时间、summary kind/reason、goal transition 元数据的 canonical source；`state.json` 里的同名时间字段只保留兼容回退意义。
- `autonomy/journal.md`：每次 run 只追加一条记录。
- `scripts/verify.ps1`：唯一验收门。
- `scripts/review.ps1`：基础效果检查门，会校验控制面一致性；项目级更深的效果检查可以追加到 `scripts/review.local.ps1`。

## 运行模型

仓库当前支持 `goal / proposal / task` 三层数据，以及 `sprint / cruise` 两种运行模式，再配合 `review / report` 两个收口动作。

- `goal`：目标本体，先进入 `awaiting_confirmation`，确认后进入 `approved` / `active`。
- `proposal`：Planner 对当前 goal 生成的首版任务提案。
- `task`：真正被 worker 执行的最小工作单元。
- `cruise cadence`：稳态巡航频率，指 Planner / Worker / Reviewer 在后台按固定周期醒来检查是否有可推进项。
- `sprint heartbeat`：冲刺 runner 的唤醒间隔，不是任务时长。它只决定多久再醒一次，不代表一轮必须跑满这么久。
- `kickoff`：goal 刚确认或需要立即推进时的立刻启动动作。kickoff 会先跑一轮，不等下一次 cadence / heartbeat。
- `safe follow-up`：仍然属于已批准 goal 边界内的后续优化项。它会自动并入下一轮，不需要把线程当成审批门。

冲刺模式的关键边界：

- 当前 goal 完成后，如果还有下一个 `approved` goal，同轮可以直接接续，不等下一次 heartbeat。
- `sprint_active=false` 或 `paused=true` 时，不继续推进新的 plan / work / review，只做状态检查和汇报。
- 遇到 blocker、`review_pending`、仓库 dirty 或没有可做任务时，当前轮停止。

## Reporter 与汇报

Reporter 的策略是“成功汇总、异常即时回线程”。

- 正常成功：先落到 Inbox / journal / results，等 heartbeat 汇总回线程。
- 异常、`blocked`、`review_pending`、commit 失败：立即回线程，避免用户长时间等不到信号。
- 成功摘要只负责汇报，不负责卡住下一轮执行；只要没有越过已批准 goal 边界，后续 follow-up 会继续自动推进。
- 这意味着“完成了”不等于“立刻刷线程”，而是“先记录，再按汇总节奏回报”；只有异常需要打断这个节奏。

## Automation 说明

`emit-automation-prompts` 会输出五类 prompt：

- Planner
- Worker
- Reviewer
- Reporter
- Sprint runner

Sprint runner 的默认工作方式是有预算地连续闭环推进，遇到安全的 follow-up 直接接着跑，遇到重大决策才停下来写 blocker。

关于模型字段要注意一件事：

- 心跳 automation 的模型字段在不同持久化路径里不一定都能保留。
- 所以 repo 里的 `.codex/config.toml` 是兜底配置，负责给当前项目和新 turn 提供稳定默认值。
- 也就是说，automation 侧能配置时用 automation 配置，不能持久化时靠 repo `.codex/config.toml` 托底。

## Review 扩展点

- 默认 `scripts/review.ps1` 会先跑 `scripts/smoke.ps1`，再检查 `autonomy/state.json`、`goals.json`、`tasks.json`、`results.json`、`settings.json` 的基础一致性。
- 如果仓库需要更贴近业务效果的检查，可以在目标仓库额外放一个 `scripts/review.local.ps1`；基础 review 会自动调用它。
- `scripts/review.local.ps1` 适合放页面冒烟、接口探测、样例数据回归、关键输出校验这类项目特定逻辑。

## 结果语义

- `status` 和 `report` 会优先展示“当前 goal 的最近 planner/worker/review/commit 结果”，不再把历史 goal 的执行结果混进当前 goal 摘要。
- 如果当前 goal 还没有自己的执行结果，但最近一次 worker/review/commit 属于别的 goal，输出里会明确给出 `results_scope_note`。
- 当仓库还没有任何已记录运行时，`summary_kind` 会显示为 `none`，`summary_reason` 会明确说明 `No recorded autonomy run yet.`，不再伪装成成功。
- `goal_transition` 只认 `autonomy/results.json` 里显式记录的 transition 元数据，不再靠历史 completed goals 反推。

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
- `status` 现在会额外给出 `automation_state`。常见值包括：
  - `ready`：有可推进项，且运行时检查通过
  - `idle_completed`：已批准工作已经完成，当前只是空闲，不是异常
  - `idle_no_work`：当前没有 active/approved/proposal work
  - `blocked` / `review_pending` / `paused` / `needs_confirmation`：需要先处理对应原因
- 自动提交只允许进入 `codex/autonomy`，不会自动 `push`、`PR`、`merge` 或 `deploy`。
- 当前受控 commit helper 只会 stage 自治控制面 allowlist：`autonomy/*`、`AGENTS.md`、`.agents/skills/*`、`.codex/*`、`scripts/*`；混入其他路径会直接拒绝提交。
- 非 Git 目录允许 `bootstrap`，但 `status` 不会给出可运行 automation 的结论。
- `ready_for_automation=false` 常见原因包括：没有 active goal、存在 blocker、仓库 dirty、background worktree 缺失或 dirty、Codex app 未运行、cycle lock 正在占用、目标仍在等待首次确认。
- `upgrade_state=managed_advisory_drift` 不是阻断。它表示 repo-specific 或 live state 文件和最新产品模板不同，但当前仍可继续跑；如果你确认这些差异就是新的本地基线，可以执行 `codex-autonomy rebaseline-managed --target <repo>` 把它登记为新 baseline。
