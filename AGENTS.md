# Repo Control Surface

这份仓库把控制面收口在 repo 内。任何自动化工作都必须先读这里，再读对应 skill 和 `autonomy/*` 状态文件。

## 硬规则

1. 一次只处理一个任务，禁止并行拿多个任务。
2. `scripts/verify.ps1` 是 worker 的唯一验收门。
3. 只改必要源文件和 `autonomy/*`，不要扩散到无关区域。
4. 遇到歧义、冲突、缺失上下文时，先写 blocker，再停止。
5. 手工 `commit`、`push`、`deploy` 统统禁止；自动提交只允许自治流程在 `codex/autonomy` 分支上执行。
6. 所有写入 `autonomy/*` 的动作，先拿 `autonomy/locks/cycle.lock`。
7. `autonomy/*` 下的 JSON 必须原子写入，时间统一用 UTC ISO 8601，路径统一用 repo-relative forward-slash。
8. 若存在 `autonomy/operations/pending.json`，先恢复或汇报该 pending operation，禁止开启新的 bounded loop。

## 运行约定

- Planner 只维护 `queued` / `ready` 窗口，最多保留 5 个 `ready` 任务，不修改业务代码。
- Worker 每轮只拿一个 `ready` 任务，做最小改动，跑验证，更新状态后停止。
- 第一次验证失败记为 `verify_failed`；第二次失败或真实歧义记为 `blocked` 并新增 blocker。
- dirty background worktree 立即置为 `review_pending` 并停机。
- Reviewer 运行 `scripts/review.ps1` 做效果检查和结论收口，不扩大任务范围。
- Reporter 只有异常、blocked、review_pending、commit 失败等情况立即回线程；正常成功按 heartbeat 汇总，详细运行记录留在 Inbox 和 journal。
- Sprint runner 的 heartbeat 只是唤醒间隔，不是任务时长；每次唤醒只推进单个任务闭环，当前 goal 完成且存在下一个 approved goal 时同轮直接接续。
- 官方 thread heartbeat 使用 entry-lease + end-of-turn self-rescheduling：每轮先查 `status` / 锁状态；确认可执行且空闲后，先把同一个 heartbeat 临时设为 30 分钟 entry lease，再开始 repo 写入或长验证；干净完成且仍有 ready next task 时再把同一个 heartbeat 设为 1 分钟快速续跑；遇到 blocker、review_pending、needs_confirmation、dirty worktree 或线程不匹配时退回安全节拍或暂停。
- 遇到 proposal、verification、dirty worktree、closeout、环境、scope 或线程边界时，先用 `codex-autonomy decide --json` 或 `$autonomy-decision` 做统一边界裁决；只有 `decision_outcome=auto_continue` / `auto_repair_once` 才继续，`ask_human` / `reject_or_rewrite` 必须停下。
- 已授权长期自治只允许通过 `codex-autonomy create-successor-goal --auto-approve` 创建最小 successor goal；必须先由 `status` 给出 `next_automation_step=create_successor_goal`，且 `decide --json` 给出 `decision_outcome=auto_continue`。
- `create-successor-goal --auto-approve` 必须在绑定线程内运行；非绑定线程只允许汇报或通过 relay 让绑定线程恢复。
- `sprint_active=false` 或 `paused=true` 时只做状态检查和汇报，不做新的 plan/work/review 推进。
- Sprint runner 遇到 blocker、review_pending 或无任务时停下。
- Worker、Reviewer 或 Sprint runner 如果生成了“下一步建议”，只允许目标内 follow-up 自动入队；一旦改变验收、约束或范围，必须写 blocker 等线程确认。
- 非 Git 目录允许 `bootstrap`，但不允许进入可运行 automation 态。

## 线程入口

- 原线程是唯一操作入口，`report_thread_id` 是所有摘要和异常回传的锚点。
- 线程内的自然语言动作固定收口为：`把 auto 装进当前项目`、`修一下这个报错`、`小改一下`、`目标是……`、`确认提案`、`确认提案并继续`、`用冲刺模式推进这个目标`、`用巡航模式推进这个目标`、`汇报当前情况`、`暂停当前目标`、`继续当前目标`、`处理下一个目标`、`快速续跑`、`任务完成后 1 分钟继续`、`自动判断能不能继续`、`只有越界或高风险时问我`、`按第二条处理 blocker`、`把这个 goal 收窄为 checklist/manual lane`、`保留 heartbeat 继续推进`、`合并自治分支`。
- `goal.md` 只镜像当前 active goal；真正的目标队列和批准边界以 `goals.json`、`proposals.json`、`slices.json`、`tasks.json` 为准。

## Skills

- `.agents/skills/$autonomy-plan/SKILL.md`
- `.agents/skills/$autonomy-work/SKILL.md`
- `.agents/skills/$autonomy-intake/SKILL.md`
- `.agents/skills/$autonomy-review/SKILL.md`
- `.agents/skills/$autonomy-report/SKILL.md`
- `.agents/skills/$autonomy-sprint/SKILL.md`
- `.agents/skills/$autonomy-decision/SKILL.md`

## Shared Environment

- `.codex/environments/environment.toml` 由 repo 共享，包含 Windows setup script，以及 `verify`、`smoke` 和 `review` 三个 actions。
