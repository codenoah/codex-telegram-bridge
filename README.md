# Codex Telegram Bridge

Continue the same OpenAI Codex app-server thread from your terminal and from
Telegram.

This bridge is intentionally small. It starts a local `codex app-server`, opens
your normal `codex --remote` terminal UI, and runs a Telegram bot that sends
messages into the active Codex thread. Your local Codex installation remains the
source of truth.

## Features

- Shared Codex app-server thread between terminal and Telegram.
- Telegram pairing and allowlist access control.
- Inline `Cancel` button for active Codex turns.
- Command/file-change approval prompts with inline buttons.
- Live progress updates for commands, tool calls, patches, and final answers.
- Capped `Workspace changes` and `Diff preview` on completed turns.
- Explicit `/diff`, `/file`, and `/logs` commands for follow-up inspection.
- Project cwd control without exposing Codex directly to the internet.

## Requirements

- OpenAI Codex CLI with `app-server` support.
- Node.js 20 or newer.
- Telegram bot token from BotFather.
- `tmux` and `curl` are recommended. The bridge can run without `tmux`, but
  tmux gives you durable app-server and bridge panes.

## Install

```sh
npm install -g codex-telegram-bridge
```

### Using nvm

`codex-telegram-bridge` works with `nvm`, but npm global packages are installed
per Node.js version. Install it under the Node version you normally use for
Codex:

```sh
nvm use 22
npm install -g codex-telegram-bridge
```

If `codex-tg` or `codex-remote` disappears after `nvm use <version>`, install
the package again for that Node version. The active `node` on your `PATH` must be
Node.js 20 or newer.

## Install From Source

```sh
git clone https://github.com/codenoah/codex-telegram-bridge.git
cd codex-telegram-bridge
npm install
npm run build
npm link
```

If you do not use `npm link`, run the scripts directly from this directory.

## Quick Start

Save your Telegram bot token:

```sh
codex-tg token
```

Start Codex from the project directory you want Codex to work in:

```sh
cd /path/to/project
codex-remote
```

The wrapper starts `codex app-server` on `ws://127.0.0.1:17345`, starts the
Telegram bridge when a token is configured, then opens:

```sh
codex --remote ws://127.0.0.1:17345 --no-alt-screen
```

## Pair Telegram

DM your bot. It will reply with a pairing code. Approve it locally:

```sh
codex-tg pair <code>
```

After pairing, lock the bot down so unknown users cannot request pairing codes:

```sh
codex-tg policy allowlist
```

## Telegram Commands

- `/status` shows the active thread and bridge state.
- `/new` creates a fresh Codex thread.
- `/cancel` interrupts the active Codex turn.
- `/cwd` shows the current project directory.
- `/cwd <path>` changes the project directory for the next Codex thread.
- `/logs` shows recent progress lines.
- `/diff` shows the last turn diff, or the current git diff as a fallback.
- `/diff <path>` shows a file-specific diff.
- `/file <path>` sends a capped text preview of a file.
- `/file <path> --all` raises the cap for an explicit full-file request.
- `/thread <id>` switches Telegram to an existing thread id.
- Any other text is sent to the active Codex thread.

When a Telegram message starts a Codex turn, the working status message includes
an inline `Cancel` button. If you send another message while Codex is already
working, the bridge asks whether to add it to the current turn, cancel the
current turn, or discard it.

## Configuration

The bridge reads real environment variables first, then
`~/.codex/telegram-bridge/.env`.

```sh
CODEX_APP_SERVER_URL=ws://127.0.0.1:17345
CODEX_APP_SERVER_HEALTH_URL=http://127.0.0.1:17345
CODEX_TELEGRAM_STATE_DIR=~/.codex/telegram-bridge
CODEX_BRIDGE_CWD=/absolute/path/to/project
CODEX_MODEL=
CODEX_REASONING_EFFORT=
CODEX_TELEGRAM_PROGRESS=1
CODEX_TELEGRAM_STREAM_EDITS=0
CODEX_TELEGRAM_DIFF_MAX_CHARS=30000
CODEX_TELEGRAM_FILE_PREVIEW_MAX_CHARS=12000
CODEX_TELEGRAM_FILE_ALL_MAX_CHARS=60000
```

You can also change the saved cwd locally:

```sh
codex-tg cwd /absolute/path/to/project
```

## Security Notes

- Keep the app-server listener on `127.0.0.1`.
- Do not expose the app-server WebSocket directly to the internet.
- Do not commit Telegram bot tokens or `~/.codex/telegram-bridge/.env`.
- Use `codex-tg policy allowlist` after pairing.
- `/file` is limited to the configured cwd and refuses paths outside it.

Codex can run commands and edit files. Treat Telegram access to this bridge as
remote access to your local development machine.

## Development

```sh
npm run check
```

Useful local commands:

```sh
npm run build
npm run start
npm run access -- status
```

## License

MIT

## Acknowledgements

This project was inspired by the Telegram workflow in Claude Code's Telegram
plugin. Codex Telegram Bridge is an independent implementation for OpenAI Codex
app-server sessions and is not affiliated with Anthropic or OpenAI.
