# pi-setups

Personal monorepo for Pi extensions, skills, prompt templates, and themes.

## Layout

```text
packages/pi-voice/   TTS + dictation Pi package based on S1M0N38/pi-voice
skills/              Personal Pi skills
prompts/             Personal prompt templates
themes/              Personal themes
tools/tts-bench/     Local benchmark utilities, not loaded by Pi
```

The root `package.json` is also a Pi package manifest, so one local install can load everything:

```bash
pi install /Users/jac/pi-setups
```

For development without permanently installing:

```bash
pi -e /Users/jac/pi-setups
```

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
