# Objective

建立一个 Windows 原生 Codex 自治项目控制面，所有自治状态都由 repo 内文件驱动，所有运行规则都明确、可校验、可恢复。

## Success Criteria

- Codex app 能读取 repo 级 `AGENTS.md` 和 repo skills。
- `.codex/environments/environment.toml` 能定义 Windows setup script，以及 `verify` 和 `smoke` 两个 actions。
- `scripts/setup.windows.ps1` 可重复执行且不覆盖已有内容。
- `scripts/verify.ps1` 是唯一正式验收门。

## Constraints

- 不触碰 Codex 内部数据库、automation TOML、SQLite 或其他未公开接口。
- 不自动 `commit`、`push` 或 `deploy`。
- 所有写入 `autonomy/*` 的动作都必须先拿 `autonomy/locks/cycle.lock`。
- 时间统一为 UTC ISO 8601，路径统一为 repo-relative forward-slash。

## Out of Scope

- GUI dashboard。
- 自动提交、自动推送、自动部署。
- Windows hooks。
- 直接操控 Codex app 内部状态。

