# Codex Telegram Bridge

한국어 | [English](./README.md)

터미널에서 사용하던 동일한 OpenAI Codex app-server 스레드를 Telegram에서도
이어갈 수 있게 해주는 로컬 브리지입니다.

이 브리지는 의도적으로 작게 유지됩니다. 로컬 `codex app-server`를 실행하고,
일반적인 `codex --remote` 터미널 UI를 열며, Telegram 봇이 활성 Codex 스레드로
메시지를 전달합니다. 실제 작업의 기준은 항상 로컬 Codex 설치입니다.

## 기능

- 터미널과 Telegram이 같은 Codex app-server 스레드를 공유합니다.
- Telegram 페어링과 allowlist 기반 접근 제어를 지원합니다.
- 실행 중인 Codex turn을 Telegram의 인라인 `Cancel` 버튼으로 취소할 수 있습니다.
- 명령 실행과 파일 변경 승인 요청을 Telegram 인라인 버튼으로 처리합니다.
- 명령, 도구 호출, 패치, 최종 답변 진행 상태를 실시간으로 보여줍니다.
- 완료된 turn의 `Workspace changes`와 `Diff preview`를 길이 제한과 함께 보여줍니다.
- `/diff`, `/file`, `/logs` 명령으로 후속 확인을 명시적으로 요청할 수 있습니다.
- Codex app-server를 인터넷에 직접 노출하지 않고 프로젝트 cwd를 제어합니다.

## 요구 사항

- `app-server`를 지원하는 OpenAI Codex CLI
- Node.js 20 이상
- BotFather에서 발급한 Telegram bot token
- `tmux`와 `curl` 권장

`tmux` 없이도 브리지를 실행할 수 있지만, `tmux`를 사용하면 app-server와 bridge
pane을 더 오래 유지하기 좋습니다.

## 설치

```sh
npm install -g codex-telegram-bridge
```

처음 `codex-tg` 또는 `codex-remote`를 실행하면 작은 선택적 Codex skill이
없을 때만 `~/.codex/skills/codex-telegram-notify` 아래에 자동 설치됩니다. 이
skill은 앞으로 Codex 세션이 Telegram bot token을 읽거나 Telegram Bot API를
직접 호출하지 않고 `codex-tg notify`를 사용하도록 알려줍니다.

### nvm 사용 시

`codex-telegram-bridge`는 `nvm` 환경에서도 동작합니다. 다만 npm global package는
Node.js 버전별로 따로 설치됩니다. Codex와 함께 주로 사용할 Node 버전에서
설치하세요.

```sh
nvm use 22
npm install -g codex-telegram-bridge
```

`nvm use <version>` 이후 `codex-tg`나 `codex-remote` 명령이 사라졌다면, 해당
Node 버전에 패키지를 다시 설치하면 됩니다. `PATH`에서 잡히는 활성 `node`는
Node.js 20 이상이어야 합니다.

## 소스에서 설치

```sh
git clone https://github.com/codenoah/codex-telegram-bridge.git
cd codex-telegram-bridge
npm install
npm run build
npm link
```

`npm link`를 사용하지 않는다면 이 디렉터리에서 스크립트를 직접 실행하세요.

## 빠른 시작

Telegram bot token을 저장합니다.

```sh
codex-tg token
```

선택적 Codex skill은 `codex-tg` 또는 `codex-remote` 첫 실행 때 자동 설치됩니다.
필요하면 직접 설치하거나 갱신할 수도 있습니다.

```sh
codex-tg install-skill
```

Codex가 작업할 프로젝트 디렉터리에서 Codex를 시작합니다.

```sh
cd /path/to/project
codex-remote
```

이 wrapper는 `ws://127.0.0.1:17345`에서 `codex app-server`를 실행하고, token이
설정되어 있으면 Telegram bridge를 시작한 뒤 다음 명령을 엽니다.

```sh
codex --remote ws://127.0.0.1:17345 --no-alt-screen
```

## Telegram 페어링

봇에게 DM을 보내면 페어링 코드가 응답으로 옵니다. 로컬에서 승인합니다.

```sh
codex-tg pair <code>
```

페어링 후에는 알 수 없는 사용자가 페어링 코드를 요청하지 못하도록 allowlist
정책으로 잠그는 것을 권장합니다.

```sh
codex-tg policy allowlist
```

## Telegram 명령

- `/status`는 활성 thread와 bridge 상태를 보여줍니다.
- `/new`는 새 Codex thread를 만듭니다.
- `/cancel`은 실행 중인 Codex turn을 중단합니다.
- `/cwd`는 현재 프로젝트 디렉터리를 보여줍니다.
- `/cwd <path>`는 다음 Codex thread에서 사용할 프로젝트 디렉터리를 변경합니다.
- `/logs`는 최근 진행 로그를 보여줍니다.
- `/diff`는 마지막 turn diff를 보여주며, 없으면 현재 git diff를 fallback으로 보여줍니다.
- `/diff <path>`는 특정 파일의 diff를 보여줍니다.
- `/file <path>`는 파일의 제한된 텍스트 미리보기를 보냅니다.
- `/file <path> --all`은 명시적인 전체 파일 요청으로 더 큰 제한을 적용합니다.
- `/thread <id>`는 Telegram이 사용할 기존 thread id를 전환합니다.
- 그 외 텍스트는 활성 Codex thread로 전달됩니다.

Telegram 메시지가 Codex turn을 시작하면 작업 상태 메시지에 인라인 `Cancel`
버튼이 표시됩니다. Codex가 이미 작업 중일 때 다른 메시지를 보내면, 브리지는
현재 turn에 추가할지, 현재 turn을 취소할지, 새 메시지를 버릴지 묻습니다.

로컬 세션에서 실행 중인 bridge를 통해 Telegram 알림을 보내려면 다음 명령을
사용하세요.

```sh
codex-tg notify "Codex 작업이 끝났습니다."
```

이 명령은 bridge 프로세스가 처리할 로컬 알림을 queue에 넣습니다. 호출한
프로세스가 Telegram bot token을 읽거나 Telegram Bot API를 직접 호출하지
않습니다.

Codex agent가 이 명령을 자동으로 선택하게 하려면 다음 명령을 실행하세요.

```sh
codex-tg install-skill
```

설치 후 새 Codex 세션을 시작하면 skill이 발견됩니다.

## 설정

브리지는 실제 환경 변수를 먼저 읽고, 그 다음
`~/.codex/telegram-bridge/.env`를 읽습니다.

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

저장된 cwd는 로컬에서도 변경할 수 있습니다.

```sh
codex-tg cwd /absolute/path/to/project
```

## 보안 메모

- app-server listener는 `127.0.0.1`에만 두세요.
- app-server WebSocket을 인터넷에 직접 노출하지 마세요.
- Telegram bot token이나 `~/.codex/telegram-bridge/.env`를 커밋하지 마세요.
- 페어링 후 `codex-tg policy allowlist`를 사용하세요.
- `/file`은 설정된 cwd 안의 경로로 제한되며, cwd 밖의 경로는 거부합니다.

Codex는 명령을 실행하고 파일을 수정할 수 있습니다. 이 브리지에 대한 Telegram
접근 권한은 로컬 개발 머신에 대한 원격 접근 권한으로 취급해야 합니다.

## 개발

```sh
npm run check
```

로컬에서 유용한 명령:

```sh
npm run build
npm run start
npm run access -- status
```

## 라이선스

MIT

## 감사의 말

이 프로젝트는 Claude Code Telegram plugin의 Telegram workflow에서 아이디어를
얻었습니다. 페어링과 allowlist 접근 제어 흐름은 해당 plugin의 접근 방식에서
영향을 받았습니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)를
참고하세요.

Codex Telegram Bridge는 OpenAI Codex app-server 세션을 위한 독립 구현이며,
Anthropic 또는 OpenAI와 제휴되어 있지 않습니다.
