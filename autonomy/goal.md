# Objective

检查当前 codex-auto 的安全性、健壮性、可用性与上手难度、扩展性，形成问题清单并逐项修复高优先级问题。

## Success Criteria

- 按安全性、健壮性、可用性与上手难度、扩展性输出问题清单
- 修复高优先级安全或数据一致性问题
- 修复高优先级健壮性或流程阻断问题
- 改进至少一项可用性或上手难度问题
- 所有改动通过 scripts/verify.ps1 与必要回归测试

## Constraints

- 只修改必要源文件和 autonomy/*，不触碰未公开 Codex 内部接口
- 保持 Windows 原生 PowerShell、本地 Git 与 background worktree 方案

## Out of Scope

- 不引入 GUI
- 不接入私有 automation 存储
