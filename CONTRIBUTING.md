# Contributing

Thanks for taking the time to improve Codex Telegram Bridge.

## Development

```sh
bun install
bun run check
```

The bridge intentionally keeps dependencies and setup small. Prefer changes
that preserve the local-only model:

- Codex runs through the official CLI and app-server.
- Telegram is only a control surface.
- State stays on the user's machine.
- Tokens and app-server sockets are never exposed publicly.

## Pull Requests

- Keep PRs focused on one behavior change.
- Update `README.md` when commands, setup, or security behavior changes.
- Do not commit real Telegram tokens, local state, logs, or personal paths.
- Include manual test notes when the change touches Telegram callbacks,
  app-server protocol calls, or file access.
