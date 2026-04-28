# Security Policy

Codex Telegram Bridge gives Telegram users access to a local Codex session that
can run commands and edit files. Treat a paired Telegram account as remote
control of the configured project directory.

## Supported Versions

Security fixes are applied to the latest version on the default branch.

## Reporting a Vulnerability

Please open a private advisory or contact the maintainer privately before
publishing details. Include:

- affected version or commit
- steps to reproduce
- expected impact
- suggested mitigation, if known

## Hardening Checklist

- Keep `CODEX_APP_SERVER_URL` bound to `127.0.0.1`.
- Use `codex-tg policy allowlist` after pairing your Telegram account.
- Keep `~/.codex/telegram-bridge/.env` private.
- Use a dedicated Telegram bot token for this bridge.
- Review `/file` and `/diff` output before forwarding it elsewhere.
