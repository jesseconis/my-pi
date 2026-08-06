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
- `/voice-reload` — reload config and pronunciation rules.
- `/voice-log` — show recent `~/.pi/voice/debug.log` entries.
- `tts` tool — LLM-callable text-to-speech playback.

## Install from this monorepo

From the monorepo root:

```bash
pnpm install
pi install .
```

For a temporary test:

```bash
pi -e .
```

## Optional local TTS server on macOS

Remote TTS does not need the local server. For local Kokoro inference:

```bash
packages/pi-voice/scripts/install-server-macos.sh
```

The installer copies the start script to `~/.pi/voice/`, creates `~/.pi/voice/config.json` only if missing, and writes a LaunchAgent. It does not modify Pi package settings; run `pi install .` separately.

## Example config

Copy and edit if needed:

```bash
mkdir -p ~/.pi/voice
cp packages/pi-voice/config/voice-config.example.json ~/.pi/voice/config.json
```

Set `backend` to `remote` and use a full URL including scheme, for example `https://vox.example.com`. Do not commit auth tokens.

## Speech queue

`speech.queue.onUserInput` controls what happens when new user input arrives while speech from the previous turn is behind:

- `continue` keeps the existing FIFO behavior and is the default.
- `drop-pending` lets active speech finish but removes stale queued jobs.
- `interrupt` also stops active stale synthesis and playback.

Submission-time interruption applies to `interactive` and `rpc` input by default. Extension-generated input can be included explicitly with `inputSources`.

The local Kokoro API cannot preempt an already-running `tts.generate()` call. An interrupted client discards that result and removes other stale queued requests, but the active inference must finish before the newest request can run.

## Technical monitoring

Event configurations accept `roles` and `profile`:

```json
{
  "events": {
    "message_end": {
      "content": "text",
      "roles": ["assistant", "toolResult"],
      "profile": "monitor"
    }
  }
}
```

Use only `"assistant"` to exclude tool results. Including `"toolResult"` enables tool-aware summaries for bash, read, grep, find, and ls, with a bounded generic fallback for other tools.

The technical processor preserves normal prose while converting fenced code into useful spoken outlines. It shortens UUIDs, hashes, base64-like values, repeated output, and large byte counts. Profile limits and code/tool strategies are configured under `speech.processing.profiles`; see `config/voice-config.example.json`.

`longMode: "llm"` is opt-in. It sends only oversized code blocks or tool output to the active model and uses deterministic outlines when summarization fails. Existing event-level `{ "prompt": "..." }` configurations continue to summarize the complete selected message.

## Pronunciations

Copy the example next to the runtime config:

```bash
cp packages/pi-voice/config/pronunciations.example.json ~/.pi/voice/pronunciations.json
```

Set `speech.processing.pronunciationFile` to `pronunciations.json`, then run `/voice-reload` after edits. Relative paths resolve under `${PI_VOICE_DIR:-~/.pi/voice}`.

Rules support `word`, `prefix`, `suffix`, `pathSegment`, and `literal` matching. They can be scoped by speech source, event, message role, segment kind, tool, and code language. Scope fields combine with AND, values within one field combine with OR. Replacements are matched against the original segment once, so they do not cascade into later rules.
