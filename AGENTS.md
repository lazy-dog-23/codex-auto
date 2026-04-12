# Repo Control Surface

这份仓库把控制面收口在 repo 内。任何自动化工作都必须先读这里，再读对应 skill 和 `autonomy/*` 状态文件。

## 硬规则

1. 一次只处理一个任务，禁止并行拿多个任务。
2. 唯一验收门是 `scripts/verify.ps1`。
3. 只改必要源文件和 `autonomy/*`，不要扩散到无关区域。
4. 遇到歧义、冲突、缺失上下文时，先写 blocker，再停止。
5. 绝不自动 `commit`、`push` 或 `deploy`。
6. 所有写入 `autonomy/*` 的动作，先拿 `autonomy/locks/cycle.lock`。
7. `autonomy/*` 下的 JSON 必须原子写入，时间统一用 UTC ISO 8601，路径统一用 repo-relative forward-slash。

## 运行约定

- Planner 只维护 `queued` / `ready` 窗口，最多保留 5 个 `ready` 任务，不修改业务代码。
- Worker 每轮只拿一个 `ready` 任务，做最小改动，跑验证，更新状态后停止。
- 第一次验证失败记为 `verify_failed`；第二次失败或真实歧义记为 `blocked` 并新增 blocker。
- dirty background worktree 立即置为 `review_pending` 并停机。
- 非 Git 目录允许 `bootstrap`，但不允许进入可运行 automation 态。

## Skills

- `.agents/skills/$autonomy-plan/SKILL.md`
- `.agents/skills/$autonomy-work/SKILL.md`

## Shared Environment

- `.codex/environments/environment.toml` 由 repo 共享，包含 Windows setup script，以及 `verify` 和 `smoke` 两个 actions。
