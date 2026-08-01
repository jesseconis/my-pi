# my-pi

Personal monorepo for Pi extensions, skills, prompt templates, and themes.

## Layout

```text
agent/               Tracked global settings, keybindings, and extension config
packages/pi-voice/   TTS + dictation Pi package based on S1M0N38/pi-voice
packages/pi-snippets/ Backtick snippet navigation and clipboard package
skills/              Personal Pi skills
prompts/             Personal prompt templates
themes/              Personal themes
tools/tts-bench/     Local benchmark utilities, not loaded by Pi
```

The root `package.json` is also a Pi package manifest, so one local install can load everything:

```bash
pi install /home/jesse/gh/my-pi
```

For development without permanently installing:

```bash
pi -e /home/jesse/gh/my-pi
```

## Tracked Pi config

Link the safe JSON configuration in `agent/` into Pi's global config directory:

```bash
scripts/link-agent-config.sh
```

Existing files are backed up first. Credentials, sessions, trust decisions, and caches remain untracked under `~/.pi/agent`. Run `/reload` after edits. See [`agent/README.md`](agent/README.md).

## Runtime config

The voice extension reads runtime config from:

```text
~/.pi/voice/config.json
```

This repo only stores a safe template:

```text
packages/pi-voice/config/voice-config.example.json
```

Do not commit real auth tokens, logs, WAVs, model caches, or other files from `~/.pi/voice`.

## Development

```bash
pnpm install
pnpm --filter @jac/pi-voice typecheck
pnpm --filter @jac/pi-voice test
```

The macOS launchd helper lives under `packages/pi-voice/scripts/`; it is not run automatically by installing this repo as a Pi package.
