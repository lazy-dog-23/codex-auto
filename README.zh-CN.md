# codex-auto

[English](README.md)

`codex-auto` 的作用很直接：你给一个仓库设定目标，它负责让 Codex 在已批准边界内持续自动推进这个目标。

这个仓库保存的是这套能力本身的产品源码：CLI、repo-local 控制面、router skills、模板、测试和安装/升级逻辑。真正被自动推进的，是你安装了 `codex-autonomy` 的目标仓库，不是这个源码仓本身。

`codex-supervisor` 负责安装、体检、线程绑定、状态/汇报、提案与任务物化、prompt 输出和必要的阻断处理，不直接碰 Codex 内部数据库、automation TOML、SQLite 或其他未公开接口。

## 本仓库提供什么

- repo-local 自治控制面安装与升级
- 线程绑定的 operator / reporting 工作流
- `goal / proposal / task` 状态管理
- 全局 router skill 与 relay manual-audit skill 分发
- 已安装目标仓 `README.md` section 托管能力
- Windows-first 验证与 worktree 准备流程

## 前置条件

- Windows
- Node.js 22
- npm
- Git
- PowerShell 7
- 可正常运行的 Windows Codex App

## 安装

### 本地开发安装

```powershell
npm --prefix tools/codex-supervisor install
npm --prefix tools/codex-supervisor run build
```

### 安装机器级 CLI

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1
codex-autonomy --version
```

### 安装到目标仓库

1. 确认本机有 Node.js 22、npm、Git、PowerShell 7。
2. 运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1`，把 `codex-autonomy` 构建并安装到全局 npm 前缀，同时在当前机器的 `CODEX_HOME/skills/personal` 下同步分发全局 `codex-autonomy-router` 和 `codex-relay-manual-audit` skills。
3. 在目标仓库优先使用 `codex-autonomy ...`。例如：`codex-autonomy install --target <repoB>`。
4. 在目标仓库运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1`。
5. 在目标仓库运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`，这是 worker 的唯一正式验收门。
6. 在目标仓库运行 `codex-autonomy doctor` 查看环境与控制面健康状况；目标仓库成为 Git 仓库后，再运行 `codex-autonomy prepare-worktree` 创建专用 background worktree。
7. 初次本地闭环优先在当前 Codex 线程里直接运行 `codex-autonomy bind-thread`，它会在当前环境暴露 `CODEX_THREAD_ID` 时自动把当前线程绑定为 `report_thread_id`；如果当前环境拿不到线程身份，再回退到 `codex-autonomy bind-thread --report-thread-id <thread-id>`。绑定完成后再走目标流：`codex-autonomy intake-goal ...` -> `codex-autonomy generate-proposal` -> `codex-autonomy approve-proposal --goal-id <goalId>`。

## 升级

- 重新运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1`，刷新机器级 CLI 和全局 skills。
- 对已安装目标仓执行 `codex-autonomy upgrade-managed --target <repo> [--apply]`。
- 如果目标仓的 advisory drift 就是你想保留的新基线，执行 `codex-autonomy rebaseline-managed --target <repo>`。

## 常见问题

- 如果 `codex-autonomy bind-thread` 拿不到当前线程身份，就显式使用 `codex-autonomy bind-thread --report-thread-id <thread-id>`。
- 如果 `prepare-worktree` 拒绝继续，先确认目标仓是有效 Git 仓库，并且工作树没有超出受管 allowlist 的脏改动。
- 如果目标仓 README 超过托管 section 限制，安装会继续，但 README 只会进入 advisory 模式，不会被自动覆盖。

## 日常命令

- 标准路径：`codex-autonomy <command>`。
- 可先用 `codex-autonomy --version` 确认当前机器级 CLI 版本；全局 router skill 也会把它作为“是否需要先刷新本机产品版本”的判断信号之一。
- 机器级自然语言入口：安装完 `scripts/install-global.ps1` 后，新项目线程可以直接说“把 auto 装进当前项目”“升级当前项目里的 auto”“刷新当前项目里的 auto”“目标是……”“确认提案”“用冲刺模式推进这个目标”“用巡航模式推进这个目标”“继续当前目标”“汇报当前情况”等自然语言；全局 `codex-autonomy-router` skill 会先检查是否已安装控制面，必要时自动执行 `install -> setup -> doctor -> prepare-worktree`，已安装项目则先尝试 `upgrade-managed --apply` 对齐到当前本地产品版本。当前线程身份可用时，router 会在首次接入时自动调用 `codex-autonomy bind-thread` 绑定当前 operator thread；如果当前线程和已绑定的 `report_thread_id` 不一致，router 会阻断并要求显式 rebind，而不会静默沿用旧绑定继续执行。
- relay completion event 现在带固定 envelope：`[Codex Relay Callback]`、`Event-Type: codex.relay.dispatch.completed.v1`，以及 `BEGIN_CODEX_RELAY_CALLBACK_JSON` / `END_CODEX_RELAY_CALLBACK_JSON` 之间的机读 JSON。router / operator 要把它当成状态回传，而不是新的 goal intake。
- `codex-autonomy install --target <repo>`：把控制面安装到目标仓库，不覆盖已有文件。
- `codex-autonomy upgrade-managed --target <repo> [--apply]`：生成或应用受管控制面的引导式升级计划。
- `codex-autonomy rebaseline-managed --target <repo>`：把 advisory managed drift 重新登记为当前仓库的 repo-specific 基线，不改文件内容，只更新 `autonomy/install.json` 元数据。
- 目标仓 `README.md` 现在只按 section 托管：只更新 `<!-- codex-autonomy:managed:start -->` 到 `<!-- codex-autonomy:managed:end -->` 之间的内容；默认要求整文件 `<= 24 KiB`、托管 section `<= 8 KiB`。README 超限、含 NUL、marker 损坏或不是常规文本文件时，只给 advisory warning，不自动覆盖，也不会被 `rebaseline-managed` 当成新基线。
- `codex-autonomy bind-thread [--report-thread-id <threadId>]`：优先把当前 Codex 线程绑定为唯一汇报线程；如果当前环境没有公开当前线程身份，再显式提供 `--report-thread-id`。
- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1`：构建并安装 `codex-autonomy` 到全局 npm 前缀。
- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-router-skill.ps1`：只同步/刷新这台机器上的全局 `codex-autonomy-router` 和 `codex-relay-manual-audit` skills，不重装 CLI。
- `codex-autonomy bootstrap`：补齐当前仓库缺失控制面文件；非 Git 目录允许执行，但不会进入可运行 automation 态。
- `codex-autonomy doctor`：检查 Node、Git、PowerShell、Codex 进程、关键文件、schema、锁、worktree 健康。
- `codex-autonomy intake-goal --title <title> --objective <objective> --run-mode <sprint|cruise> [--report-thread-id <threadId>]`：把自然语言目标规范化为待确认 goal。仓库第一次绑定原线程时必须提供 `--report-thread-id`；后续沿用已绑定线程时可以省略。
- `codex-autonomy generate-proposal [--goal-id <goalId>]`：为最早的可生成 `awaiting_confirmation` goal 生成本地保守 proposal fallback，不物化 `tasks.json`，也不会覆盖已有待确认 proposal。
- `codex-autonomy approve-proposal --goal-id <goalId>`：把提案物化为任务并激活该 goal。
- `codex-autonomy set-run-mode <goal-id> <sprint|cruise>`：切换目标运行模式。
- `codex-autonomy review`：执行 review gate；基础检查会跑 `smoke`、控制面一致性检查，以及可选的 `scripts/review.local.ps1`。当 diff 可提交时，它还会自动执行受控 closeout commit，并立刻对齐 background worktree。
- `codex-autonomy report`：输出当前 goal、任务、verify/review/commit 的摘要。
- `codex-autonomy status`：汇总 goal、任务、blockers、上次结果、是否适合下一轮 automation。
- `codex-autonomy prepare-worktree`：创建或校验专用 background worktree；如果只有 allowlisted control-surface drift，会先同步或重对齐后继续，dirty 超出受管范围时才拒绝继续。
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
- `.codex/config.toml`：repo 级兜底配置，给新 turn 提供 `approval_policy = "never"`、`sandbox_mode = "workspace-write"`、`model = "gpt-5.4"`、`model_reasoning_effort = "xhigh"`、`service_tier = "fast"`。
- `autonomy/goals.json`、`autonomy/proposals.json`、`autonomy/tasks.json`、`autonomy/state.json`、`autonomy/settings.json`、`autonomy/results.json`、`autonomy/blockers.json`：自治真源。
- `autonomy/verification.json`：goal 级 closeout gate；体检、安全、健壮性类 goal 只有在 required verification axis 清零后才能真正完成。
- `autonomy/results.json` 是线程摘要时间、summary kind/reason、goal transition 元数据的 canonical source；`state.json` 里的同名时间字段只保留兼容回退意义。
- `autonomy/journal.md`：每次 run 只追加一条记录。
- `scripts/verify.ps1`：唯一验收门。
- `scripts/review.ps1`：基础效果检查门，会校验控制面一致性；通常通过 `codex-autonomy review` 调用。项目级更深的效果检查可以追加到 `scripts/review.local.ps1`。

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

已知限制（基于当前 Windows Codex App 实测）：

- `heartbeat + MINUTELY` 当前属于已知不可靠路径：调度器可能只推进下一次触发时间，但不实际向线程投递执行。
- 这类行为发生时，常见表现是“时间在滚动，但没有真正跑起来”；因此不要把它当成唯一可靠的持续推进机制。
- 需要稳定后台调度时，优先使用 `cron + HOURLY`，或改用外部调度器触发有界执行。
- 这个源码仓现在附带了一组外部调度测试脚本：`scripts/run-codex-relay-scheduled-test.ps1` 和 `scripts/register-codex-relay-scheduled-test.ps1`，用于通过公开 relay CLI 走 `Task Scheduler -> relay -> 绑定线程`，不依赖私有 Codex 存储。
- 这条 relay runner 现在会把每次调用明确标记成“外部调度唤醒”，要求目标线程先检查 `codex-autonomy status`，且只有 `thread_binding_state=bound_to_current` 时才允许推进一次 bounded loop；否则按 mismatch/不可运行状态收口并停止。
- 如果下一次唤醒发现主仓库留下了可恢复的 closeout diff，`status` 会明确提示先运行 `codex-autonomy review`；外部调度 runner 也会先补跑一次 `scripts/verify.ps1 + codex-autonomy review` 做自愈，再重新检查是否可继续。
- 这组 relay scheduled runner 的默认组合现在是 `TimeoutSec=300`、`StatusPollAttempts=22`、`StatusPollIntervalSec=15`，并默认开启 `RecoverOnTimeout`；目标是优先等到同轮收口，超时时也直接走 recover，而不是过早把单轮 bounded loop 放掉。
- 对 `timed_out + active turn` 这类长回合，scheduled runner 不会在任务进程里同步阻塞等待 `relay_dispatch_recover` 收尾；它会先记录可恢复状态并退出，下一轮启动前先检查上一条 dispatch 是否仍在运行，避免重复向同一绑定线程投递新消息。
- 这组 scheduled runner 现在默认把日志写到 `%CODEX_HOME%`；如果没有该环境变量，则回退到 `%USERPROFILE%\\.codex\\scheduled-runs\\<repo-name>` 或 `%USERPROFILE%\\.codex\\scheduled-relay-runs\\<repo-name>`，避免外部调度产物把目标仓库弄脏。

近期验证结论（2026-04-16）：

- 已在真实 Windows Codex App 绑定线程上跑通 `长回合 -> relay_send_wait 超时 -> relay_dispatch_status 收口成功 -> 后续短消息继续成功` 这条恢复链。
- 同一轮里，绑定线程完成了一次 verify closeout，并把当前 active goal 标记为 completed。
- 因当前受限环境无法注册 Windows `Task Scheduler` 任务，且 runner 里额外拉起 app-server 会触发 `spawn EPERM`，这次会话没有在系统调度层完成最终验收；已验证的是 relay 入口、绑定线程执行和超时恢复语义。

## 新项目线程怎么接

做完一次机器级安装后，新项目里的 Codex 线程可以直接用自然语言触发：

- `把 auto 装进当前项目`
- `目标是：……`
- `直接做这个目标`
- `继续当前目标`
- `汇报当前情况`

全局 router skill 的工作方式是：

1. 先检查本机有没有 `codex-autonomy`
2. 对“装进当前项目 / 开始自治 / 继续推进”这类请求，优先从当前这份产品源码仓库自动执行一次机器级刷新
3. 再检查当前项目有没有控制面
4. 没有就自动安装控制面并跑 `setup -> doctor -> prepare-worktree`
5. 已安装就先尝试对齐到当前本地产品版本
6. 最后把你的自然语言请求路由到 intake / proposal / status / report / review / merge

补充约束：

- `汇报当前情况` 优先以 `codex-autonomy status` 为准，不把先前 `doctor` 的观察混成当前阻塞原因。
- `确认提案` 必须走 `codex-autonomy approve-proposal --goal-id <goalId>`，不能只口头确认。
- `用冲刺模式推进这个目标` 和 `继续当前目标` 在 sprint 目标上必须收口到 repo-local `$autonomy-sprint` 的单轮闭环，而不是直接跳过控制面去改业务代码。
- `用巡航模式推进这个目标` 先切到 `cruise`，再按当前 ready 状态给出下一步；不要把 cruise 偷偷改成自由发挥式 sprint。

这意味着：

- 新项目第一次接入，不需要你先手工判断“装没装”
- `scripts/install-global.ps1` 现在会强制刷新本地全局包；router skill 在接管/推进类请求前也可以直接调用它，因此就算你本地改了 `codex-auto` 但还没 bump version，也能优先吃到最新源码
- 后续新项目线程会优先按最新本地产品逻辑接管

## Review 扩展点

## Relay 手动审计

`codex-autonomy` 在 relay 联调里保持“手动操作台”定位，不额外引入 repo 内 relay CLI 或自治控制面 schema。推荐做法是：

1. 在源线程使用 `threadRelay` MCP 工具操作目标项目线程
2. 优先用全局 `codex-relay-manual-audit` skill 跑固定场景矩阵
3. 先判定问题属于 `codex-thread-relay-mcp` 还是 `codex-autonomy`
4. 修复后先跑最小复现，再回到完整矩阵复测

固定场景矩阵至少包括：

- trusted project 枚举
- 创建空线程
- brand-new remembered thread 首次 `relay_send_wait`
- `relay_dispatch` 按 `threadId`、精确 `threadName`、唯一 `query` 复用
- `relay_dispatch_async` create-and-send / 复用已有线程
- `relay_dispatch_status` 查询完成态与 `callbackStatus`
- `relay_dispatch_deliver` 重试 `pending` / `failed` callback
- `relay_dispatch_recover` 恢复可安全续等的 target turn，并补送 `pending` / `failed` callback
- 无效 `threadId`
- 模糊 `query`
- busy target
- timeout
- reply missing
- app-server unavailable
- same-project nested callback 自动投递、`callback_pending` 与手动 deliver
- worker 中断、stale queued/running dispatch、recoverable timed-out turn 的恢复
- relay completion callback event 必须被 router 当成状态/汇报事件，而不是新的 goal intake

- 默认 `scripts/review.ps1` 会先跑 `scripts/smoke.ps1`，再检查 `autonomy/state.json`、`goals.json`、`tasks.json`、`results.json`、`settings.json` 的基础一致性。
- 如果仓库需要更贴近业务效果的检查，可以在目标仓库额外放一个 `scripts/review.local.ps1`；基础 review 会自动调用它。
- `scripts/review.local.ps1` 适合放页面冒烟、接口探测、样例数据回归、关键输出校验这类项目特定逻辑。

## 结果语义

- `status` 和 `report` 会优先展示“当前 goal 的最近 planner/worker/review/commit 结果”，不再把历史 goal 的执行结果混进当前 goal 摘要。
- `status` 现在还会显式给出 `current_thread_id`、`thread_binding_state` 和 `thread_binding_hint`，用来区分“repo 运行时已就绪”和“当前线程是不是已绑定的 operator thread”。
- `install`、`upgrade-managed`、`rebaseline-managed` 的结果现在也会给出 `current_thread_id`、`thread_binding_state`、`next_operator_action`、`next_operator_command`，用来说明当前线程接下来应该绑定、继续还是显式 rebind。
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
- `install` 的 `automation_ready` 只表示环境前置条件基本齐全；目标仓库仍然需要 `report_thread_id` 和可推进 goal/task，`status` 才会变成 `ready_for_automation=true`。如果当前线程身份可用但还没绑定，优先在该线程里运行 `codex-autonomy bind-thread`；如果当前线程身份不可用，则显式提供 `--report-thread-id`。
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

## 许可证

本仓库使用 MIT License 发布。见 [LICENSE](LICENSE)。
