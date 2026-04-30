# Changelog

## 0.1.3

- Send final Telegram responses as new messages so completion notifications fire.
- Delete the transient `Codex is working...` status message when a turn completes.

## 0.1.2

- Switched Telegram polling to `grammy`.
- Simplified turn updates so Telegram chats show final answers by default.
- Added typing indicators while Codex is working.
- Hid verbose progress logging unless `CODEX_TELEGRAM_PROGRESS=1` is enabled.

## 0.1.1

- Added bridge-routed local notifications with `codex-tg notify`.
- Added the `codex-telegram-notify` Codex skill and automatic first-run skill installation.

## 0.1.0

- Initial local Telegram bridge for Codex app-server.
- Shared terminal and Telegram thread control.
- Pairing and allowlist access control.
- Inline current-turn stop control.
- Progress, diff preview, `/logs`, `/diff`, and `/file` inspection commands.
