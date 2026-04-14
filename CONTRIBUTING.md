# Contributing

中文摘要：欢迎提 issue 和 PR。请先保持改动小、验证完整、文档和公开接口同步。

## Before You Start

- For small fixes, open a focused pull request directly.
- For larger product or workflow changes, open an issue first so the scope and public surface are clear.
- Avoid unrelated cleanup in the same change.

## Local Setup

Prerequisites:

- Node.js 22
- npm
- Git
- PowerShell 7

Install dependencies for the CLI package:

```powershell
npm --prefix tools/codex-supervisor install
```

## Expected Verification

Run the narrowest checks that match your change. For most product changes, run:

```powershell
npm --prefix tools/codex-supervisor run build
npm --prefix tools/codex-supervisor run test
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

If your change only touches docs, keep the diff focused and at least make sure the repository stays free of malformed patch output.

## Change Guidelines

- Keep Windows-native flows working first.
- Preserve existing public command names and stable control-surface files unless the change explicitly updates that contract.
- Do not add dependencies, fallback layers, or new config knobs without a concrete need.
- Keep README and other public docs aligned with command behavior.
- Update tests when the public workflow, CLI contract, or control-surface semantics change.

## Pull Request Notes

Please include:

- what changed
- why it changed
- what you verified
- any remaining risk or follow-up

If a change affects install, upgrade, bind-thread, report, or router behavior, call that out explicitly.

## Review Expectations

PRs are easier to review when they:

- isolate one problem
- include the smallest meaningful verification
- avoid rewriting unrelated files
- explain any behavior change at the trust boundary

## License

By contributing to this repository, you agree that your contributions will be released under the MIT License used by this project.
