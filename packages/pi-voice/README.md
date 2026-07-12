# @jac/pi-voice

Pi voice package based on `S1M0N38/pi-voice`, with local/remote Kokoro TTS, automatic assistant narration, and local STT dictation.

## Runtime behavior

- Pi loads the extension from `extensions/index.ts`.
- The extension reads runtime config from `~/.pi/voice/config.json`.
- The local Kokoro server stores cache/log/runtime files under `~/.pi/voice/`.
- This package only ships `config/voice-config.example.json`; real config and secrets stay outside git.

## Commands/tools

- `/voice` — TTS settings/debug panel.
- `/dictate` — local STT dictation, then paste transcript into Pi editor.
- `/voice-debug` — show active runtime config/backend.
- `/voice-log` — show recent `~/.pi/voice/debug.log` entries.
- `tts` tool — LLM-callable text-to-speech playback.

## Install from this monorepo

From the monorepo root:

```bash
pnpm install
pi install /Users/jac/my-pi
```

For a temporary test:

```bash
pi -e /Users/jac/my-pi
```

## Optional local TTS server on macOS

Remote TTS does not need the local server. For local Kokoro inference:

```bash
packages/pi-voice/scripts/install-server-macos.sh
```

The installer copies the start script to `~/.pi/voice/`, creates `~/.pi/voice/config.json` only if missing, and writes a LaunchAgent. It does not modify Pi package settings; use `pi install /Users/jac/my-pi` separately.

## Example config

Copy and edit if needed:

```bash
mkdir -p ~/.pi/voice
cp packages/pi-voice/config/voice-config.example.json ~/.pi/voice/config.json
```

Set `backend` to `remote` and use a full URL including scheme, for example `https://vox.example.com`. Do not commit auth tokens.
