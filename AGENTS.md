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

## 运行约定

- Planner 只维护 `queued` / `ready` 窗口，最多保留 5 个 `ready` 任务，不修改业务代码。
- Worker 每轮只拿一个 `ready` 任务，做最小改动，跑验证，更新状态后停止。
- 第一次验证失败记为 `verify_failed`；第二次失败或真实歧义记为 `blocked` 并新增 blocker。
- dirty background worktree 立即置为 `review_pending` 并停机。
- Reviewer 运行 `scripts/review.ps1` 做效果检查和结论收口，不扩大任务范围。
- Reporter 只有异常、blocked、review_pending、commit 失败等情况立即回线程；正常成功按 heartbeat 汇总，详细运行记录留在 Inbox 和 journal。
- Sprint runner 的 heartbeat 只是唤醒间隔，不是任务时长；每次唤醒只推进单个任务闭环，当前 goal 完成且存在下一个 approved goal 时同轮直接接续。
- `sprint_active=false` 或 `paused=true` 时只做状态检查和汇报，不做新的 plan/work/review 推进。
- Sprint runner 遇到 blocker、review_pending 或无任务时停下。
- 非 Git 目录允许 `bootstrap`，但不允许进入可运行 automation 态。

## Skills

- `.agents/skills/$autonomy-plan/SKILL.md`
- `.agents/skills/$autonomy-work/SKILL.md`
- `.agents/skills/$autonomy-intake/SKILL.md`
- `.agents/skills/$autonomy-review/SKILL.md`
- `.agents/skills/$autonomy-report/SKILL.md`
- `.agents/skills/$autonomy-sprint/SKILL.md`

## Shared Environment

- `.codex/environments/environment.toml` 由 repo 共享，包含 Windows setup script，以及 `verify`、`smoke` 和 `review` 三个 actions。
