---
name: codex-telegram-notify
description: Use when the user asks Codex to send a Telegram notification, completion alert, phone message, or "tell me when done" message through the local Codex Telegram Bridge. Always use `codex-tg notify`; never read Telegram bot tokens or call the Telegram Bot API directly.
---

# Codex Telegram Notify

When the user asks for a Telegram alert, phone notification, completion message, or similar out-of-band status update, use the local bridge command:

```sh
codex-tg notify "message"
```

Do not read `~/.codex/telegram-bridge/.env`.
Do not extract or display `TELEGRAM_BOT_TOKEN`.
Do not call Telegram Bot API directly with `curl`, `fetch`, Node, Python, or any other client.

`codex-tg notify` writes a local queue item under the bridge state directory. The running Telegram bridge process delivers it to allowlisted chats, so the notification follows the same local bridge boundary as normal Telegram integration.

## Usage

- Keep the message short and user-facing.
- Mention the important result, branch, command status, or next action.
- If the command fails because `codex-tg` is missing or the bridge is not running, report that failure in the chat instead of bypassing the bridge.

Example:

```sh
codex-tg notify "Codex finished: npm run check passed. Review branch weekly/week-2026-05-04."
```
