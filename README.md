# codex-auto

[中文说明](README.zh-CN.md)

`codex-auto` is the product repository for `codex-autonomy`. It is not meant to be the active target repo being autonomously worked on. This repo contains the reusable control surface, CLI, templates, skills, tests, and install/upgrade logic that get applied to another repository.

`codex-supervisor` manages installation, doctor checks, status and report flows, proposal and task materialization, prompt generation, and blocking behavior. It does not read or mutate private Codex databases, automation TOML, SQLite state, or other unsupported internal surfaces.

## What This Repo Provides

- Repo-local autonomy control surface installation and upgrade
- Thread-bound operator/reporting workflow
- Goal / proposal / task state management
- Global router skill and relay manual-audit skill distribution
- Managed `README.md` section support for installed target repos
- Windows-first verification and worktree preparation flows

## Quick Start

1. Install prerequisites: Node.js 22, npm, Git, and PowerShell 7.
2. Run `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1`.
3. In a target repository, install the control surface with `codex-autonomy install --target <repo>`.
4. In that target repository, run `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1`.
5. Run `codex-autonomy doctor`.
6. If the target is a Git repo, run `codex-autonomy prepare-worktree`.
7. Bind the current operator thread with `codex-autonomy bind-thread`. If the current environment does not expose a thread identity, fall back to `codex-autonomy bind-thread --report-thread-id <thread-id>`.

## Natural-Language Entry

After `scripts/install-global.ps1` finishes, a new Codex thread can drive installed repos through the global router skill. Common phrases include:

- `把 auto 装进当前项目`
- `升级当前项目里的 auto`
- `目标是……`
- `确认提案`
- `用冲刺模式推进这个目标`
- `继续当前目标`
- `汇报当前情况`

When the current thread identity is available, the router auto-binds that thread on first use. If the current thread does not match the already-bound `report_thread_id`, the router blocks and requires an explicit rebind instead of silently continuing on the old binding.

Relay completion events are treated as status callbacks, not as new goal intake. They use the fixed envelope:

- `[Codex Relay Callback]`
- `Event-Type: codex.relay.dispatch.completed.v1`
- `BEGIN_CODEX_RELAY_CALLBACK_JSON`
- `END_CODEX_RELAY_CALLBACK_JSON`

## Core Commands

- `codex-autonomy install --target <repo>`
- `codex-autonomy upgrade-managed --target <repo> [--apply]`
- `codex-autonomy rebaseline-managed --target <repo>`
- `codex-autonomy bind-thread [--report-thread-id <threadId>]`
- `codex-autonomy doctor`
- `codex-autonomy prepare-worktree`
- `codex-autonomy intake-goal --title <title> --objective <objective> --run-mode <sprint|cruise>`
- `codex-autonomy generate-proposal`
- `codex-autonomy approve-proposal --goal-id <goalId>`
- `codex-autonomy review`
- `codex-autonomy report`
- `codex-autonomy status`
- `codex-autonomy pause` / `resume`
- `codex-autonomy merge-autonomy-branch`

## Developer Fallback

If you are validating from source without a global install, build first and use the CLI entry directly:

```powershell
npm --prefix tools/codex-supervisor run build
node tools/codex-supervisor/dist/cli.js <command>
```

## Target README Management

Installed target repos do not hand over the entire `README.md`. Only the section between these markers is managed:

- `<!-- codex-autonomy:managed:start -->`
- `<!-- codex-autonomy:managed:end -->`

Default limits:

- total README size `<= 24 KiB`
- managed section size `<= 8 KiB`

Oversized files, files with NUL bytes, broken markers, or non-text files stay in advisory mode and are not overwritten automatically.

## Repo Layout

- `AGENTS.md`: stable operating rules
- `.agents/skills/$autonomy-*`: repo-local autonomy skills
- `.codex/environments/environment.toml`: shared Windows setup plus `verify`, `smoke`, and `review` actions
- `.codex/config.toml`: repo fallback config with `approval_policy = "never"` and `sandbox_mode = "workspace-write"`
- `autonomy/*.json`: canonical repo-local autonomy state
- `scripts/verify.ps1`: worker acceptance gate
- `scripts/review.ps1`: baseline effect-review gate
- `tools/codex-supervisor`: TypeScript CLI implementation

## Verification

Use the narrowest checks that match the work:

```powershell
npm --prefix tools/codex-supervisor run build
npm --prefix tools/codex-supervisor run test
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

## License

This repository is released under the MIT License. See [LICENSE](LICENSE).

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
