# Security Policy

中文摘要：如果你发现了可能影响 `codex-auto` 或 `codex-autonomy` 安装/升级/线程绑定/状态控制面的安全问题，请不要直接公开 exploit 细节，先通过私下渠道联系维护者。

## Supported Versions

This repository currently supports security fixes on:

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Older commits or forks | No |

## What To Report

Please report issues that could affect:

- command execution boundaries
- thread binding or report-thread misuse
- unsafe file writes or path traversal
- privilege escalation through install, upgrade, or worktree flows
- accidental disclosure of repo-local or operator-local data
- unsupported reads from private Codex internals

## Preferred Reporting Path

1. Use GitHub private vulnerability reporting for this repository when that option is available.
2. If private reporting is not available, open a minimal public issue asking for a private contact path.
3. Do not include exploit code, secrets, tokens, private thread ids, or full reproduction payloads in a public issue.

## What To Include

Please include:

- affected command or workflow
- expected behavior
- observed behavior
- impact assessment
- smallest safe reproduction steps
- whether the issue depends on Windows, Git state, or a Codex thread context

## Response Expectations

The maintainer aims to:

- acknowledge receipt within 5 business days
- confirm whether the report is in scope
- coordinate a fix or mitigation before public disclosure when the issue is valid

## Disclosure Guidance

Please wait for a coordinated fix, mitigation, or maintainer approval before publishing exploit details.
