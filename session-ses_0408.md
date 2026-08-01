# Pi voice extension QOL improvements

**Session ID:** ses_04082688cffef2pgPrYoT76JwF
**Created:** 8/2/2026, 8:41:46 AM
**Updated:** 8/2/2026, 9:39:43 AM

---

## User

This pi extension works but there are some QOL improvements I

@packages/pi-voice/ 

---

## Assistant (Plan · GPT-5.6 Sol · 5.7s)

_Thinking:_

**Requesting clarification on QOL improvements**

What QOL improvements would you like for `packages/pi-voice/`? Your message appears to have been cut off.

---

## User

Yes sorry I accidentally hit the enter key. 

Please propose a maintainable way to approach customizing the voice extensions behavior, there are three primary problems: 

1. Entire tool output is being sent to the TTS server, this results in the tts lagging significantly behind the current state of the conversation. In saying that this behavior is expected and is a sane default, that being, tts all of the agents output/turns/response and play them in the order they occured. I am wondering if it could be optionally configured so that, if the user progresses their turn but the tts is behind, it should jump/skip ahead to the new agents output/response and clear its queue from the prior turn. This seems sensible because the user may have read the agents output as text and sending another message is implicit acknowledgement of what was previously said .:. it does not need to be played as audio. 


2. How can complex shell/source code be summarized so the TTS model can pronounce it. Currently the model will spend lots of time saying large nonsensical strings (UUIDS), file sizes in bytes, and so forth. It would be great if shell/tool output was largely left verbatim except for things which are obviously too long or stupid to pronounce were stripped or paraphrased. I think there might be an existing code path in this direction but please note I find it overly aggressive, IIRC all code/source blocks are summarized into something like "The output contains a code block of 6 lines", "The output contains a code block of 2 lines", which is too opaque for the user to understand what is being done via the audio alone. Your approach needs to preserve the users ability to monitor things with enough detail from the tts audio alone. 

3. Targeted fixes for specific words/phrases, the tts model incorrectly enunciate linux-isms which could be fixed via static definitions like k: find, v: replace, for example:  {"ctl": "control", "~": "home", "etc": etsy"}. Thought should be given to how these definitions could be updated without changing the extensions source code. Furthermore, care in implementation so the find value is not blindly replaced in every appearance needs to be evaluated, how could the user define rules/filters/conditions to scope the replacement so it is only performed when it should be. 


Thanks & GL HF :)) 


---

## Assistant (Plan · GPT-5.6 Sol · 6.6s)

_Thinking:_

**Planning repository exploration strategy**

I’ll trace the extension’s event, queue, text-processing, and configuration paths first, then map each requested behavior onto the smallest maintainable extension points. I’ll keep the current behavior as the default and identify where tests and documentation should lock compatibility down.

**Tool: todowrite**

**Input:**
```json
{
  "todos": [
    {
      "content": "Map pi-voice architecture, lifecycle events, queues, and configuration loading",
      "status": "in_progress",
      "priority": "high"
    },
    {
      "content": "Analyze existing text sanitization and code/tool-output handling",
      "status": "pending",
      "priority": "high"
    },
    {
      "content": "Design configurable queue interruption and pronunciation rule semantics",
      "status": "pending",
      "priority": "high"
    },
    {
      "content": "Produce implementation plan with tests, docs, and unresolved decisions",
      "status": "pending",
      "priority": "high"
    }
  ]
}
```

**Output:**
```
[
  {
    "content": "Map pi-voice architecture, lifecycle events, queues, and configuration loading",
    "status": "in_progress",
    "priority": "high"
  },
  {
    "content": "Analyze existing text sanitization and code/tool-output handling",
    "status": "pending",
    "priority": "high"
  },
  {
    "content": "Design configurable queue interruption and pronunciation rule semantics",
    "status": "pending",
    "priority": "high"
  },
  {
    "content": "Produce implementation plan with tests, docs, and unresolved decisions",
    "status": "pending",
    "priority": "high"
  }
]
```

---

## Assistant (Plan · GPT-5.6 Sol · 543.2s)

_Thinking:_

**Planning parallel agent inspection tasks**

**Tool: task**

**Input:**
```json
{
  "description": "Trace voice lifecycle",
  "subagent_type": "explore",
  "prompt": "Read-only exploration only. In /home/jesse/gh/my-pi/packages/pi-voice, thoroughly trace the extension lifecycle and audio/TTS queue behavior: entrypoints, pi events, how assistant/tool/user turns are represented, how speech requests are queued, playback cancellation/cleanup, concurrency/race handling, and any currently exposed config. Also inspect relevant sibling/shared code only where needed to understand pi event semantics. Return file:line references, a concise call-flow, and concrete candidate insertion points for a configurable behavior that drops stale prior-turn queued/in-flight speech when a new user turn progresses. Do not edit anything. Thoroughness: very thorough."
}
```

**Output:**
```
<task id="ses_04068e713ffeTymNv9pS3ksLtm" state="completed">
<task_result>
Read-only exploration completed; no files were changed.

## Key finding

`pi-voice` currently has no concept of a user-turn ID, speech generation, stale job, or cancellation token. It serializes several portions of the pipeline, but once speech is queued or started it normally runs to completion—even after another user message, session-tree navigation, disabling TTS, reload, or agent abort.

The best semantic insertion point for stale-turn invalidation is a new:

```ts
pi.on("message_start", event => {
  if (event.message.role === "user") ...
})
```

This catches both ordinary user prompts and queued steering/follow-up messages when they actually enter the agent loop. For immediate barge-in at submission time, `pi.on("input")` is earlier but less authoritative.

---

# 1. Entrypoints and extension lifecycle

## Package entrypoints

- The monorepo root loads the extension directly:
  - `/home/jesse/gh/my-pi/package.json:21-25`
- The voice package declares the same extension as its Pi package entry:
  - `/home/jesse/gh/my-pi/packages/pi-voice/package.json:39-43`
- The default extension factory is:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:819-827`
- The standalone CLI is exposed as `pi-voice`:
  - `/home/jesse/gh/my-pi/packages/pi-voice/package.json:24-26`
  - `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:684-745`
- The local Kokoro HTTP server is a separate executable; loading the extension does not start it:
  - `/home/jesse/gh/my-pi/packages/pi-voice/package.json:53-55`
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:537-584`
- The macOS helper starts that server and then downloads/activates a model:
  - `/home/jesse/gh/my-pi/packages/pi-voice/scripts/start-pi-voice-server.sh:52-90`

## Extension construction

At factory invocation, the extension:

1. Loads global config immediately.
2. Creates session, status, streaming, auto-TTS, and audio-queue state in closure-local variables.
3. Registers commands, tool, shortcut, Pi handlers, and shared-event-bus listeners.

References:

- Initial config and state:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:819-840`
- Queue state:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:888-927`
- Commands/tool:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1615-2017`
- Pi lifecycle and auto-TTS handlers:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2029-2092`
- Custom event registration:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2094-2120`

## Session lifecycle

On `session_start` and `session_tree`, it:

- stores the current `ExtensionContext`,
- scans the current branch for `voice-session` custom entries,
- takes the last encountered override,
- reloads global config,
- refreshes the status bar.

References:

- Persistence and restoration:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:873-886`
- Hooks:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2031-2041`

Pi emits `session_start` after extension bindings are active:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1646-1667`

Important lifecycle gaps:

- There is no `session_shutdown` handler in `pi-voice`.
- `session_tree` does not clear streaming buffers or speech queues.
- Active HTTP requests, summary sessions, temp WAVs, players, and queued jobs are not cancelled during teardown.
- Custom event unsubscriptions are collected, but `registerCustomEvents()` is called only once. They are not unsubscribed on shutdown:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2099-2120`
- The shared event bus unregisters listeners only by calling the returned function:
  - `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js:8-22`

This creates a potential stale-listener problem across reloads because the resource loader owns and reuses the event bus:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:122`
- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:355`

---

# 2. Pi event and turn semantics

## Pi’s terminology

Pi distinguishes:

- **Agent run**: normally begins from a top-level user prompt.
- **Turn**: one assistant response plus any tool calls/results.
- A single agent run can contain multiple turns while tools are called.
- Steering/follow-up user messages can also be injected into the same active agent run.

The documented lifecycle is:

- `input`
- `before_agent_start`
- `agent_start`
- one or more:
  - `turn_start`
  - message events
  - tool events
  - `turn_end`
- `agent_end`

Reference:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:272-342`

Actual low-level ordering for an ordinary prompt is:

1. `agent_start`
2. `turn_start`
3. user `message_start`
4. user `message_end`
5. assistant message lifecycle
6. tools/tool results if present
7. `turn_end`
8. another turn if needed
9. `agent_end`

Reference:

- `/home/jesse/gh/my-pi/node_modules/.pnpm/@earendil-works+pi-agent-core@0.80.2_ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:42-55`
- `/home/jesse/gh/my-pi/node_modules/.pnpm/@earendil-works+pi-agent-core@0.80.2_ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:77-167`

Queued steering/follow-up messages are emitted as user message lifecycle events before the next assistant request:

- `/home/jesse/gh/my-pi/node_modules/.pnpm/@earendil-works+pi-agent-core@0.80.2_ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:81-103`
- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:929-958`

## Message representation

LLM-compatible messages are:

- User:
  - `role: "user"`
  - string or text/image content
- Assistant:
  - `role: "assistant"`
  - text, thinking, and tool-call blocks
- Tool result:
  - `role: "toolResult"`
  - text/image content plus tool ID/name/error metadata

References:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-ai/dist/types.d.ts:222-247`
- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-ai/dist/types.d.ts:264-293`

Assistant streaming events include text, thinking, and tool-call start/delta/end events:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-ai/dist/types.d.ts:323-383`

Tool-result messages are emitted after tool execution:

- `/home/jesse/gh/my-pi/node_modules/.pnpm/@earendil-works+pi-agent-core@0.80.2_ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:486-508`

## Event payloads used by voice

- `agent_end.messages`: all messages generated during the run.
- `turn_end.message`: the assistant message for that turn.
- `turn_end.toolResults`: separate tool-result messages.
- `message_end.message`: user, assistant, or tool-result message.
- `message_update`: assistant streaming only.

References:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:510-547`
- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:534-566`

## Voice extraction behavior

`extractLastMessage()`:

- takes the final element of `agent_end.messages`,
- otherwise uses `event.message`,
- does not inspect or restrict `message.role`,
- extracts only text and/or thinking blocks,
- ignores tool-call and image blocks.

Reference:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:708-747`

Consequences:

- Configuring raw `message_end` narration speaks user messages, assistant messages, and textual tool results.
- A `tts` tool result says `Speaking: "..."`; raw `message_end` narration can narrate that tool result too, potentially duplicating the intended speech.
- `agent_end` normally ends in a final assistant message, but early termination or unusual flows can leave another role last.
- Configuring several lifecycle events can narrate the same assistant response more than once.

The only duplicate suppression is:

```ts
if (eventName === "agent_end" && config.events.message_update) return;
```

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1422-1428`

It does not suppress duplication among `message_end`, `turn_end`, and `agent_end`.

---

# 3. Concise speech call-flow

```text
Pi message/update/end event
  -> enqueueAutoTTS() OR handleMessageUpdateTTS()
  -> autoTTSTail / streamTail
  -> handleAutoTTS()
       -> fixed text
       -> extracted raw message text
       -> nested LLM summary session
  -> speak()
       -> voice:speak_start
       -> synthesizeAndPlay()
          -> local: POST /tts -> WAV
          -> remote PCM: POST streaming endpoint
          -> remote fallback: split text -> fetch WAV chunks
       -> enqueueAudio()
       -> afplay/aplay/ffplay/play
       -> voice:speak_end

Local /tts:
  -> read request body
  -> enqueueTTS()
  -> Kokoro generate()
  -> Float32 -> WAV
  -> HTTP response
```

Primary references:

- Auto event dispatch:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1414-1494`
- Streaming auto-TTS:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1496-1575`
- Speech lifecycle:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1330-1412`
- Local server queue:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:392-493`

---

# 4. Queue layers

| Layer | State | What it serializes | Cancellation today |
|---|---|---|---|
| Auto-event queue | `autoTTSTail` | Full non-streaming auto-TTS jobs | None |
| Streaming queue | `streamTail` | Streaming text/thinking chunks | None |
| Playback queue | `audioQueue` + `audioPlaying` | Extension WAV/PCM playback | None |
| Local server queue | `ttsQueueTail` | Kokoro `/tts` synthesis | Waiting request skipped only after disconnect |
| CLI playback | none shared | `pi-voice say` playback | Independent of extension queue |
| STT cues | none shared | start/finish cue | Can overlap TTS |

## Auto-event queue

`enqueueAutoTTS()` appends to one promise tail and immediately returns to Pi:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1476-1494`

The Pi runner awaits event handlers, but these handlers only enqueue work and return, so Pi does not wait for speech:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2072-2089`
- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:522-551`

A summary job creates an in-memory nested agent session, subscribes for assistant text, prompts, then disposes:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:751-815`

That operation is serial within `autoTTSTail` and has no abort or stale-generation check. A slow summary blocks later auto jobs.

## Streaming queue

Streaming deltas are appended to one global `streamBuffer`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:825-827`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1551-1575`

Chunks are cut at punctuation or maximum length and appended to `streamTail`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1496-1549`

For `message_end`, `autoTTSTail` force-flushes `streamBuffer` and waits for the current `streamTail` before narrating the finalized message:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1484-1490`

That ordering is covered by:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts:785-820`

Risks:

- The buffer is not keyed by message, assistant, content block, Pi turn, or user prompt.
- A delayed `message_end` auto job can force-flush text added after that event.
- Switching between thinking and text uses the same buffer.
- Tree navigation/session state restoration does not clear it.

## Playback queue

The queue is a FIFO array of closures:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:890-925`

It guarantees only one queued playback closure runs at a time. It has no:

- job ID,
- turn ID,
- source metadata,
- active child-process reference,
- abort signal,
- cancellation callback,
- queue-clearing function.

Playback serialization begins only after synthesis has reached the point where `playWavBuffer()` or `playRemotePcmStream()` calls `enqueueAudio()`.

Therefore synthesis can overlap and determine enqueue order.

## Local server synthesis queue

The local server serializes `/tts` calls through `ttsQueueTail`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:392-435`

It:

- reads each body before queueing,
- queues in body-completion order,
- catches each synthesis failure so normal failures do not poison the tail,
- detects response close while waiting,
- skips a waiting request when its client disconnected.

The listener is removed when processing starts:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:406-429`

Thus disconnecting an actively synthesizing request does not cancel `tts.generate()`. The generated result is still computed.

Existing server tests cover FIFO success and an immediately aborted queued request:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.test.ts:323-439`

They do not verify cancellation of active synthesis.

---

# 5. Synthesis and playback behavior

## WAV path

Local and non-streaming remote synthesis:

1. `fetchTtsWav()` performs an unbounded `fetch`.
2. Entire WAV is buffered in memory.
3. WAV is written to `~/.pi/voice/voice-...wav`.
4. Playback is enqueued.
5. `afplay` or `aplay` is started using `exec`.
6. Temp file is deleted in the callback.

References:

- HTTP:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1150-1195`
- Temp file/playback:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1197-1227`
- WAV timeout calculation:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:639-648`

The only automatic interruption is `exec`’s timeout for recognized WAV headers. It is at least 30 seconds, or duration plus 15 seconds. Invalid/nonstandard WAV headers get no timeout.

The returned child process is not retained, so the extension cannot kill active WAV playback.

## Remote PCM stream

Remote PCM:

1. Fetches the streaming endpoint before entering `audioQueue`.
2. Starts a player when its playback queue item begins.
3. Reads the response and writes chunks to child stdin.
4. Kills the player only when stream reading throws.

References:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1229-1328`

Gaps:

- No request `AbortController`.
- No externally reachable player or stream reader.
- No explicit `reader.cancel()`.
- Player exit and backpressure waits can race.
- Cancellation errors would currently be caught as remote-stream failures and could trigger stale chunk fallback unless specially classified.

## Remote chunked fallback

The text is split and WAV chunks are fetched sequentially:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:553-586`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1348-1364`

Each `playWavBuffer()` call is started but not awaited before fetching the next chunk. This pipelines synthesis and playback.

Because each chunk is a separate `audioQueue` item, unrelated tool/sample speech can enqueue between chunks of one utterance. Playback never overlaps, but an utterance is not atomic.

## Tool speech

The registered `tts` tool:

- accepts text, optional voice, and optional speed,
- ignores its supplied `_signal`,
- starts `speak()` fire-and-forget,
- immediately returns a textual tool result.

Reference:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1958-2016`

Therefore the agent can continue, complete, or accept another user message while tool speech is still synthesizing or playing.

## Speech events

`speak()` emits:

- `voice:speak_start` before synthesis,
- `voice:speak_end` after all synthesis/playback or an error.

Reference:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1366-1412`

There is no cancellation state in `VoiceSpeakEndEvent`; only optional `error`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:172-197`

## Audio outside the queue

STT cues directly spawn `afplay` or emit a terminal bell and do not use `audioQueue`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:928-944`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1011-1012`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1075-1077`

The CLI also plays independently:

- `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:596-607`
- `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:627-655`

These can overlap extension-managed playback.

---

# 6. Current concurrency and race handling

## What is handled

- `audioQueue` continues after resolve or rejection via `.finally()`:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:903-915`
- Auto and streaming tails catch failures so later jobs continue:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1484-1493`
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1539-1548`
- Remote chunk errors wait for already-created playback promises:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1351-1363`
- PCM read errors destroy stdin and kill the player:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1319-1324`
- Local server waiting requests are skipped after client disconnect:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:406-429`

## What is not handled

- No stale-turn invalidation.
- No queued playback removal.
- No active player interruption.
- No fetch abort or timeout.
- No nested summary-agent abort.
- No clearing on TTS disable.
- No clearing on `session_tree`.
- No shutdown cleanup.
- No generation check after slow summary/fetch.
- No atomic ordering across auto, stream, tool, and sample producers.
- No source/turn identity in queue entries.

Additional ordering races:

- `autoTTSTail` and `streamTail` are independent except for the special `message_end` bridge.
- Tool and sample speech bypass both tails.
- WAV synthesis happens before `audioQueue`, so separate remote requests can enqueue in completion order rather than event order.
- A previous speech finishing can set the global status to `idle` while another request is synthesizing or queued.
- Toggling TTS off changes future effective config but does not affect already captured job config:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1476-1490`
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2050-2063`

The local server serializes `/tts`, but model management endpoints are not serialized against synthesis. Unload/delete/activation can race active generation:

- Model lifecycle:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:126-230`
- TTS queue:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:392-493`

Server shutdown exits immediately without draining the queue or explicitly unloading the model:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:495-500`

---

# 7. Currently exposed configuration

## Global JSON

Runtime config is read from:

```text
${PI_VOICE_DIR:-~/.pi/voice}/config.json
```

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:269-271`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:666-705`

Fields represented by the extension:

- `enabled`
- `voice`
- `speed`
- `backend`: `local | remote`
- `host`
- `port`
- `remote`
  - `baseUrl`
  - `host`
  - `port`
  - `authToken`
  - `speechPath`
  - `streamPath`
  - `stream`
  - `streamFormat`: `pcm | wav`
  - `chunkText`
  - `chunkMaxChars`
- `stt`
  - `enabled`
  - `mode`
  - `modelDir`
  - `language`
  - `audioCues`
  - `startCue`
  - `finishCue`
- `events`

References:

- Types:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:104-168`
- Schema:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:199-265`
- Defaults:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:310-331`
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:650-664`
- Example:
  - `/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json:1-33`

The TypeBox `_VoiceConfigSchema` is not registered or used to validate the JSON. Loading uses unchecked `JSON.parse` and manual fallback merging:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:232-265`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:668-700`

## Event configuration

An event value can be:

- `{ text }`: fixed direct speech.
- `{ content?: "text" | "thinking" | "all" }`: raw extracted content.
- `{ prompt, content?, model? }`: nested-LLM summarization.

References:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:109-127`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1414-1474`

Behavior:

- With no config file, default auto-TTS is summarized `agent_end`.
- If a user config exists but omits `events`, no auto-TTS runs.
- User `events` are deliberately not merged with default events:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:668-684`

Despite comments saying any event name can be used, only these Pi built-ins are explicitly registered:

- `agent_end`
- `turn_end`
- `message_end`
- `message_update`

Everything else is treated as a custom shared-bus event:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2066-2117`

Thus configuring another real Pi built-in such as `message_start`, `input`, or `before_agent_start` currently does not subscribe to that Pi event.

## Session overrides

Only these are persisted as branch-local `voice-session` entries:

- `enabled`
- `voice`
- `speed`

Reference:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:164-168`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:873-886`

`/voice` edits those values and can save global defaults:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1617-1859`

## `defaultModel`

`defaultModel` appears in the example and is used by the standalone CLI when starting the local server, but it is not part of `FullVoiceConfig` and is ignored by the extension:

- `/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json:8`
- `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:54-67`
- `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:377-384`

## Missing configuration

There is currently no exposed setting for:

- stale-speech policy,
- barge-in,
- cancellation,
- queue depth,
- playback timeout,
- HTTP timeout,
- queue source priority,
- whether samples/tool speech participate in stale-turn cancellation,
- role filtering for `message_end`.

---

# 8. Candidate insertion points for stale prior-turn speech

## Recommended behavior model

A mode is more useful than a boolean:

```json
{
  "speechQueue": {
    "onNewUserMessage": "keep | drop-queued | interrupt",
    "sources": ["auto", "tool"]
  }
}
```

Suggested semantics:

- `keep`: current behavior; backward-compatible default.
- `drop-queued`: discard prior-user-epoch jobs not yet playing.
- `interrupt`: also abort synthesis/summary work and stop active playback.
- Exclude `sample` by default because it is UI-driven rather than turn-owned.

## 1. Add configuration plumbing

Concrete insertion points:

- Runtime config interfaces:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:129-162`
- TypeBox schema:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:232-265`
- Defaults:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:650-664`
- JSON loading:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:668-700`
- Effective config:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:829-840`
- Example and debug panel:
  - `/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json:1-33`
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1861-1905`

## 2. Use `message_start` with `role === "user"` as the authoritative trigger

Insert near the existing Pi event registrations:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2029-2092`

Why this is the best trigger:

- It fires only after a user message actually enters the agent loop.
- It catches initial prompts.
- It catches steering/follow-up messages when consumed.
- It avoids treating tool-continuation `turn_start` events as new user turns.
- The role is explicit.

Shared semantics:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:560-566`
- `/home/jesse/gh/my-pi/node_modules/.pnpm/@earendil-works+pi-agent-core@0.80.2_ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:48-53`
- `/home/jesse/gh/my-pi/node_modules/.pnpm/@earendil-works+pi-agent-core@0.80.2_ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:94-103`

Do not use every `turn_start`: Pi starts new turns for tool continuations, not just user messages.

## 3. Optional earlier barge-in trigger: `input`

For immediate interruption as soon as the user submits input, add `pi.on("input")`.

Semantics:

- It runs before prompt expansion and before agent processing.
- Extension slash commands bypass it.
- Another extension can transform or fully handle the input.
- During streaming, it fires before steering/follow-up is merely queued.

References:

- Input shape:
  - `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:595-618`
- Prompt path:
  - `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:700-755`
- Input-handler chaining:
  - `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:838-874`

Recommended distinction:

- `input`: true barge-in at submission.
- user `message_start`: cancel only when the new user message actually progresses into the agent loop.

`before_agent_start` is another possible trigger, but it does not cover steering/follow-up messages queued into an already active run:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:785-834`

## 4. Add a monotonically increasing user epoch

Add state beside existing queue counters:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:819-827`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:897-901`

Each accepted user message increments `userEpoch`. Tag every speech job with the current epoch:

- auto-event jobs,
- streaming chunks,
- tool calls,
- optionally samples/custom events.

Generation checks are needed before and after every asynchronous boundary. Merely replacing `autoTTSTail` or `streamTail` is insufficient because closures already attached to old promises still execute.

Key check locations:

- Before and after nested summary:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1444-1455`
- Before direct/code/raw speech:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1430-1470`
- Before each streaming chunk:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1539-1545`
- After each fetch and before enqueue:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1150-1195`
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1348-1363`

On epoch advance, clear `streamBuffer` immediately.

## 5. Make `audioQueue` cancellable

Extend `QueueItem` at:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:890-925`

Useful metadata:

- `epoch`
- `source`
- `speechId`
- `cancel(reason)`
- queued/active state
- associated cleanup callback

A `dropQueuedBeforeEpoch()` function should:

1. Remove matching queued items.
2. Settle every removed item’s promise.
3. Delete any WAV already written for the item.
4. Preserve later/current-epoch jobs.

Settling is essential; silently splicing entries would leave `speak()`, `streamTail`, or `autoTTSTail` waiting forever.

For active cancellation, retain the active item itself rather than only `audioPlaying: boolean`.

## 6. Thread `AbortSignal` through synthesis

Concrete signatures to extend:

- `speak()`:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1366-1412`
- `synthesizeAndPlay()`:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1330-1364`
- `fetchTtsWav()`:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1150-1195`
- `playRemotePcmStream()`:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1229-1328`

Each speech job should own an `AbortController`. On stale-turn interruption:

- abort WAV/PCM fetch,
- cancel PCM reader,
- destroy PCM stdin,
- kill player,
- avoid remote fallback for an intentional abort,
- check epoch before writing/enqueueing returned WAV data.

For tool speech, use the currently ignored tool `_signal`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1980-2009`

## 7. Retain and kill playback processes

For WAV playback, replace or wrap the current discarded `exec` child handle:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1212-1226`

`spawn(cmd, [outPath])` would provide a direct child handle and avoid shell command construction. Cancellation should be idempotent and let the normal close path perform queue advancement and file deletion.

For PCM, expose the child and stream reader to the containing speech job:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1272-1325`

## 8. Abort nested summary sessions

`generateSpeechText()` creates a private session with an available `abort()` API, but currently only calls `dispose()` after completion:

- Current implementation:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:751-815`
- Session abort API:
  - `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:400-404`

Pass a signal/job controller into this function, call `session.abort()` on cancellation, unsubscribe in `finally`, and then dispose.

## 9. Add shutdown/tree cleanup

Add `session_shutdown` beside existing session hooks:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2029-2041`

It should:

- invalidate all epochs,
- abort controllers,
- kill active playback,
- settle queued jobs,
- clear `streamBuffer`,
- unsubscribe custom event handlers,
- remove status if appropriate.

`session_tree` should at least invalidate old-branch speech before restoring branch settings.

Pi explicitly designates `session_shutdown` for cleanup:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:483-492`

## 10. Local server implications

Aborting client fetches will already cause waiting local `/tts` requests to be skipped because the server watches response close.

For active local synthesis:

- Keep the close listener for the full operation.
- Check `disconnected` after `tts.generate()` and discard the result.
- True CPU/model preemption depends on whether Kokoro exposes an abort mechanism; current `tts.generate()` receives no signal:
  - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:446-472`

Thus an `interrupt` mode can reliably prevent stale playback and stale delivery, but may not be able to stop an already-running local Kokoro computation.

---

# 9. Recommended implementation boundary

The least invasive safe design is:

1. Add configurable `keep | drop-queued | interrupt`.
2. Increment a user epoch on user `message_start`.
3. Clear the streaming buffer.
4. Epoch-check `autoTTSTail` and `streamTail` jobs.
5. Tag and filter `audioQueue`.
6. Use one `AbortController` per `speak()`.
7. Retain active child/reader handles.
8. Add `session_shutdown` cleanup.
9. Preserve `voice:speak_start`/`voice:speak_end` pairing for jobs cancelled after start; optionally add a `cancelled` field to the end event.

A more robust longer-term design would replace the three independent extension queues with an explicit `SpeechJob` scheduler. That would centralize source, epoch, synthesis, playback, cancellation, and cleanup, and could keep chunked utterances contiguous.
</task_result>
</task>
```

**Tool: task**

**Input:**
```json
{
  "description": "Audit speech preprocessing",
  "subagent_type": "explore",
  "prompt": "Read-only exploration only. In /home/jesse/gh/my-pi/packages/pi-voice, thoroughly inspect all text preprocessing, markdown/code/tool-output transformations, speech chunking, pronunciation substitutions, config loading, schemas/types, tests, README, changelog, and examples. Explain current behavior and identify reusable paths or overly aggressive summaries. Return file:line references and specific recommendations for configurable intelligible code/output summarization and context-scoped pronunciation rules loaded outside source. Do not edit anything. Thoroughness: very thorough."
}
```

**Output:**
```
<task id="ses_04068e6d9ffejBJQfCuLWJ0F84" state="completed">
<task_result>
No files were edited, and I did not run tests because `events.test.ts` writes to the real `~/.pi/voice/config.json`.

## Executive findings

1. Text handling is fragmented rather than a single pipeline:
   - Extension speech uses `prepareTextForSpeech()`.
   - `pi-voice say` and the local `/tts` server bypass it.
   - Most extension callers preprocess twice.
2. Code handling is lossy:
   - Manual/direct speech replaces every fenced block with only its language and non-empty line count.
   - Raw auto-TTS sends the entire response through an LLM whenever any fence is present.
3. There is no pronunciation-substitution system. The only lexical mappings are code-language display names and STT hallucination rejection phrases.
4. Tool output has no intentional speech transformation. Structured tool results are ignored or can be treated accidentally as generic message text.
5. `chunkMaxChars` is not a hard maximum, and streaming Markdown/code fences can be split incorrectly.
6. A TypeBox voice-config schema exists but is unused; runtime configuration is unvalidated.
7. The extension can erase `defaultModel` and unknown keys when saving the shared config.
8. Tests and documentation cover only a small portion of this behavior.

---

# Current text-to-speech behavior

## Entry-point matrix

| Source | Selection/transformation | Summarization | Chunking |
|---|---|---|---|
| `pi-voice say` | Reads arguments, file, or stdin and trims only | None | None |
| `tts` agent tool | `prepareTextForSpeech()`, then `speak()` prepares again | None | Remote WAV fallback only |
| Fixed event `{text}` | Prepares fixed text twice | None | Backend-dependent |
| Raw event `{content}` without fence | Extracts selected message blocks and prepares twice | None | Backend-dependent |
| Raw event with fence | LLM rewrites the whole message; deterministic code placeholder on failure | Automatic and implicit | Backend-dependent |
| Event `{prompt}` | LLM rewrites entire extracted context, then prepares twice | Explicit prompt plus mandatory code suffix | Backend-dependent |
| `message_update` | Buffers raw deltas and calls `speak()` per chunk | Not allowed for prompt/fixed configs | Streaming chunker |
| `/voice` sample | Plain fixed sentence | None | Backend-dependent |
| Direct local `/tts` HTTP | Trims request text only | None | None |

Relevant paths:

- CLI input and raw request: `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:549-628`
- Server trims and sends text directly to Kokoro: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:437-471`
- Extension canonical `speak()` path: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1367-1412`
- Tool preprocessing: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1958-2015`
- Auto-TTS routing: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1414-1474`

## Duplicate preprocessing

The tool and almost every non-streaming auto-TTS branch call `prepareTextForSpeech()` before calling `speak()`, which calls it again:

- `speak()` preprocessing: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1367-1373`
- Auto branches: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1430-1470`
- Tool branch: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1995-2008`

The current regex transformations are mostly idempotent, but this will become unsafe if pronunciation rules can cascade—for example, replacement A produces text matched by replacement B.

---

# Markdown and code transformation

## Fenced code

Fence detection is line-based and accepts backtick or tilde fences of length three or more:

- Detection: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:414-416`
- Scanner/replacement: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:418-463`

Each block becomes:

> “The response includes a TypeScript code block with 3 non empty lines.”

The only retained information is:

- Mapped language name.
- Count of non-empty lines.

Language mappings are hardcoded for a small set such as `bash → shell`, `ts → TypeScript`, and `json → JSON`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:387-411`

Consequences:

- Commands, paths, identifiers, API names, errors, return values, and code intent are discarded.
- An unterminated fence consumes all remaining prose as code.
- A standalone closing fence encountered outside a block is treated as a new opening fence.
- Singular output is grammatically wrong: “1 non empty lines.”
- Indented code and inline multiline constructs are not recognized as fenced blocks.

Tests only verify the generic descriptor and unterminated-fence tolerance:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts:895-919`

## Markdown cleanup

`prepareTextForSpeech()` performs these regex transformations in order:

- Replaces fenced code first.
- Keeps image alt text but removes the image URL.
- Keeps Markdown link labels but removes destinations.
- Removes heading, blockquote, horizontal-rule, unordered-list, and ordered-list markers.
- Removes inline-code backticks while retaining inline content.
- Removes emphasis markers.
- Globally deletes remaining asterisks, repeated underscores, and backticks.
- Collapses horizontal whitespace and excessive blank lines.

Implementation:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:465-487`

This is useful for simple prose but overly destructive for technical text:

- `__dirname` becomes `dirname`.
- Glob patterns such as `**/*.ts` lose meaningful characters.
- Pointer/dereference syntax, multiplication, regular expressions, and wildcard commands are damaged.
- List structure is lost rather than verbalized.
- Link destinations, often the important part of technical output, disappear.
- Tables, task-list markers, strikethrough, HTML, autolinks, footnotes, and nested link destinations are not handled.
- Bare URLs, paths, stack traces, and symbol-heavy inline text remain largely unpronounceable.

## LLM code summarization

Two hardcoded prompts exist:

- Default ultra-short event summary: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:287-294`
- Code-aware whole-response conversion: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:296-303`

For a raw event, merely detecting any fenced block causes the **entire message**, including surrounding prose, to be rewritten by the LLM:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1458-1464`

This is the most aggressive current behavior. A response containing one short command may lose otherwise useful prose, caveats, filenames, or exact errors.

For explicitly prompted events, a mandatory code suffix is appended to every configured prompt, even when the source has no code:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:305-308`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:633-637`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1444-1451`

The suffix can only be suppressed by including the exact suffix text in the prompt.

Other summary-path concerns:

- The default prompt says context is enclosed in quadruple backticks, but the actual message uses four double quotes: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:287-290`, `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:772-774`.
- Multiple LLM text blocks are concatenated without a separator: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:792-808`.
- All generation errors are silently converted to `null`: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:812-814`.
- Explicitly prompted events produce no speech on LLM failure.
- Raw code events fall back to the generic language/line-count replacement.

---

# Message context and tool output

## Content extraction

Only the final message is examined:

- For `agent_end`, the last array element is used.
- For `turn_end` and `message_end`, `event.message` is used.

`text`, `thinking`, and `all` control only text/thinking blocks:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:710-747`

Limitations:

- There is no role check.
- Assistant `toolCall` blocks and images are ignored.
- `turn_end.toolResults` is ignored.
- `agent_end` does not search backward for the last assistant message.
- `all` simply joins matching blocks with newlines.
- A string is accepted for `text`/`all`, regardless of message role.

The installed Pi API defines messages as assistant, user, or tool-result messages, and tool results have structured `toolName`, `isError`, and content fields:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-ai/dist/types.d.ts:265-293`
- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:515-546`

Therefore, a configured generic `message_end` can make user or tool-result text eligible for speech, while losing the tool name/error metadata. There is no intentional tool-output summarizer.

The extension registers only four built-in speech events:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2066-2092`

Pi provides typed `tool_execution_end` and `tool_result` hooks, but they are unused:

- `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:825-844`

Custom event handling does not solve this generally: raw custom events must happen to expose `message` or `messages`; otherwise only fixed `{text}` works:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2094-2117`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:716-724`

## Event suppression and duplication

If `message_update` is present in config, `agent_end` is always suppressed:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1423-1426`

This happens even if the `message_update` config is unusable because it contains `prompt` or `text`; streaming explicitly refuses those variants:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1551-1559`

Conversely, configuring both `message_update: {content:"text"}` and `message_end: {content:"text"}` can speak final text twice. The shipped example avoids this by streaming thinking and speaking final text:

- `/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json:25-32`
- Ordering test: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts:785-820`

---

# Speech chunking

## Remote WAV fallback chunker

`splitSpeechText()`:

1. Collapses all whitespace, including paragraph boundaries, to spaces.
2. Groups text around `. ! ? ; :`.
3. Combines groups until approximately `maxChars`.
4. Hard-slices long groups by character offsets.

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:553-586`

`chunkMaxChars` is not a strict maximum:

- A chunk up to `1.5 × maxChars` is accepted.
- Long indivisible parts are hard-cut, possibly inside identifiers, URLs, paths, Unicode surrogate pairs, or commands.
- Paragraph and list pauses are discarded.

This chunker is used only for remote non-PCM/WAV fallback when `chunkText` is enabled:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1330-1364`

It is not used for:

- Local TTS.
- Working remote PCM streaming.
- CLI `say`.
- Direct server requests.

## `message_update` chunker

Streaming deltas use a separate algorithm:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1496-1549`

Behavior:

- Minimum chunk size is 60–120 characters depending on `chunkMaxChars`.
- It selects the **last punctuation boundary anywhere in the buffer**, so a punctuation chunk can greatly exceed `maxChars`.
- If forced at message end, the entire remaining buffer is returned without a bound.
- If no punctuation is available at the threshold, it cuts at a space or hard-cuts.
- It operates before Markdown/code parsing.

This is especially unsafe for streamed code fences: an opening fence can be spoken in one chunk as an unterminated block, while a later closing fence can be interpreted as a new opening block.

The buffer is global to the extension rather than per message/content stream:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:819-827`

Also, the setting lives under `remote`, but this streaming chunker uses it even when the effective backend is local:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1527-1533`

## Audio and request serialization

Playback itself is serialized correctly through `audioQueue`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:888-926`

Auto-TTS jobs and streaming jobs have separate promise tails:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:897-902`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1476-1494`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1539-1548`

The local HTTP server separately serializes synthesis requests:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:392-435`

---

# Pronunciation substitutions

There is no TTS pronunciation dictionary, substitution list, regex rule set, phoneme mapping, or external pronunciation file.

The closest behaviors are:

1. Code-language name mappings used only in generic block descriptions:
   - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:387-411`
2. UI-only voice language/gender hints:
   - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:367-385`
3. The LLM prompt’s non-enforced request to prefer words over symbols:
   - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:287-294`
4. Hardcoded STT hallucination rejection phrases, which suppress rather than substitute:
   - `/home/jesse/gh/my-pi/packages/pi-voice/extensions/stt.ts:706-751`

The STT list includes plausible legitimate utterances such as “thank you,” “bye,” and “you,” so it is itself overly aggressive and is not configurable.

---

# STT speech segmentation and text filtering

Although separate from TTS chunking, STT also segments speech:

- Maximum segment: 12 seconds.
- On the cap, it searches the last 800 ms for a low-energy cut.
- Partial decoding occurs at most once per second.
- Silence/VAD flushes the current segment.
- Final segment text is rejected below RMS `0.005`.
- Accepted segment transcripts are joined with spaces.

Constants:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/stt.ts:81-108`

Pipeline:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/stt.ts:395-509`

The thresholds, segment duration, partial interval, hallucination list, and repetition-loop rules are all hardcoded. Only model directory, language, cues, and enablement are configurable:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/stt.ts:15-48`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:154-162`

---

# Configuration, schemas, and types

## Existing external config path

All major components support `PI_VOICE_DIR`, defaulting to `~/.pi/voice`:

- Extension: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:267-271`
- CLI: `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:45-47`
- Server: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts:35-42`
- Initializer: `/home/jesse/gh/my-pi/packages/pi-voice/src/prepare.js:21-25`
- Installer: `/home/jesse/gh/my-pi/packages/pi-voice/scripts/install-server-macos.sh:4-11`

This is the natural location for external pronunciation and prompt files.

## Config loading semantics

Extension behavior:

- No config file: use full defaults, including ultra-short `agent_end` summarization.
- Valid user config without `events`: no auto-TTS.
- Malformed config: silently fall back to full defaults, unexpectedly enabling default `agent_end` summarization.
- Nested `remote` and `stt` blocks are shallow-merged.

- Defaults: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:650-664`
- Loader: `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:666-701`

The CLI has a separate, simpler loader:

- `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:52-78`

No runtime validation occurs in either loader.

## Dead/unapplied schema

A substantial TypeBox config schema exists:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:199-265`

But `_VoiceConfigSchema` is:

- Not exported.
- Not used to parse or validate the file.
- Not used by `saveConfig()`.
- Missing `defaultModel`.
- Unable to enforce documented mutual exclusivity robustly because the event union is untagged and extra fields are not prohibited.

Runtime precedence for an object with both `text` and `prompt` is simply that `text` wins:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1430-1437`

The fallback TypeBox implementation is also permissive; its `Optional()` is a no-op and its `Object()` does not construct required fields:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:53-80`

TypeScript strict mode is disabled:

- `/home/jesse/gh/my-pi/packages/pi-voice/tsconfig.json:2-11`

## Shared-config data loss

The example contains `"defaultModel": "q8"`:

- `/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json:1-9`

The CLI reads it, but `FullVoiceConfig`, its schema, and the extension loader do not retain it. `/voice` saving serializes the reconstructed extension config, which can erase:

- `defaultModel`.
- Any future or third-party unknown keys.

Save/reset paths:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:703-706`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1782-1804`

After that loss, CLI `server start` falls back to `q4`:

- `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:63-67`
- `/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts:377-384`

The launch script independently defaults to `q8`, so CLI and LaunchAgent behavior can diverge:

- `/home/jesse/gh/my-pi/packages/pi-voice/scripts/start-pi-voice-server.sh:4-8`

## Remote host/port issue

The intended `remoteConfig()` behavior can derive `baseUrl` from remote host/port:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:503-518`

However, `loadConfig()` first merges in the default `baseUrl`. A user who supplies only `remote.host` or `remote.port` still has the default `baseUrl`, so the custom host/port will not determine the URL:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:674-683`

## Config reload limitations

Defaults reload on session start/tree and `/voice-debug`:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:877-886`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1861-1867`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2031-2041`

Custom event listeners are registered only at extension construction:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:2099-2120`

Therefore newly added custom event names do not become active after a config reload. Removed events leave listeners installed, though runtime checks usually make them no-op.

---

# Tests, README, changelog, and examples

## Tests

`events.test.ts` covers:

- Public voice events.
- TTS enablement.
- Basic Markdown cleanup.
- Generic fenced-code description.
- One streaming-thinking/final-text ordering case.
- Remote non-streaming requests.

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts:311-920`

Missing coverage includes:

- Actual LLM summarization and fallback.
- Whole-message code-summary behavior.
- Prompt suffix behavior.
- Tool results and message roles.
- `splitSpeechText()` and hard maximum invariants.
- Streaming fences and malformed Markdown.
- Config validation/error behavior.
- `defaultModel` preservation.
- Custom-event reloads.
- Pronunciation rules.
- STT hallucination filtering and segmentation.
- CLI preprocessing parity.

The event tests directly back up and overwrite the user’s real config:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts:28-115`

The package’s `test` script runs only `server.test.ts`; it does not run `events.test.ts`:

- `/home/jesse/gh/my-pi/packages/pi-voice/package.json:47-55`

`server.test.ts` thoroughly tests server lifecycle and queueing but no text transformation:

- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.test.ts:96-565`

## README

The README documents installation, commands, config location, and remote URL basics:

- `/home/jesse/gh/my-pi/packages/pi-voice/README.md:5-54`

It does not document:

- Event config variants.
- `content` modes.
- Default-vs-example event behavior.
- Implicit code summarization.
- Markdown lossiness.
- Chunk semantics.
- Tool-output behavior.
- Per-event model selection.
- Config reload behavior.
- Pronunciation support or lack thereof.

Its monorepo examples use hardcoded `/Users/jac/my-pi` paths:

- `/home/jesse/gh/my-pi/packages/pi-voice/README.md:20-33`

## Changelog

The changelog is inherited from upstream and reports versions through `2.0.1`, while this package declares `0.1.0`:

- `/home/jesse/gh/my-pi/packages/pi-voice/CHANGELOG.md:8-24`
- `/home/jesse/gh/my-pi/packages/pi-voice/package.json:1-4`

It also says `EventConfig` accepts `{prompt, model?}` or `{text}`, but the current source additionally supports raw `{content}` and prompt-plus-content:

- `/home/jesse/gh/my-pi/packages/pi-voice/CHANGELOG.md:18-24`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:109-127`

Remote streaming, STT, current Markdown processing, and code-summary behavior are absent from the changelog.

## Example/config initialization

The only example is `voice-config.example.json`. It enables streaming thinking and final text, unlike the no-file default of ultra-short `agent_end` summarization:

- `/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json:25-32`
- `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:650-664`

The installer copies that example only when config is missing:

- `/home/jesse/gh/my-pi/packages/pi-voice/scripts/install-server-macos.sh:24-32`

The package initializer is explicitly opt-in:

- `/home/jesse/gh/my-pi/packages/pi-voice/src/prepare.js:3-18`

Resetting through `/voice` writes source defaults rather than restoring the shipped example, so reset changes the event strategy to ultra-short `agent_end` summarization.

---

# Reusable implementation paths

These existing paths are worth retaining and extracting rather than replacing wholesale:

1. **`prepareTextForSpeech()` as the public compatibility entry point**  
   `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:465-487`  
   Keep its API, but delegate to a structured pipeline shared by the extension and CLI.

2. **Fence scanner as a first-pass tokenizer**  
   `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:418-463`  
   Change it to return prose/code segments instead of immediately deleting code.

3. **Existing LLM session helper**  
   `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:751-815`  
   Generalize it from “summarize a message” to transform a specific typed segment.

4. **Per-event prompt/model/content configuration**  
   `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:104-127`  
   Preserve backward compatibility, but add explicit tagged modes.

5. **Existing `PI_VOICE_DIR` external state location**  
   `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:267-271`  
   Use it for pronunciation dictionaries and prompt files.

6. **Audio and auto-TTS queues**  
   `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:888-926`  
   The serialization layer can consume a richer `SpeechPlan` without redesign.

7. **Existing chunkers**  
   `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:553-586`  
   `/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts:1496-1549`  
   Consolidate them into one segmenter rather than maintaining two semantics.

8. **Typed Pi tool events**  
   `/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:838-844`  
   Register these directly for structured output summaries.

---

# Recommended design

## 1. Introduce one structured speech pipeline

Use a typed internal document rather than repeatedly transforming strings:

```ts
interface SpeechSegment {
  kind:
    | "prose"
    | "heading"
    | "listItem"
    | "inlineCode"
    | "codeBlock"
    | "command"
    | "path"
    | "url"
    | "error"
    | "toolOutput";
  text: string;
  language?: string;
  toolName?: string;
  isError?: boolean;
}

interface SpeechContext {
  source: "auto" | "tool" | "sample" | "cli";
  event?: string;
  role?: "assistant" | "user" | "toolResult";
  voice: string;
  language?: string;
}
```

Pipeline order:

1. Select message/tool content with role checks.
2. Parse Markdown into typed segments.
3. Transform code/tool segments according to configuration.
4. Run optional LLM summarization only on selected segments.
5. Apply pronunciation rules once.
6. Chunk by semantic boundaries.
7. Synthesize and queue playback.

This removes duplicate preprocessing and gives pronunciation rules enough context.

## 2. Make summarization explicit

Replace implicit behavior such as “presence of fence means summarize everything” with a tagged mode:

```json
{
  "events": {
    "message_end": {
      "roles": ["assistant"],
      "content": ["text"],
      "speechMode": "intelligible"
    }
  }
}
```

Suggested modes:

- `verbatim`: minimal whitespace cleanup.
- `clean`: Markdown removal only.
- `intelligible`: deterministic code/output descriptions.
- `summary`: explicit whole-message LLM summary.
- `off`.

Backward compatibility:

- Existing `{text}` → fixed `clean`.
- Existing `{prompt}` → `summary`.
- Existing `{content}` → `intelligible`, but do not automatically summarize surrounding prose.

## 3. Summarize code blocks independently

For each code block, preserve surrounding prose unchanged and choose a configurable strategy:

```json
{
  "speechProcessing": {
    "code": {
      "default": {
        "mode": "structured",
        "maxItems": 4
      },
      "byLanguage": {
        "bash": { "mode": "commands" },
        "sh": { "mode": "commands" },
        "json": { "mode": "keys" },
        "diff": { "mode": "diff-summary" }
      },
      "llm": {
        "enabled": true,
        "promptFile": "prompts/code-summary.txt",
        "fallback": "structured",
        "maxInputChars": 8000
      }
    }
  }
}
```

Useful deterministic summaries:

- Shell: command/subcommand, important flags, target paths.
- JSON/YAML: top-level keys and selected scalar values.
- Diff: affected files and additions/removals.
- Stack trace/log: exception, exit status, first relevant frame, repeated-line count.
- General source: declarations, function/class names, imports, and line count.
- Short snippets: optionally verbalize literally up to a configured line/token limit.
- Unknown/large blocks: announce language, intent if detectable, and size.

Errors should generally retain **more** exact information than successful output.

## 4. Handle structured tool output directly

Register `tool_result` or `tool_execution_end`, retain metadata, and configure per tool:

```json
{
  "speechProcessing": {
    "toolOutput": {
      "default": {
        "mode": "count-and-sample",
        "maxItems": 3
      },
      "byTool": {
        "bash": { "mode": "command-status-error-tail" },
        "read": { "mode": "file-and-range" },
        "grep": { "mode": "count-and-paths" },
        "find": { "mode": "count-and-paths" },
        "edit": { "mode": "changed-file" },
        "write": { "mode": "written-file" }
      }
    }
  }
}
```

Do not infer tool output from generic Markdown where structured event data is available.

## 5. Load pronunciation rules outside source

Add a config-declared list under the existing config directory:

```json
{
  "speechProcessing": {
    "pronunciationFiles": [
      "pronunciations.json"
    ]
  }
}
```

Resolve relative paths against `${PI_VOICE_DIR}`, not the process working directory. Optionally allow explicit absolute paths and `~` expansion.

Example `${PI_VOICE_DIR}/pronunciations.json`:

```json
{
  "version": 1,
  "rules": [
    {
      "match": {
        "type": "literal",
        "value": "pnpm",
        "wholeToken": true,
        "caseSensitive": false
      },
      "speakAs": "P N P M",
      "priority": 100,
      "scope": {
        "sources": ["auto", "tool", "cli"],
        "roles": ["assistant"],
        "kinds": ["prose", "command"],
        "languages": ["en"]
      }
    },
    {
      "match": {
        "type": "literal",
        "value": "C++",
        "wholeToken": true
      },
      "speakAs": "C plus plus",
      "scope": {
        "kinds": ["prose", "inlineCode", "codeBlock"]
      }
    }
  ]
}
```

Important rule semantics:

- Literal matching by default; regex only by explicit opt-in.
- Unicode-aware token boundaries.
- Priority followed by longest match.
- No recursive reapplication.
- Protect URLs, paths, secrets, and opaque identifiers unless their segment kind is explicitly scoped.
- Allow scopes by source, event, role, content kind, tool name, code language, voice, and spoken language.
- Validate files before activation; keep the last valid rules on reload failure.
- Reload at session start and via an explicit `/voice-reload`.
- Add debug output showing which rule matched without logging secrets.

Apply rules after summaries are generated but before chunking, so generated terms are also pronounced consistently.

## 6. Externalize prompts too

Support `promptFile` alongside inline `prompt`:

- Resolve relative to `${PI_VOICE_DIR}`.
- Do not append mandatory instructions silently.
- Provide separate templates for whole-message summaries, code blocks, errors, and tool results.
- Pass structured facts such as tool name, language, and error status.
- Use explicit fallback behavior: `structured`, `clean`, `verbatim`, or `silence`.

## 7. Replace soft chunk limits with semantic hard limits

Create one chunker shared by local, remote, CLI, and streaming paths:

- Preserve paragraph/list boundaries as pauses.
- Avoid splitting URLs, paths, inline code, abbreviations, and surrogate pairs.
- Use sentence and word segmentation, preferably `Intl.Segmenter`.
- Enforce an actual hard maximum.
- If a single protected token exceeds the limit, apply an explicit long-token policy.
- On forced streaming flush, repeatedly emit bounded chunks rather than the whole buffer.
- Maintain per-message Markdown/fence state and wait for a closed code block before summarizing it.

Move generic speech chunk settings out of `remote`, since they currently affect local streaming too.

## 8. Unify and validate configuration

Create one exported schema/type used by the extension, CLI, initializer, and tests. It should include:

- `defaultModel`.
- Speech-processing settings.
- Pronunciation files.
- Tagged event variants.
- Explicit roles.
- Prompt files.
- Chunk strategy.
- STT filtering/segmentation settings if those should be user-tunable.

Parse with TypeBox validation rather than raw casts. On malformed config, fail closed for auto-TTS rather than unexpectedly enabling default narration.

When updating `/voice`, patch only `enabled`, `voice`, and `speed` into the original raw object so unrelated keys survive.

## 9. Test recommendations

Highest-value additions:

1. Move event tests to a temporary `PI_VOICE_DIR` set before dynamically importing the extension.
2. Run both test files from the package `test` script.
3. Export pure Markdown, code, pronunciation, and chunk helpers.
4. Add golden tests for:
   - Multiple/unterminated/mixed fences.
   - Lists, links, tables, paths, URLs, globs, underscores, and inline code.
   - Code-only versus mixed prose/code.
   - Tool result roles and errors.
   - Hard chunk-size invariants.
   - Streaming fences across delta boundaries.
   - Pronunciation scope, precedence, and non-cascading behavior.
   - Config preservation and invalid-config fail-closed behavior.
   - LLM unavailable and deterministic fallback behavior.
5. Add STT tests for legitimate “thank you”/“bye” utterances and configurable filtering.

Overall, the best incremental route is to preserve `prepareTextForSpeech()`, `generateSpeechText()`, the fence scanner, and playback queues, but place them behind a single structured, configuration-driven `SpeechPlan` pipeline.
</task_result>
</task>
```

**Tool: glob**

**Input:**
```json
{
  "pattern": "packages/pi-voice/**/*.{ts,tsx,js,json,md,yaml,yml,toml}",
  "path": "/home/jesse/gh/my-pi"
}
```

**Output:**
```
/home/jesse/gh/my-pi/packages/pi-voice/package.json
/home/jesse/gh/my-pi/packages/pi-voice/README.md
/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json
/home/jesse/gh/my-pi/packages/pi-voice/tsconfig.json
/home/jesse/gh/my-pi/packages/pi-voice/src/prepare.js
/home/jesse/gh/my-pi/packages/pi-voice/src/cli.ts
/home/jesse/gh/my-pi/packages/pi-voice/CHANGELOG.md
/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts
/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts
/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts
/home/jesse/gh/my-pi/packages/pi-voice/extensions/stt.ts
/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.test.ts
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/package.json"
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/package.json</path>
<type>file</type>
<content>
1: {
2:   "name": "@jac/pi-voice",
3:   "version": "0.1.0",
4:   "description": "Pi voice extension: Kokoro TTS, remote TTS playback, auto-TTS, and local STT dictation.",
5:   "type": "module",
6:   "license": "MIT",
7:   "author": "Jesse C",
8:   "keywords": [
9:     "pi-package",
10:     "pi-extension",
11:     "pi",
12:     "pi-coding-agent",
13:     "tts",
14:     "stt",
15:     "kokoro",
16:     "speech-synthesis",
17:     "dictation"
18:   ],
19:   "repository": {
20:     "type": "git",
21:     "url": "git+https://github.com/jesseconis/my-pi.git",
22:     "directory": "packages/pi-voice"
23:   },
24:   "bin": {
25:     "pi-voice": "./src/cli.ts"
26:   },
27:   "files": [
28:     "extensions",
29:     "src",
30:     "config/voice-config.example.json",
31:     "scripts/start-pi-voice-server.sh",
32:     "scripts/install-server-macos.sh",
33:     "launchd/local.pi-voice.plist.template",
34:     "README.md",
35:     "CHANGELOG.md",
36:     "LICENSE",
37:     "!.github"
38:   ],
39:   "pi": {
40:     "extensions": [
41:       "./extensions/index.ts"
42:     ]
43:   },
44:   "publishConfig": {
45:     "access": "public"
46:   },
47:   "scripts": {
48:     "test": "node --import jiti extensions/server.test.ts",
49:     "lint": "biome check .",
50:     "lint:fix": "biome check --write .",
51:     "format": "biome format --write .",
52:     "typecheck": "tsc --noEmit",
53:     "cli": "node --import jiti src/cli.ts",
54:     "server": "node --import jiti extensions/server.ts",
55:     "prepare-models": "node --import jiti src/prepare.js"
56:   },
57:   "dependencies": {
58:     "@huggingface/transformers": "^3.7.5",
59:     "decibri": "^3.4.2",
60:     "jiti": "^2.4.2",
61:     "kokoro-js": "^1.2.1",
62:     "sherpa-onnx-node": "^1.13.2"
63:   },
64:   "peerDependencies": {
65:     "@earendil-works/pi-ai": "*",
66:     "@earendil-works/pi-coding-agent": "*",
67:     "@earendil-works/pi-tui": "*",
68:     "typebox": "*"
69:   },
70:   "devDependencies": {
71:     "@earendil-works/pi-coding-agent": "^0.80.2",
72:     "@types/node": "^24.0.0",
73:     "typebox": "^1.1.24",
74:     "typescript": "^5.0.0"
75:   }
76: }

(End of file - total 76 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/README.md"
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/README.md</path>
<type>file</type>
<content>
1: # @jac/pi-voice
2: 
3: Pi voice package based on `S1M0N38/pi-voice`, with local/remote Kokoro TTS, automatic assistant narration, and local STT dictation.
4: 
5: ## Runtime behavior
6: 
7: - Pi loads the extension from `extensions/index.ts`.
8: - The extension reads runtime config from `~/.pi/voice/config.json`.
9: - The local Kokoro server stores cache/log/runtime files under `~/.pi/voice/`.
10: - This package only ships `config/voice-config.example.json`; real config and secrets stay outside git.
11: 
12: ## Commands/tools
13: 
14: - `/voice` — TTS settings/debug panel.
15: - `/dictate` — local STT dictation, then paste transcript into Pi editor.
16: - `/voice-debug` — show active runtime config/backend.
17: - `/voice-log` — show recent `~/.pi/voice/debug.log` entries.
18: - `tts` tool — LLM-callable text-to-speech playback.
19: 
20: ## Install from this monorepo
21: 
22: From the monorepo root:
23: 
24: ```bash
25: pnpm install
26: pi install /Users/jac/my-pi
27: ```
28: 
29: For a temporary test:
30: 
31: ```bash
32: pi -e /Users/jac/my-pi
33: ```
34: 
35: ## Optional local TTS server on macOS
36: 
37: Remote TTS does not need the local server. For local Kokoro inference:
38: 
39: ```bash
40: packages/pi-voice/scripts/install-server-macos.sh
41: ```
42: 
43: The installer copies the start script to `~/.pi/voice/`, creates `~/.pi/voice/config.json` only if missing, and writes a LaunchAgent. It does not modify Pi package settings; use `pi install /Users/jac/my-pi` separately.
44: 
45: ## Example config
46: 
47: Copy and edit if needed:
48: 
49: ```bash
50: mkdir -p ~/.pi/voice
51: cp packages/pi-voice/config/voice-config.example.json ~/.pi/voice/config.json
52: ```
53: 
54: Set `backend` to `remote` and use a full URL including scheme, for example `https://vox.example.com`. Do not commit auth tokens.

(End of file - total 54 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/CHANGELOG.md"
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/CHANGELOG.md</path>
<type>file</type>
<content>
1: # Changelog
2: 
3: All notable changes to this project will be documented in this file.
4: 
5: The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
6: and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
7: 
8: ## [2.0.1](https://github.com/S1M0N38/pi-voice/compare/v2.0.0...v2.0.1) (2026-05-07)
9: 
10: 
11: ### Bug Fixes
12: 
13: * move model cache to ~/.pi/voice/cache/ ([2ed7462](https://github.com/S1M0N38/pi-voice/commit/2ed74626d4f7904e67e58f0b469a29335d3c1715))
14: 
15: ## [2.0.0](https://github.com/S1M0N38/pi-voice/compare/v1.2.0...v2.0.0) (2026-05-06)
16: 
17: 
18: ### ⚠ BREAKING CHANGES
19: 
20: * Config moved from ~/.pi/voice.json to ~/.pi/voice/config.json. The summaryModel field is removed; use per-event model in events config instead. EventConfig now accepts { prompt, model? } or { text } (mutually exclusive).
21: 
22: ### Features
23: 
24: * overhaul event config and migrate state to ~/.pi/voice/ ([3242af6](https://github.com/S1M0N38/pi-voice/commit/3242af6f51d5ed3f50467777f6be9d09bfca7630))
25: 
26: ## [1.2.0](https://github.com/S1M0N38/pi-voice/compare/v1.1.0...v1.2.0) (2026-05-05)
27: 
28: 
29: ### Features
30: 
31: * serialize audio playback to prevent overlapping speech ([946f533](https://github.com/S1M0N38/pi-voice/commit/946f53364ec243a54c671193e781e46911e62dbd))
32: * **server:** add FIFO queue to serialize /tts requests ([82caeb8](https://github.com/S1M0N38/pi-voice/commit/82caeb8bf53e5a4063e933735250a1d750f8dc21))
33: 
34: 
35: ### Bug Fixes
36: 
37: * preserve user events config and persist reset to defaults ([d4e4ad1](https://github.com/S1M0N38/pi-voice/commit/d4e4ad11de3b029e536b972ce9d728c477b9c6f0))
38: * resolve biome lint errors blocking CI ([0d764c0](https://github.com/S1M0N38/pi-voice/commit/0d764c018305cccdcfe6be9a3f42cba7e66345e9))
39: * **test:** use real default summary prompt in queue test config ([4ad65d4](https://github.com/S1M0N38/pi-voice/commit/4ad65d4bc71eebffc974eb22c75c05ab4111102e))
40: 
41: ## [1.1.0](https://github.com/S1M0N38/pi-voice/compare/v1.0.1...v1.1.0) (2026-05-05)
42: 
43: 
44: ### Features
45: 
46: * add event bus and status bar indicator ([dd8aeeb](https://github.com/S1M0N38/pi-voice/commit/dd8aeeb9327d6ef33c517b63ea0d9539176fe16f))
47: 
48: ## [1.0.1](https://github.com/S1M0N38/pi-voice/compare/v1.0.0...v1.0.1) (2026-05-05)
49: 
50: 
51: ### Bug Fixes
52: 
53: * **ci:** resolve platform-specific deps by regenerating lockfile on runner ([1d9fb93](https://github.com/S1M0N38/pi-voice/commit/1d9fb93547335f9c9acdb05d151544e92651debe))
54: * set repository.url for npm provenance verification ([bf2c1f7](https://github.com/S1M0N38/pi-voice/commit/bf2c1f7a69ab4c80a912ba259724bebb8c0ae519))
55: 
56: 
57: ## 1.0.0 (2026-05-05)
58: 
59: 
60: ### ⚠ BREAKING CHANGES
61: 
62: * rename template placeholders to pi-voice
63: 
64: ### Features
65: 
66: * add Kokoro TTS HTTP server ([68302fa](https://github.com/S1M0N38/pi-voice/commit/68302fa1a4926a25dad79f8af0d8d5e6b5f79071))
67: * add pi extension with tts tool and /voice command ([bd17b81](https://github.com/S1M0N38/pi-voice/commit/bd17b81abe7465bd12893d1c2f77269dde647ced))
68: * add prepare script for default config on install ([d2c7415](https://github.com/S1M0N38/pi-voice/commit/d2c7415ebec1dec445ba95e3347a64c078805dd3))
69: * custom TUI, auto-TTS events, and async speak ([69c6c05](https://github.com/S1M0N38/pi-voice/commit/69c6c05263b1aa1703461c5c29e920013788d4eb))
70: 
71: 
72: ### Bug Fixes
73: 
74: * **voice:** use pi-voice CLI syntax in server hints ([93cbdad](https://github.com/S1M0N38/pi-voice/commit/93cbdadd44f14788af099f018759370a260a4311))
75: 
76: 
77: ### Code Refactoring
78: 
79: * rename template placeholders to pi-voice ([8398cf8](https://github.com/S1M0N38/pi-voice/commit/8398cf813f2b757ed3e87cfdd38a91c5edd898a6))

(End of file - total 79 lines)
</content>
```

---

## Assistant (Plan · GPT-5.6 Sol · 10.7s)

_Thinking:_

**Planning maintainable inspection strategy**

The extension currently has three independent backlog layers and no turn identity, so queue skipping cannot be made reliable by clearing the final playback array alone. The text side is similarly fragmented: code fences trigger whole-response LLM rewriting in one path, while direct speech reduces fences to language plus line count, and pronunciation preprocessing would currently run twice.

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts",
  "offset": 90,
  "limit": 230
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts</path>
<type>file</type>
<content>
90:       return data === "\x1b[A";
91:     case "down":
92:       return data === "\x1b[B";
93:     case "right":
94:       return data === "\x1b[C";
95:     case "left":
96:       return data === "\x1b[D";
97:     default:
98:       return false;
99:   }
100: }
101: 
102: // ── Types ──────────────────────────────────────────────────────────
103: 
104: interface ModelConfig {
105:   provider: string;
106:   id: string;
107: }
108: 
109: type EventConfig = SummarizeEventConfig | DirectEventConfig | RawEventConfig;
110: 
111: type SpeechContentMode = "text" | "thinking" | "all";
112: 
113: interface SummarizeEventConfig {
114:   prompt: string;
115:   model?: ModelConfig;
116:   /** Which assistant content blocks to summarize/speak. Defaults to final text only. */
117:   content?: SpeechContentMode;
118: }
119: 
120: interface DirectEventConfig {
121:   text: string;
122: }
123: 
124: interface RawEventConfig {
125:   /** Which assistant content blocks to speak directly. Defaults to final text only. */
126:   content?: SpeechContentMode;
127: }
128: 
129: interface FullVoiceConfig {
130:   enabled: boolean;
131:   voice: string;
132:   speed: number;
133:   backend: "local" | "remote";
134:   host: string;
135:   port: number;
136:   remote?: RemoteVoiceConfig;
137:   stt?: SttVoiceConfig;
138:   events?: Record<string, EventConfig>;
139: }
140: 
141: interface RemoteVoiceConfig {
142:   baseUrl?: string;
143:   host?: string;
144:   port?: number;
145:   authToken?: string;
146:   speechPath?: string;
147:   streamPath?: string;
148:   stream?: boolean;
149:   streamFormat?: "pcm" | "wav";
150:   chunkText?: boolean;
151:   chunkMaxChars?: number;
152: }
153: 
154: interface SttVoiceConfig {
155:   enabled?: boolean;
156:   mode?: "local";
157:   modelDir?: string;
158:   language?: string;
159:   audioCues?: boolean;
160:   startCue?: string;
161:   finishCue?: string;
162: }
163: 
164: interface VoiceSessionState {
165:   enabled?: boolean;
166:   voice?: string;
167:   speed?: number;
168: }
169: 
170: // ── Event Types (exported) ──────────────────────────────────────
171: 
172: export type VoiceSpeakSource = "tool" | "auto" | "sample";
173: 
174: export interface VoiceConfigEvent {
175:   enabled: boolean;
176:   voice: string;
177:   speed: number;
178: }
179: 
180: export interface VoiceSpeakStartEvent {
181:   text: string;
182:   voice: string;
183:   speed: number;
184:   source: VoiceSpeakSource;
185: }
186: 
187: export interface VoiceSpeakEndEvent {
188:   text: string;
189:   source: VoiceSpeakSource;
190:   error?: string;
191: }
192: 
193: export interface VoiceEventMap {
194:   "voice:config": VoiceConfigEvent;
195:   "voice:speak_start": VoiceSpeakStartEvent;
196:   "voice:speak_end": VoiceSpeakEndEvent;
197: }
198: 
199: // ── Configuration Schema (TypeBox) ───────────────────────────────
200: 
201: const ModelSchema = Type.Object({
202:   provider: Type.String({ minLength: 1 }),
203:   id: Type.String({ minLength: 1 }),
204: });
205: 
206: const SpeechContentModeSchema = Type.Union([
207:   Type.Literal("text"),
208:   Type.Literal("thinking"),
209:   Type.Literal("all"),
210: ]);
211: 
212: const SummarizeEventConfigSchema = Type.Object({
213:   prompt: Type.String({ minLength: 1 }),
214:   model: Type.Optional(ModelSchema),
215:   content: Type.Optional(SpeechContentModeSchema),
216: });
217: 
218: const DirectEventConfigSchema = Type.Object({
219:   text: Type.String({ minLength: 1 }),
220: });
221: 
222: const RawEventConfigSchema = Type.Object({
223:   content: Type.Optional(SpeechContentModeSchema),
224: });
225: 
226: const EventConfigSchema = Type.Union([
227:   SummarizeEventConfigSchema,
228:   DirectEventConfigSchema,
229:   RawEventConfigSchema,
230: ]);
231: 
232: const _VoiceConfigSchema = Type.Object({
233:   enabled: Type.Optional(Type.Boolean({ default: true })),
234:   voice: Type.Optional(Type.String({ default: "af_heart" })),
235:   speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3.0, default: 1.0 })),
236:   backend: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
237:   host: Type.Optional(Type.String({ default: "127.0.0.1" })),
238:   port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535, default: 8181 })),
239:   remote: Type.Optional(
240:     Type.Object({
241:       baseUrl: Type.Optional(Type.String({ minLength: 1 })),
242:       host: Type.Optional(Type.String({ minLength: 1 })),
243:       port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
244:       authToken: Type.Optional(Type.String()),
245:       speechPath: Type.Optional(Type.String({ minLength: 1 })),
246:       streamPath: Type.Optional(Type.String({ minLength: 1 })),
247:       stream: Type.Optional(Type.Boolean()),
248:       streamFormat: Type.Optional(Type.Union([Type.Literal("pcm"), Type.Literal("wav")])),
249:       chunkText: Type.Optional(Type.Boolean()),
250:       chunkMaxChars: Type.Optional(Type.Number({ minimum: 80, maximum: 2000 })),
251:     }),
252:   ),
253:   stt: Type.Optional(
254:     Type.Object({
255:       enabled: Type.Optional(Type.Boolean()),
256:       mode: Type.Optional(Type.Literal("local")),
257:       modelDir: Type.Optional(Type.String({ minLength: 1 })),
258:       language: Type.Optional(Type.String({ minLength: 1 })),
259:       audioCues: Type.Optional(Type.Boolean()),
260:       startCue: Type.Optional(Type.String({ minLength: 1 })),
261:       finishCue: Type.Optional(Type.String({ minLength: 1 })),
262:     }),
263:   ),
264:   events: Type.Optional(Type.Record(Type.String(), EventConfigSchema)),
265: });
266: 
267: // ── Constants ──────────────────────────────────────────────────────
268: 
269: const CONFIG_DIR = resolve(process.env.PI_VOICE_DIR ?? join(homedir(), ".pi", "voice"));
270: const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
271: const DEBUG_LOG_PATH = resolve(CONFIG_DIR, "debug.log");
272: const MACOS_SOUND_DIR = "/System/Library/Sounds";
273: const SPEED_VALUES = [
274:   "0.5",
275:   "0.75",
276:   "1.0",
277:   "1.25",
278:   "1.5",
279:   "1.75",
280:   "2.0",
281:   "2.25",
282:   "2.5",
283:   "2.75",
284:   "3.0",
285: ];
286: 
287: const DEFAULT_SUMMARY_PROMPT =
288:   "You are preparing text for a text-to-speech system. " +
289:   "You will receive a message from a conversation enclosed in quadruple backticks. " +
290:   "Summarize it in one single very short sentence, two at most. " +
291:   "Use a dry, matter-of-fact tone. " +
292:   "Do not use any markdown formatting, just plain text. " +
293:   "Prefer words over symbols or abbreviations, as this will be read aloud. " +
294:   "Output only the sentence, nothing else.";
295: 
296: const CODEBLOCK_SPEECH_PROMPT =
297:   "You are preparing an assistant response for a text-to-speech system. " +
298:   "Convert the message into concise, natural spoken language. " +
299:   "If it contains code blocks, do not read syntax literally. " +
300:   "Instead, briefly explain what the code does and mention only important commands, " +
301:   "identifiers, files, errors, or APIs. " +
302:   "Do not use markdown formatting, code fences, bullets, or symbol-heavy text. " +
303:   "Output only plain text.";
304: 
305: const CODEBLOCK_PROMPT_SUFFIX =
306:   " If the source includes code blocks, do not read syntax literally; briefly paraphrase " +
307:   "what the code does and mention only important commands, identifiers, files, errors, or APIs. " +
308:   "Output plain spoken text only.";
309: 
310: const DEFAULT_REMOTE_CONFIG: Required<RemoteVoiceConfig> = {
311:   baseUrl: "http://127.0.0.1:8880",
312:   host: "127.0.0.1",
313:   port: 8880,
314:   authToken: "",
315:   speechPath: "/v1/audio/speech",
316:   streamPath: "/v1/audio/speech/stream",
317:   stream: true,
318:   streamFormat: "pcm",
319:   chunkText: true,

(Showing lines 90-319 of 2121. Use offset=320 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts",
  "offset": 380,
  "limit": 340
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts</path>
<type>file</type>
<content>
380:   const lang = langMap[name[0]] ?? "";
381:   const gender = genderMap[name[1]] ?? "";
382:   if (lang && gender) return `${lang} ${gender}`;
383:   if (gender) return gender;
384:   return lang;
385: }
386: 
387: function spokenLanguageName(info: string): string {
388:   const language = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
389:   const map: Record<string, string> = {
390:     bash: "shell",
391:     js: "JavaScript",
392:     javascript: "JavaScript",
393:     json: "JSON",
394:     md: "Markdown",
395:     py: "Python",
396:     python: "Python",
397:     sh: "shell",
398:     shell: "shell",
399:     ts: "TypeScript",
400:     tsx: "TypeScript React",
401:     typescript: "TypeScript",
402:   };
403:   return map[language] ?? language;
404: }
405: 
406: function describeCodeBlock(info: string, codeLines: string[]): string {
407:   const language = spokenLanguageName(info);
408:   const nonEmptyLines = codeLines.filter((line) => line.trim()).length;
409:   const languageText = language ? `${language} ` : "";
410:   const lineText = nonEmptyLines > 0 ? ` with ${nonEmptyLines} non empty lines` : "";
411:   return `The response includes a ${languageText}code block${lineText}.`;
412: }
413: 
414: export function containsFencedCodeBlock(text: string): boolean {
415:   return /^\s*(`{3,}|~{3,})/m.test(text);
416: }
417: 
418: function replaceFencedCodeBlocks(text: string): string {
419:   const lines = text.replace(/\r\n/g, "\n").split("\n");
420:   const output: string[] = [];
421:   let inCodeBlock = false;
422:   let fenceChar = "`";
423:   let fenceLength = 3;
424:   let info = "";
425:   let codeLines: string[] = [];
426: 
427:   for (const line of lines) {
428:     if (!inCodeBlock) {
429:       const opening = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
430:       if (opening?.[1]) {
431:         inCodeBlock = true;
432:         fenceChar = opening[1][0] ?? "`";
433:         fenceLength = opening[1].length;
434:         info = opening[2] ?? "";
435:         codeLines = [];
436:         continue;
437:       }
438:       output.push(line);
439:       continue;
440:     }
441: 
442:     const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/);
443:     if (
444:       closing?.[1] &&
445:       closing[1][0] === fenceChar &&
446:       closing[1].length >= fenceLength
447:     ) {
448:       output.push(describeCodeBlock(info, codeLines));
449:       inCodeBlock = false;
450:       info = "";
451:       codeLines = [];
452:       continue;
453:     }
454: 
455:     codeLines.push(line);
456:   }
457: 
458:   if (inCodeBlock) {
459:     output.push(describeCodeBlock(info, codeLines));
460:   }
461: 
462:   return output.join("\n");
463: }
464: 
465: export function prepareTextForSpeech(text: string): string {
466:   return replaceFencedCodeBlocks(text)
467:     .replace(/\r\n/g, "\n")
468:     .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
469:     .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
470:     .replace(/^\s{0,3}#{1,6}\s+/gm, "")
471:     .replace(/^\s{0,3}>\s?/gm, "")
472:     .replace(/^\s*[-*_]{3,}\s*$/gm, "")
473:     .replace(/^\s*[-*+]\s+/gm, "")
474:     .replace(/^\s*\d+[.)]\s+/gm, "")
475:     .replace(/`([^`\n]+)`/g, "$1")
476:     .replace(/(\*\*\*|___)([^\n]+?)\1/g, "$2")
477:     .replace(/(\*\*|__)([^\n]+?)\1/g, "$2")
478:     .replace(/\*([^\n]+?)\*/g, "$1")
479:     .replace(/(^|[\s([{])_([^_\n]+?)_($|[\s)\]},.!?;:])/g, "$1$2$3")
480:     .replace(/[*]+/g, "")
481:     .replace(/_{2,}/g, "")
482:     .replace(/`+/g, "")
483:     .replace(/[ \t]+/g, " ")
484:     .replace(/\s+([.,;:!?])/g, "$1")
485:     .replace(/\n{3,}/g, "\n\n")
486:     .trim();
487: }
488: 
489: function trimTrailingSlash(value: string): string {
490:   return value.replace(/\/+$/, "");
491: }
492: 
493: function withLeadingSlash(value: string): string {
494:   return value.startsWith("/") ? value : `/${value}`;
495: }
496: 
497: function normalizeBaseUrl(value: string): string {
498:   const trimmed = trimTrailingSlash(value.trim());
499:   if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) return trimmed;
500:   return `https://${trimmed}`;
501: }
502: 
503: function remoteConfig(config: FullVoiceConfig): Required<RemoteVoiceConfig> {
504:   const remote = config.remote ?? {};
505:   const host = remote.host ?? DEFAULT_REMOTE_CONFIG.host;
506:   const port = remote.port ?? DEFAULT_REMOTE_CONFIG.port;
507:   return {
508:     baseUrl: normalizeBaseUrl(remote.baseUrl ?? `http://${host}:${port}`),
509:     host,
510:     port,
511:     authToken: remote.authToken ?? DEFAULT_REMOTE_CONFIG.authToken,
512:     speechPath: withLeadingSlash(remote.speechPath ?? DEFAULT_REMOTE_CONFIG.speechPath),
513:     streamPath: withLeadingSlash(remote.streamPath ?? DEFAULT_REMOTE_CONFIG.streamPath),
514:     stream: remote.stream ?? DEFAULT_REMOTE_CONFIG.stream,
515:     streamFormat: remote.streamFormat ?? DEFAULT_REMOTE_CONFIG.streamFormat,
516:     chunkText: remote.chunkText ?? DEFAULT_REMOTE_CONFIG.chunkText,
517:     chunkMaxChars: remote.chunkMaxChars ?? DEFAULT_REMOTE_CONFIG.chunkMaxChars,
518:   };
519: }
520: 
521: function sttConfig(config: FullVoiceConfig): SttRuntimeConfig {
522:   const stt = config.stt ?? {};
523:   return {
524:     enabled: stt.enabled ?? DEFAULT_STT_CONFIG.enabled,
525:     modelDir: stt.modelDir ?? DEFAULT_STT_CONFIG.modelDir,
526:     language: stt.language ?? DEFAULT_STT_CONFIG.language,
527:     audioCues: stt.audioCues ?? DEFAULT_STT_CONFIG.audioCues,
528:     startCue: stt.startCue ?? DEFAULT_STT_CONFIG.startCue,
529:     finishCue: stt.finishCue ?? DEFAULT_STT_CONFIG.finishCue,
530:   };
531: }
532: 
533: function remoteUrl(config: FullVoiceConfig, path: string): string {
534:   const remote = remoteConfig(config);
535:   return `${remote.baseUrl}${withLeadingSlash(path)}`;
536: }
537: 
538: function remoteAuthHeaders(remote: Required<RemoteVoiceConfig>): Record<string, string> {
539:   const token = remote.authToken.trim();
540:   if (!token) return {};
541:   return {
542:     Authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
543:   };
544: }
545: 
546: function remoteJsonHeaders(remote: Required<RemoteVoiceConfig>): Record<string, string> {
547:   return {
548:     "Content-Type": "application/json",
549:     ...remoteAuthHeaders(remote),
550:   };
551: }
552: 
553: function splitSpeechText(text: string, maxChars: number): string[] {
554:   const normalized = text.replace(/\s+/g, " ").trim();
555:   if (!normalized) return [];
556:   if (normalized.length <= maxChars) return [normalized];
557: 
558:   const parts = normalized.match(/[^.!?;:]+[.!?;:]?|\S+/g) ?? [normalized];
559:   const chunks: string[] = [];
560:   let current = "";
561: 
562:   for (const raw of parts) {
563:     const part = raw.trim();
564:     if (!part) continue;
565:     if (!current) {
566:       current = part;
567:       continue;
568:     }
569:     if (current.length + 1 + part.length <= maxChars) {
570:       current = `${current} ${part}`;
571:       continue;
572:     }
573:     chunks.push(current);
574:     current = part;
575:   }
576: 
577:   if (current) chunks.push(current);
578:   return chunks.flatMap((chunk) => {
579:     if (chunk.length <= maxChars * 1.5) return [chunk];
580:     const split: string[] = [];
581:     for (let i = 0; i < chunk.length; i += maxChars) {
582:       split.push(chunk.slice(i, i + maxChars).trim());
583:     }
584:     return split.filter(Boolean);
585:   });
586: }
587: 
588: function findExecutable(name: string): string | null {
589:   const pathValue = process.env.PATH ?? "";
590:   for (const dir of pathValue.split(":")) {
591:     if (!dir) continue;
592:     const candidate = resolve(dir, name);
593:     if (existsSync(candidate)) return candidate;
594:   }
595:   return null;
596: }
597: 
598: function streamingPcmPlayer(): { command: string; args: string[] } | null {
599:   const ffplay = findExecutable("ffplay");
600:   if (ffplay) {
601:     return {
602:       command: ffplay,
603:       args: [
604:         "-nodisp",
605:         "-autoexit",
606:         "-loglevel",
607:         "error",
608:         "-f",
609:         "s16le",
610:         "-sample_rate",
611:         "24000",
612:         "-ch_layout",
613:         "mono",
614:         "-i",
615:         "pipe:0",
616:       ],
617:     };
618:   }
619: 
620:   const play = findExecutable("play");
621:   if (play) {
622:     return { command: play, args: ["-q", "-t", "s16", "-r", "24000", "-c", "1", "-"] };
623:   }
624: 
625:   const aplay = findExecutable("aplay");
626:   if (aplay) {
627:     return { command: aplay, args: ["-q", "-f", "S16_LE", "-r", "24000", "-c", "1"] };
628:   }
629: 
630:   return null;
631: }
632: 
633: function withCodeblockInstructions(prompt: string): string {
634:   return prompt.includes(CODEBLOCK_PROMPT_SUFFIX)
635:     ? prompt
636:     : `${prompt}${CODEBLOCK_PROMPT_SUFFIX}`;
637: }
638: 
639: function wavPlaybackTimeoutMs(wavBuffer: Buffer): number | undefined {
640:   if (wavBuffer.length < 44 || wavBuffer.toString("ascii", 0, 4) !== "RIFF") {
641:     return undefined;
642:   }
643:   const byteRate = wavBuffer.readUInt32LE(28);
644:   const dataSize = wavBuffer.readUInt32LE(40);
645:   if (!byteRate || !dataSize) return undefined;
646:   const durationMs = (dataSize / byteRate) * 1000;
647:   return Math.ceil(Math.max(30_000, durationMs + 15_000));
648: }
649: 
650: const DEFAULT_CONFIG: FullVoiceConfig = {
651:   enabled: true,
652:   voice: "af_heart",
653:   speed: 1.0,
654:   backend: "local",
655:   host: "127.0.0.1",
656:   port: 8181,
657:   remote: { ...DEFAULT_REMOTE_CONFIG },
658:   stt: { ...DEFAULT_STT_CONFIG },
659:   events: {
660:     agent_end: {
661:       prompt: DEFAULT_SUMMARY_PROMPT,
662:     },
663:   },
664: };
665: 
666: // ── Config file persistence (~/.pi/voice/config.json) ──────────────
667: 
668: function loadConfig(): FullVoiceConfig {
669:   try {
670:     if (existsSync(CONFIG_PATH)) {
671:       const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
672:       // Do NOT merge with DEFAULT_CONFIG — only what the user has written runs.
673:       // If events is missing from user config, no auto-TTS events fire.
674:       const config = {
675:         enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
676:         voice: raw.voice ?? DEFAULT_CONFIG.voice,
677:         speed: raw.speed ?? DEFAULT_CONFIG.speed,
678:         backend: raw.backend === "remote" ? "remote" : DEFAULT_CONFIG.backend,
679:         host: raw.host ?? DEFAULT_CONFIG.host,
680:         port: raw.port ?? DEFAULT_CONFIG.port,
681:         remote: raw.remote ? { ...DEFAULT_REMOTE_CONFIG, ...raw.remote } : DEFAULT_CONFIG.remote,
682:         stt: raw.stt ? { ...DEFAULT_STT_CONFIG, ...raw.stt } : DEFAULT_CONFIG.stt,
683:         events: raw.events,
684:       };
685:       debugLog("config_loaded", {
686:         path: CONFIG_PATH,
687:         backend: config.backend,
688:         local: `${config.host}:${config.port}`,
689:         remote: config.remote?.baseUrl,
690:         stt: config.stt?.enabled ? "enabled" : "disabled",
691:         events: config.events ? Object.keys(config.events) : [],
692:       });
693:       return config;
694:     }
695:   } catch (error) {
696:     debugLog("config_load_error", { path: CONFIG_PATH, error: errorText(error) });
697:     /* use defaults */
698:   }
699:   debugLog("config_default", { path: CONFIG_PATH, backend: DEFAULT_CONFIG.backend });
700:   return { ...DEFAULT_CONFIG };
701: }
702: 
703: function saveConfig(config: FullVoiceConfig) {
704:   mkdirSync(CONFIG_DIR, { recursive: true });
705:   writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
706: }
707: 
708: // ── Context Extraction ────────────────────────────────────────────
709: 
710: /**
711:  * Extract last_message content from event data.
712:  * Handles both single-message events (turn_end, message_end)
713:  * and multi-message events (agent_end).
714:  */
715: // biome-ignore lint/suspicious/noExplicitAny: event shape varies by event type
716: function extractLastMessage(event: any, mode: SpeechContentMode = "text"): string {
717:   // agent_end has event.messages (array)
718:   if (event.messages && Array.isArray(event.messages) && event.messages.length > 0) {
719:     const lastMsg = event.messages[event.messages.length - 1];

(Showing lines 380-719 of 2121. Use offset=720 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts",
  "offset": 740,
  "limit": 220
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts</path>
<type>file</type>
<content>
740:       ) {
741:         return c.thinking;
742:       }
743:       return "";
744:     })
745:     .filter(Boolean)
746:     .join("\n");
747: }
748: 
749: // ── Event Processing ───────────────────────────────────────────────
750: 
751: async function generateSpeechText(
752:   prompt: string,
753:   context: string,
754:   ctx: ExtensionContext,
755:   modelConfig?: ModelConfig,
756: ): Promise<string | null> {
757:   try {
758:     const {
759:       AuthStorage,
760:       createAgentSession,
761:       DefaultResourceLoader,
762:       SessionManager,
763:     } = await import("@earendil-works/pi-coding-agent");
764:     // Resolve model: per-event model > active session model
765:     const model = modelConfig
766:       ? ctx.modelRegistry.find(modelConfig.provider, modelConfig.id)
767:       : ctx.model;
768:     if (!model) {
769:       return null;
770:     }
771: 
772:     const userMessage = context
773:       ? `The following is a message from a conversation that you need to summarize:\n\n""""\n${context}\n""""`
774:       : "Generate speech text.";
775: 
776:     const loader = new DefaultResourceLoader({
777:       cwd: process.cwd(),
778:       agentDir: resolve(homedir(), ".pi"),
779:       systemPromptOverride: () => prompt,
780:     });
781:     await loader.reload();
782: 
783:     const { session } = await createAgentSession({
784:       model,
785:       tools: [],
786:       sessionManager: SessionManager.inMemory(),
787:       authStorage: AuthStorage.create(),
788:       modelRegistry: ctx.modelRegistry,
789:       resourceLoader: loader,
790:     });
791: 
792:     try {
793:       let responseText = "";
794: 
795:       const unsub = session.subscribe((event) => {
796:         if (event.type === "message_end" && event.message.role === "assistant") {
797:           for (const part of event.message.content) {
798:             if (part.type === "text" && part.text) {
799:               responseText += part.text;
800:             }
801:           }
802:         }
803:       });
804: 
805:       await session.prompt(userMessage);
806:       unsub();
807: 
808:       return responseText || null;
809:     } finally {
810:       session.dispose();
811:     }
812:   } catch {
813:     return null;
814:   }
815: }
816: 
817: // ── Extension ──────────────────────────────────────────────────────
818: 
819: export default function (pi: ExtensionAPI) {
820:   let defaults = loadConfig();
821:   let session: VoiceSessionState = {};
822:   let currentCtx: ExtensionContext | undefined;
823:   let lastVoiceStatus = "idle";
824:   let sttStatus = "ready";
825:   let streamBuffer = "";
826:   let streamTail: Promise<void> = Promise.resolve();
827:   let streamJobCounter = 0;
828: 
829:   function getEffective(): FullVoiceConfig {
830:     return {
831:       enabled: session.enabled ?? defaults.enabled,
832:       voice: session.voice ?? defaults.voice,
833:       speed: session.speed ?? defaults.speed,
834:       backend: defaults.backend,
835:       host: defaults.host,
836:       port: defaults.port,
837:       remote: defaults.remote,
838:       stt: defaults.stt,
839:       events: defaults.events,
840:     };
841:   }
842: 
843:   function effectiveServerUrl(config: FullVoiceConfig): string {
844:     return config.backend === "remote" ? remoteConfig(config).baseUrl : `http://${config.host}:${config.port}`;
845:   }
846: 
847:   function compactUrl(value: string): string {
848:     return value.replace(/^https?:\/\//, "");
849:   }
850: 
851:   function setVoiceStatus(message: string): void {
852:     lastVoiceStatus = message;
853:     debugLog("status", { message });
854:     updateStatusBar();
855:   }
856: 
857:   function setSttStatus(message: string): void {
858:     sttStatus = message;
859:     debugLog("stt_status", { message });
860:     updateStatusBar();
861:   }
862: 
863:   function statusLine(config = getEffective()): string {
864:     const stt = sttConfig(config);
865:     const sttText = stt.enabled ? `stt ${sttStatus}` : "stt off";
866:     if (!config.enabled) return `voice: off | ${sttText}`;
867:     const target = config.backend === "remote"
868:       ? compactUrl(remoteConfig(config).baseUrl)
869:       : `${config.host}:${config.port}`;
870:     return `voice: ${config.backend} ${target} ${lastVoiceStatus} | ${sttText}`;
871:   }
872: 
873:   function persistSession() {
874:     pi.appendEntry<VoiceSessionState>("voice-session", { ...session });
875:   }
876: 
877:   function restoreSession(ctx: ExtensionContext) {
878:     const branch = ctx.sessionManager.getBranch();
879:     for (const entry of branch) {
880:       if (entry.type === "custom" && entry.customType === "voice-session") {
881:         const data = entry.data as VoiceSessionState | undefined;
882:         if (data) session = { ...data };
883:       }
884:     }
885:     defaults = loadConfig();
886:   }
887: 
888:   // ── Audio playback queue ────────────────────────────────────────
889: 
890:   // Serializes audio playback so tts tool and auto-TTS never overlap.
891:   type QueueItem = {
892:     play: () => Promise<unknown>;
893:     resolve: (value: unknown) => void;
894:     reject: (error: unknown) => void;
895:   };
896: 
897:   const audioQueue: QueueItem[] = [];
898:   let audioPlaying = false;
899:   let audioFileCounter = 0;
900:   let autoTTSTail: Promise<void> = Promise.resolve();
901:   let autoTTSJobCounter = 0;
902: 
903:   function drainAudioQueue(): void {
904:     if (audioPlaying) return;
905:     const item = audioQueue.shift();
906:     if (!item) return;
907:     audioPlaying = true;
908:     item
909:       .play()
910:       .then(item.resolve, item.reject)
911:       .finally(() => {
912:         audioPlaying = false;
913:         drainAudioQueue();
914:       });
915:   }
916: 
917:   function enqueueAudio<T>(play: () => Promise<T>): Promise<T> {
918:     return new Promise((resolve, reject) => {
919:       audioQueue.push({
920:         play,
921:         resolve: (value: unknown) => resolve(value as T),
922:         reject,
923:       });
924:       drainAudioQueue();
925:     });
926:   }
927: 
928:   function playSttCue(kind: "start" | "finish", config: SttRuntimeConfig): Promise<void> {
929:     if (!config.audioCues) return Promise.resolve();
930:     const cue = kind === "start" ? config.startCue : config.finishCue;
931:     if (process.platform === "darwin" && cue && existsSync(cue)) {
932:       return new Promise((resolve) => {
933:         const child = spawn("afplay", [cue], { stdio: "ignore" });
934:         child.on("error", () => resolve());
935:         child.on("close", () => resolve());
936:       });
937:     }
938:     try {
939:       process.stdout.write("\u0007");
940:     } catch {
941:       /* ignore */
942:     }
943:     return Promise.resolve();
944:   }
945: 
946:   function formatBytes(bytes: number | undefined): string {
947:     if (bytes === undefined) return "";
948:     if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
949:     return `${Math.round(bytes / (1024 * 1024))} MB`;
950:   }
951: 
952:   function progressText(progress: SttProgress | null): string {
953:     if (!progress) return "Preparing STT...";
954:     if (progress.phase === "downloading") {
955:       const pct = progress.percent === undefined ? "" : ` ${progress.percent}%`;
956:       const bytes = progress.bytesReceived === undefined
957:         ? ""
958:         : ` ${formatBytes(progress.bytesReceived)}${progress.totalBytes ? `/${formatBytes(progress.totalBytes)}` : ""}`;
959:       return `${progress.message}${pct}${bytes}`.trim();

(Showing lines 740-959 of 2121. Use offset=960 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts",
  "offset": 1130,
  "limit": 460
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts</path>
<type>file</type>
<content>
1130:           },
1131:         };
1132:       },
1133:       { overlay: true },
1134:     );
1135:   }
1136: 
1137:   // ── Speak + Auto-TTS (closured over pi) ─────────────────────
1138: 
1139:   async function responseError(res: Response): Promise<string> {
1140:     const text = await res.text();
1141:     debugLog("http_error_body", { status: res.status, body: textPreview(text) });
1142:     try {
1143:       const data = JSON.parse(text) as { error?: string; detail?: string };
1144:       return data.error ?? data.detail ?? `HTTP ${res.status}`;
1145:     } catch {
1146:       return text || `HTTP ${res.status}`;
1147:     }
1148:   }
1149: 
1150:   async function fetchTtsWav(text: string, config: FullVoiceConfig): Promise<Buffer> {
1151:     const remote = config.backend === "remote" ? remoteConfig(config) : null;
1152:     const url = remote
1153:       ? remoteUrl(config, remote.speechPath)
1154:       : `http://${config.host}:${config.port}/tts`;
1155:     const body = remote
1156:       ? {
1157:           model: "kokoro",
1158:           input: text,
1159:           voice: config.voice,
1160:           response_format: "wav",
1161:           speed: config.speed,
1162:         }
1163:       : {
1164:           text,
1165:           voice: config.voice,
1166:           speed: config.speed,
1167:         };
1168: 
1169:     debugLog("tts_wav_request", {
1170:       backend: config.backend,
1171:       url,
1172:       chars: text.length,
1173:       voice: config.voice,
1174:       speed: config.speed,
1175:       preview: textPreview(text),
1176:     });
1177:     const res = await fetch(url, {
1178:       method: "POST",
1179:       headers: remote ? remoteJsonHeaders(remote) : { "Content-Type": "application/json" },
1180:       body: JSON.stringify(body),
1181:     });
1182: 
1183:     debugLog("tts_wav_response", {
1184:       url,
1185:       status: res.status,
1186:       ok: res.ok,
1187:       contentType: res.headers.get("content-type"),
1188:       contentLength: res.headers.get("content-length"),
1189:     });
1190:     if (!res.ok) throw new Error(await responseError(res));
1191:     setVoiceStatus(`${config.backend} audio ready`);
1192:     const wav = Buffer.from(await res.arrayBuffer());
1193:     debugLog("tts_wav_buffer", { bytes: wav.length });
1194:     return wav;
1195:   }
1196: 
1197:   async function playWavBuffer(wavBuffer: Buffer): Promise<string | undefined> {
1198:     const outPath = join(
1199:       CONFIG_DIR,
1200:       `voice-${Date.now()}-${process.pid}-${++audioFileCounter}.wav`,
1201:     );
1202:     mkdirSync(CONFIG_DIR, { recursive: true });
1203:     writeFileSync(outPath, wavBuffer);
1204:     const playbackTimeout = wavPlaybackTimeoutMs(wavBuffer);
1205:     debugLog("wav_play_start", {
1206:       path: outPath,
1207:       bytes: wavBuffer.length,
1208:       timeoutMs: playbackTimeout,
1209:       command: process.platform === "darwin" ? "afplay" : "aplay",
1210:     });
1211: 
1212:     return await enqueueAudio(
1213:       () =>
1214:         new Promise<string | undefined>((resolve) => {
1215:           const cmd = process.platform === "darwin" ? "afplay" : "aplay";
1216:           execCb(`${cmd} "${outPath}"`, { timeout: playbackTimeout }, (err) => {
1217:             try {
1218:               unlinkSync(outPath);
1219:             } catch {
1220:               /* ignore */
1221:             }
1222:             debugLog("wav_play_end", { path: outPath, error: err?.message });
1223:             resolve(err?.message);
1224:           });
1225:         }),
1226:     );
1227:   }
1228: 
1229:   async function playRemotePcmStream(
1230:     speechText: string,
1231:     config: FullVoiceConfig,
1232:   ): Promise<string | undefined> {
1233:     const player = streamingPcmPlayer();
1234:     if (!player) throw new Error("No streaming PCM player found");
1235: 
1236:     const remote = remoteConfig(config);
1237:     const url = remoteUrl(config, remote.streamPath);
1238:     debugLog("pcm_stream_request", {
1239:       url,
1240:       chars: speechText.length,
1241:       voice: config.voice,
1242:       speed: config.speed,
1243:       playerCommand: player.command,
1244:       playerArgs: player.args,
1245:       preview: textPreview(speechText),
1246:     });
1247:     const res = await fetch(url, {
1248:       method: "POST",
1249:       headers: remoteJsonHeaders(remote),
1250:       body: JSON.stringify({
1251:         model: "kokoro",
1252:         input: speechText,
1253:         voice: config.voice,
1254:         response_format: "wav",
1255:         stream_format: "pcm",
1256:         speed: config.speed,
1257:       }),
1258:     });
1259: 
1260:     debugLog("pcm_stream_response", {
1261:       url,
1262:       status: res.status,
1263:       ok: res.ok,
1264:       contentType: res.headers.get("content-type"),
1265:       contentLength: res.headers.get("content-length"),
1266:       transferEncoding: res.headers.get("transfer-encoding"),
1267:     });
1268:     if (!res.ok) throw new Error(await responseError(res));
1269:     if (!res.body) throw new Error("Remote TTS stream response had no body");
1270:     setVoiceStatus("remote stream connected");
1271: 
1272:     return await enqueueAudio(
1273:       () =>
1274:         new Promise<string | undefined>((resolve) => {
1275:           const child = spawn(player.command, player.args, { stdio: ["pipe", "ignore", "pipe"] });
1276:           let error: string | undefined;
1277:           let bytes = 0;
1278:           debugLog("pcm_player_start", {
1279:             command: player.command,
1280:             args: player.args,
1281:             pid: child.pid,
1282:           });
1283: 
1284:           child.on("error", (err) => {
1285:             error = err.message;
1286:             debugLog("pcm_player_error", { error: err.message });
1287:           });
1288:           child.stdin.on("error", (err) => {
1289:             error = err.message;
1290:             debugLog("pcm_player_stdin_error", { error: err.message });
1291:           });
1292:           child.stderr.on("data", (chunk: Buffer) => {
1293:             const message = chunk.toString().trim();
1294:             if (message) {
1295:               error = message;
1296:               debugLog("pcm_player_stderr", { message: textPreview(message) });
1297:             }
1298:           });
1299:           child.on("close", (code) => {
1300:             debugLog("pcm_player_close", { code, error, bytes });
1301:             resolve(code === 0 ? undefined : (error ?? `${player.command} exited with code ${code}`));
1302:           });
1303: 
1304:           (async () => {
1305:             const reader = res.body?.getReader();
1306:             if (!reader) throw new Error("Remote TTS stream response had no reader");
1307:             try {
1308:               while (true) {
1309:                 const { done, value } = await reader.read();
1310:                 if (done) break;
1311:                 if (!value) continue;
1312:                 const buffer = Buffer.from(value);
1313:                 bytes += buffer.length;
1314:                 const canContinue = child.stdin.write(buffer);
1315:                 if (!canContinue) await new Promise((r) => child.stdin.once("drain", r));
1316:               }
1317:               child.stdin.end();
1318:               debugLog("pcm_stream_read_done", { bytes });
1319:             } catch (err) {
1320:               error = errorText(err);
1321:               debugLog("pcm_stream_read_error", { error, bytes });
1322:               child.stdin.destroy();
1323:               child.kill();
1324:             }
1325:           })();
1326:         }),
1327:     );
1328:   }
1329: 
1330:   async function synthesizeAndPlay(
1331:     speechText: string,
1332:     config: FullVoiceConfig,
1333:   ): Promise<string | undefined> {
1334:     if (config.backend !== "remote") {
1335:       return await playWavBuffer(await fetchTtsWav(speechText, config));
1336:     }
1337: 
1338:     const remote = remoteConfig(config);
1339:     if (remote.stream && remote.streamFormat === "pcm" && streamingPcmPlayer()) {
1340:       try {
1341:         return await playRemotePcmStream(speechText, config);
1342:       } catch (error) {
1343:         debugLog("remote_stream_fallback", { error: errorText(error) });
1344:         setVoiceStatus("remote stream failed; chunk fallback");
1345:       }
1346:     }
1347: 
1348:     const chunks = remote.chunkText ? splitSpeechText(speechText, remote.chunkMaxChars) : [speechText];
1349:     const playbacks: Array<Promise<string | undefined>> = [];
1350:     try {
1351:       for (let i = 0; i < chunks.length; i++) {
1352:         const chunk = chunks[i];
1353:         setVoiceStatus(`remote chunk ${i + 1}/${chunks.length}`);
1354:         const wavBuffer = await fetchTtsWav(chunk, config);
1355:         playbacks.push(playWavBuffer(wavBuffer));
1356:       }
1357:     } catch (error) {
1358:       debugLog("chunked_wav_error", { error: errorText(error), queuedPlaybacks: playbacks.length });
1359:       await Promise.allSettled(playbacks);
1360:       throw error;
1361:     }
1362:     const errors = await Promise.all(playbacks);
1363:     return errors.find(Boolean);
1364:   }
1365: 
1366:   // Queued speak — fetches TTS audio and enqueues it for sequential playback.
1367:   async function speak(
1368:     text: string,
1369:     config: FullVoiceConfig,
1370:     source: VoiceSpeakSource,
1371:   ): Promise<void> {
1372:     const speechText = prepareTextForSpeech(text);
1373:     if (!speechText) return;
1374: 
1375:     const startEvent: VoiceSpeakStartEvent = {
1376:       text: speechText,
1377:       voice: config.voice,
1378:       speed: config.speed,
1379:       source,
1380:     };
1381:     pi.events.emit("voice:speak_start", startEvent);
1382:     setVoiceStatus(`${config.backend} synth ${speechText.length} chars`);
1383:     debugLog("speak_start", {
1384:       source,
1385:       backend: config.backend,
1386:       chars: speechText.length,
1387:       voice: config.voice,
1388:       speed: config.speed,
1389:       preview: textPreview(speechText),
1390:     });
1391: 
1392:     try {
1393:       const playbackError = await synthesizeAndPlay(speechText, config);
1394:       const endEvent: VoiceSpeakEndEvent = {
1395:         text: speechText,
1396:         source,
1397:         ...(playbackError ? { error: playbackError } : {}),
1398:       };
1399:       pi.events.emit("voice:speak_end", endEvent);
1400:       debugLog("speak_end", { source, error: playbackError });
1401:       setVoiceStatus(playbackError ? "playback error" : "idle");
1402:     } catch (error) {
1403:       debugLog("speak_error", { source, error: errorText(error) });
1404:       setVoiceStatus("tts error");
1405:       const endEvent: VoiceSpeakEndEvent = {
1406:         text: speechText,
1407:         source,
1408:         error: error instanceof Error ? error.message : String(error),
1409:       };
1410:       pi.events.emit("voice:speak_end", endEvent);
1411:     }
1412:   }
1413: 
1414:   async function handleAutoTTS(
1415:     eventName: string,
1416:     // biome-ignore lint/suspicious/noExplicitAny: event shape varies by event type
1417:     event: any,
1418:     ctx: ExtensionContext,
1419:     config: FullVoiceConfig,
1420:     jobId: number,
1421:   ): Promise<void> {
1422:     try {
1423:       if (!config.enabled) return;
1424:       if (!config.events?.[eventName]) return;
1425:       if (eventName === "agent_end" && config.events.message_update) return;
1426:       // model is optional per-event — falls back to ctx.model
1427: 
1428:       const eventConfig = config.events[eventName];
1429: 
1430:       // Direct text — speak immediately, no LLM
1431:       if ("text" in eventConfig) {
1432:         const text = prepareTextForSpeech(eventConfig.text);
1433:         if (!text) return;
1434:         setVoiceStatus(`auto #${jobId} fixed ${eventName}`);
1435:         await speak(text, config, "auto");
1436:         return;
1437:       }
1438: 
1439:       // Extract configured event content. If a prompt is configured, summarize it via LLM.
1440:       // If no prompt is configured, speak the extracted content exactly as written.
1441:       const context = extractLastMessage(event, eventConfig.content ?? "text");
1442:       if (!context) return;
1443: 
1444:       if ("prompt" in eventConfig) {
1445:         setVoiceStatus(`auto #${jobId} summarizing ${eventName}`);
1446:         const generated = await generateSpeechText(
1447:           withCodeblockInstructions(eventConfig.prompt),
1448:           context,
1449:           ctx,
1450:           eventConfig.model,
1451:         );
1452:         const text = generated ? prepareTextForSpeech(generated) : null;
1453:         if (!text) return;
1454:         await speak(text, config, "auto");
1455:         return;
1456:       }
1457: 
1458:       if (containsFencedCodeBlock(context)) {
1459:         setVoiceStatus(`auto #${jobId} code summary ${eventName}`);
1460:         const generated = await generateSpeechText(CODEBLOCK_SPEECH_PROMPT, context, ctx);
1461:         const text = generated ? prepareTextForSpeech(generated) : prepareTextForSpeech(context);
1462:         if (!text) return;
1463:         await speak(text, config, "auto");
1464:         return;
1465:       }
1466: 
1467:       const text = prepareTextForSpeech(context);
1468:       if (!text) return;
1469:       setVoiceStatus(`auto #${jobId} speaking ${eventName}`);
1470:       await speak(text, config, "auto");
1471:     } catch (error) {
1472:       setVoiceStatus("auto error");
1473:     }
1474:   }
1475: 
1476:   function enqueueAutoTTS(
1477:     eventName: string,
1478:     // biome-ignore lint/suspicious/noExplicitAny: event shape varies by event type
1479:     event: any,
1480:     ctx: ExtensionContext,
1481:     config: FullVoiceConfig,
1482:   ): void {
1483:     const jobId = ++autoTTSJobCounter;
1484:     autoTTSTail = autoTTSTail
1485:       .then(() => {
1486:         if (eventName !== "message_end") return undefined;
1487:         flushStreamingAutoTTS(config, true);
1488:         return streamTail;
1489:       })
1490:       .then(() => handleAutoTTS(eventName, event, ctx, config, jobId))
1491:       .catch(() => {
1492:         setVoiceStatus(`auto #${jobId} queue error`);
1493:       });
1494:   }
1495: 
1496:   function nextStreamingChunk(force: boolean, maxChars: number): string | null {
1497:     const text = streamBuffer.trimStart();
1498:     streamBuffer = text;
1499:     if (!streamBuffer) return null;
1500: 
1501:     if (force) {
1502:       const chunk = streamBuffer;
1503:       streamBuffer = "";
1504:       return chunk;
1505:     }
1506: 
1507:     const minChunk = Math.min(120, Math.max(60, Math.floor(maxChars / 2)));
1508:     const punctuationMatches = [...streamBuffer.matchAll(/[.!?;:]\s+/g)];
1509:     const lastBoundary = punctuationMatches.at(-1);
1510:     if (lastBoundary?.index !== undefined) {
1511:       const end = lastBoundary.index + lastBoundary[0].length;
1512:       if (end >= minChunk) {
1513:         const chunk = streamBuffer.slice(0, end).trim();
1514:         streamBuffer = streamBuffer.slice(end).trimStart();
1515:         return chunk;
1516:       }
1517:     }
1518: 
1519:     if (streamBuffer.length < maxChars) return null;
1520:     const end = streamBuffer.lastIndexOf(" ", maxChars);
1521:     const cut = end >= minChunk ? end : maxChars;
1522:     const chunk = streamBuffer.slice(0, cut).trim();
1523:     streamBuffer = streamBuffer.slice(cut).trimStart();
1524:     return chunk;
1525:   }
1526: 
1527:   function flushStreamingAutoTTS(config: FullVoiceConfig, force = false): void {
1528:     const remote = remoteConfig(config);
1529:     const jobId = ++streamJobCounter;
1530:     const chunks: string[] = [];
1531:     while (true) {
1532:       const chunk = nextStreamingChunk(force, remote.chunkMaxChars);
1533:       if (!chunk) break;
1534:       chunks.push(chunk);
1535:       if (!force) break;
1536:     }
1537:     if (chunks.length === 0) return;
1538: 
1539:     streamTail = streamTail
1540:       .then(async () => {
1541:         for (const chunk of chunks) {
1542:           setVoiceStatus(`stream #${jobId} ${chunk.length} chars`);
1543:           await speak(chunk, config, "auto");
1544:         }
1545:       })
1546:       .catch(() => {
1547:         setVoiceStatus(`stream #${jobId} error`);
1548:       });
1549:   }
1550: 
1551:   function handleMessageUpdateTTS(
1552:     // biome-ignore lint/suspicious/noExplicitAny: event shape comes from pi runtime
1553:     event: any,
1554:     config: FullVoiceConfig,
1555:   ): void {
1556:     if (!config.enabled) return;
1557:     const eventConfig = config.events?.message_update;
1558:     if (!eventConfig || "prompt" in eventConfig || "text" in eventConfig) return;
1559: 
1560:     const mode = eventConfig.content ?? "text";
1561:     const update = event.assistantMessageEvent;
1562:     if ((mode === "text" || mode === "all") && update?.type === "text_delta") {
1563:       streamBuffer += update.delta;
1564:       flushStreamingAutoTTS(config);
1565:       return;
1566:     }
1567:     if ((mode === "thinking" || mode === "all") && update?.type === "thinking_delta") {
1568:       streamBuffer += update.delta;
1569:       flushStreamingAutoTTS(config);
1570:       return;
1571:     }
1572:     if (update?.type === "text_end" || update?.type === "thinking_end" || update?.type === "done") {
1573:       flushStreamingAutoTTS(config, true);
1574:     }
1575:   }
1576: 
1577:   // ── Server API helpers ─────────────────────────────────────────
1578: 
1579:   async function fetchHealth(config = getEffective()) {
1580:     try {
1581:       const remote = config.backend === "remote" ? remoteConfig(config) : null;
1582:       const res = await fetch(`${effectiveServerUrl(config)}/health`, {
1583:         headers: remote ? remoteAuthHeaders(remote) : undefined,
1584:       });
1585:       if (!res.ok) return null;
1586:       const data = (await res.json()) as Partial<{
1587:         status: string;
1588:         activeDtype: string | null;
1589:         modelLoaded: boolean;

(Showing lines 1130-1589 of 2121. Use offset=1590 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts",
  "offset": 1930,
  "limit": 210
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts</path>
<type>file</type>
<content>
1930:             return [
1931:               theme.bold("pi-voice debug log"),
1932:               DEBUG_LOG_PATH,
1933:               "",
1934:               ...(lines.length ? lines : [theme.fg("dim", "No log entries yet.")]),
1935:               "",
1936:               theme.fg("dim", "esc/enter closes"),
1937:             ];
1938:           },
1939:           invalidate() {},
1940:           handleInput(data: string) {
1941:             if (matchesKey(data, "escape") || matchesKey(data, "enter")) done(undefined);
1942:           },
1943:         }),
1944:         { overlay: true },
1945:       );
1946:     },
1947:   });
1948: 
1949:   pi.registerCommand("dictate", {
1950:     description: "Dictate a prompt with local speech-to-text, then paste it into the editor",
1951:     handler: async (_args, ctx) => {
1952:       await runDictation(ctx);
1953:     },
1954:   });
1955: 
1956:   // ── tts tool ─────────────────────────────────────────────────
1957: 
1958:   pi.registerTool({
1959:     name: "tts",
1960:     label: "Text to Speech",
1961:     description:
1962:       "Convert text to speech audio using the Kokoro TTS server. Saves a WAV file and plays it.",
1963:     promptSnippet: "Convert text to speech and play audio",
1964:     promptGuidelines: [
1965:       "Use tts when the user wants to hear text spoken aloud or convert text to audio.",
1966:     ],
1967:     parameters: Type.Object({
1968:       text: Type.String({ description: "Text to convert to speech" }),
1969:       voice: Type.Optional(
1970:         Type.String({ description: "Voice name (defaults to configured voice)" }),
1971:       ),
1972:       speed: Type.Optional(
1973:         Type.Number({
1974:           description: "Speech speed 0.5-3.0 (defaults to configured speed)",
1975:           minimum: 0.5,
1976:           maximum: 3.0,
1977:         }),
1978:       ),
1979:     }),
1980:     async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
1981:       const effective = getEffective();
1982: 
1983:       if (!effective.enabled) {
1984:         return {
1985:           content: [
1986:             {
1987:               type: "text" as const,
1988:               text: "TTS is currently disabled. Use /voice to enable it.",
1989:             },
1990:           ],
1991:           details: {},
1992:         };
1993:       }
1994: 
1995:       const ttsParams = params as { text: string; voice?: string; speed?: number };
1996:       const voice = ttsParams.voice ?? effective.voice;
1997:       const speed = ttsParams.speed ?? effective.speed;
1998:       const speechText = prepareTextForSpeech(ttsParams.text);
1999: 
2000:       if (!speechText) {
2001:         return {
2002:           content: [{ type: "text" as const, text: "No speakable text was provided." }],
2003:           details: {},
2004:         };
2005:       }
2006: 
2007:       speak(speechText, { ...effective, voice, speed }, "tool").catch(() => {
2008:         /* errors already logged inside speak */
2009:       });
2010: 
2011:       const preview = speechText.length > 80 ? `${speechText.slice(0, 80)}…` : speechText;
2012:       return {
2013:         content: [{ type: "text" as const, text: `Speaking: "${preview}"` }],
2014:         details: {},
2015:       };
2016:     },
2017:   });
2018: 
2019:   // ── Status bar ────────────────────────────────────────────────
2020: 
2021:   function updateStatusBar() {
2022:     if (!currentCtx) return;
2023:     const effective = getEffective();
2024:     const theme = currentCtx.ui.theme;
2025:     const color = effective.enabled ? "success" : "dim";
2026:     currentCtx.ui.setStatus("pi-voice", theme.fg(color, statusLine(effective)));
2027:   }
2028: 
2029:   // ── Session lifecycle ──────────────────────────────────────────
2030: 
2031:   pi.on("session_start", async (_event, ctx) => {
2032:     currentCtx = ctx;
2033:     restoreSession(ctx);
2034:     updateStatusBar();
2035:   });
2036: 
2037:   pi.on("session_tree", async (_event, ctx) => {
2038:     currentCtx = ctx;
2039:     restoreSession(ctx);
2040:     updateStatusBar();
2041:   });
2042: 
2043:   // Update status bar on voice:config events (from TUI, alt+v, etc.)
2044:   pi.events.on("voice:config", () => {
2045:     updateStatusBar();
2046:   });
2047: 
2048:   // ── Global toggle shortcut (alt+v) ────────────────────────────
2049: 
2050:   pi.registerShortcut("alt+v", {
2051:     description: "Toggle TTS on/off",
2052:     handler: async (ctx) => {
2053:       const effective = getEffective();
2054:       const next = !effective.enabled;
2055:       session.enabled = next;
2056:       persistSession();
2057:       ctx.ui.notify(`TTS ${next ? "enabled" : "disabled"}`, "info");
2058:       pi.events.emit("voice:config", {
2059:         enabled: next,
2060:         voice: effective.voice,
2061:         speed: effective.speed,
2062:       });
2063:     },
2064:   });
2065: 
2066:   // ── Auto-TTS event handlers ─────────────────────────────────────
2067: 
2068:   // Built-in pi events that carry message data.
2069:   // Each handler checks at runtime if the event is configured.
2070:   // Note: pi.on() requires literal event names (not variables) for type safety.
2071: 
2072:   pi.on("agent_end", async (event, ctx) => {
2073:     const effective = getEffective();
2074:     enqueueAutoTTS("agent_end", event, ctx, effective);
2075:   });
2076: 
2077:   pi.on("turn_end", async (event, ctx) => {
2078:     const effective = getEffective();
2079:     enqueueAutoTTS("turn_end", event, ctx, effective);
2080:   });
2081: 
2082:   pi.on("message_end", async (event, ctx) => {
2083:     const effective = getEffective();
2084:     enqueueAutoTTS("message_end", event, ctx, effective);
2085:   });
2086: 
2087:   pi.on("message_update", async (event) => {
2088:     const effective = getEffective();
2089:     handleMessageUpdateTTS(event, effective);
2090:   });
2091: 
2092:   const builtinEventNames = new Set(["agent_end", "turn_end", "message_end", "message_update"]);
2093: 
2094:   // Custom events from other extensions (via shared event bus).
2095:   // Any event name in config that isn't a built-in pi event is treated
2096:   // as a custom event. If the event config has a `text` field, it's
2097:   // spoken directly without LLM summarization.
2098: 
2099:   const customUnsubs: Array<() => void> = [];
2100: 
2101:   function registerCustomEvents() {
2102:     // Remove previous listeners
2103:     for (const unsub of customUnsubs) unsub();
2104:     customUnsubs.length = 0;
2105: 
2106:     const events = defaults.events;
2107:     if (!events) return;
2108: 
2109:     for (const eventName of Object.keys(events)) {
2110:       if (builtinEventNames.has(eventName)) continue;
2111:       const unsub = pi.events.on(eventName, (data: unknown) => {
2112:         if (!currentCtx) return;
2113:         const effective = getEffective();
2114:         enqueueAutoTTS(eventName, data, currentCtx, effective);
2115:       });
2116:       customUnsubs.push(unsub);
2117:     }
2118:   }
2119: 
2120:   registerCustomEvents();
2121: }

(End of file - total 2121 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json"
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/config/voice-config.example.json</path>
<type>file</type>
<content>
1: {
2:   "enabled": true,
3:   "backend": "local",
4:   "voice": "af_heart",
5:   "speed": 1.0,
6:   "host": "127.0.0.1",
7:   "port": 8181,
8:   "defaultModel": "q8",
9:   "remote": {
10:     "baseUrl": "https://tts.example.com",
11:     "authToken": "",
12:     "speechPath": "/v1/audio/speech",
13:     "streamPath": "/v1/audio/speech/stream",
14:     "stream": true,
15:     "streamFormat": "pcm",
16:     "chunkText": true,
17:     "chunkMaxChars": 240
18:   },
19:   "stt": {
20:     "enabled": true,
21:     "mode": "local",
22:     "language": "en",
23:     "audioCues": true
24:   },
25:   "events": {
26:     "message_update": {
27:       "content": "thinking"
28:     },
29:     "message_end": {
30:       "content": "text"
31:     }
32:   }
33: }

(End of file - total 33 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts",
  "offset": 1,
  "limit": 150
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts</path>
<type>file</type>
<content>
1: /**
2:  * Unit tests for the pi-voice event system (PRD.md).
3:  *
4:  * Tests that the extension emits events on pi.events.emit() per spec:
5:  *   - voice:config       — on any settings change (TUI toggle, voice, speed, reset, alt+v)
6:  *   - voice:speak_start  — before TTS synthesis
7:  *   - voice:speak_end    — after playback (success or error)
8:  *
9:  * The extension exports a default factory function(pi). We mock the full
10:  * pi API, call through the factory, then trigger actions via the captured
11:  * registrations.
12:  *
13:  * Note: Each mock pi has its own _emitted array to prevent cross-test
14:  * leakage from fire-and-forget speak() callbacks still running from
15:  * previous tests.
16:  */
17: 
18: import assert from "node:assert/strict";
19: import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
20: import { homedir } from "node:os";
21: import { resolve } from "node:path";
22: import { afterEach, beforeEach, describe, it } from "node:test";
23: import extensionFactory, {
24:   containsFencedCodeBlock,
25:   prepareTextForSpeech,
26: } from "./index.ts";
27: 
28: // ── Constants ──────────────────────────────────────────────────────
29: 
30: const CONFIG_DIR = resolve(homedir(), ".pi", "voice");
31: const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
32: const KEY_ESCAPE = "\x1b";
33: const KEY_ENTER = "\r";
34: const KEY_LEFT = "\x1b[D";
35: const KEY_RIGHT = "\x1b[C";
36: const _KEY_UP = "\x1b[A";
37: const KEY_DOWN = "\x1b[B";
38: const KEY_R = "r";
39: 
40: /** Wait time for afplay to start, play, and callback to fire (~850ms observed). */
41: const PLAYBACK_SETTLE = 1200;
42: 
43: // ── Types (mirror PRD interfaces for assertions) ───────────────────
44: 
45: interface VoiceConfigEvent {
46:   enabled: boolean;
47:   voice: string;
48:   speed: number;
49: }
50: 
51: type VoiceSpeakSource = "tool" | "auto" | "sample";
52: 
53: interface VoiceSpeakStartEvent {
54:   text: string;
55:   voice: string;
56:   speed: number;
57:   source: VoiceSpeakSource;
58: }
59: 
60: interface VoiceSpeakEndEvent {
61:   text: string;
62:   source: VoiceSpeakSource;
63:   error?: string;
64: }
65: 
66: // ── Config backup / restore ────────────────────────────────────────
67: 
68: let configBackup: string | null = null;
69: 
70: function backupConfig() {
71:   try {
72:     if (existsSync(CONFIG_PATH)) {
73:       configBackup = readFileSync(CONFIG_PATH, "utf-8");
74:     } else {
75:       configBackup = null;
76:     }
77:   } catch {
78:     configBackup = null;
79:   }
80: }
81: 
82: function restoreConfig() {
83:   try {
84:     if (configBackup !== null) {
85:       writeFileSync(CONFIG_PATH, configBackup);
86:     } else {
87:       try {
88:         unlinkSync(CONFIG_PATH);
89:       } catch {
90:         /* already gone */
91:       }
92:     }
93:   } catch {
94:     /* best effort */
95:   }
96: }
97: 
98: /** Write a clean test config without event model (avoids real model lookup). */
99: function writeTestConfig(overrides: Record<string, unknown> = {}) {
100:   writeFileSync(
101:     CONFIG_PATH,
102:     JSON.stringify(
103:       {
104:         enabled: true,
105:         voice: "af_heart",
106:         speed: 1.0,
107:         events: {
108:           agent_end: { prompt: "Summarize in one sentence." },
109:         },
110:         ...overrides,
111:       },
112:       null,
113:       2,
114:     ),
115:   );
116: }
117: 
118: // ── Valid WAV buffer ───────────────────────────────────────────────
119: 
120: /** Minimal valid WAV that afplay/aplay can play (1 sample of silence at 44100Hz). */
121: function createValidWav(): ArrayBuffer {
122:   const buf = new ArrayBuffer(46);
123:   const v = new DataView(buf);
124:   // RIFF header
125:   v.setUint32(0, 0x52494646, false); // "RIFF"
126:   v.setUint32(4, 38, true); // file size - 8
127:   v.setUint32(8, 0x57415645, false); // "WAVE"
128:   // fmt chunk
129:   v.setUint32(12, 0x666d7420, false); // "fmt "
130:   v.setUint32(16, 16, true); // chunk size
131:   v.setUint16(20, 1, true); // PCM
132:   v.setUint16(22, 1, true); // mono
133:   v.setUint32(24, 44100, true); // sample rate
134:   v.setUint32(28, 88200, true); // byte rate
135:   v.setUint16(32, 2, true); // block align
136:   v.setUint16(34, 16, true); // bits per sample
137:   // data chunk
138:   v.setUint32(36, 0x64617461, false); // "data"
139:   v.setUint32(40, 2, true); // data size
140:   v.setInt16(44, 0, true); // silence
141:   return buf;
142: }
143: 
144: function headerValue(headers: HeadersInit | undefined, name: string): string | null {
145:   if (!headers) return null;
146:   if (headers instanceof Headers) return headers.get(name);
147:   const lowerName = name.toLowerCase();
148:   if (Array.isArray(headers)) {
149:     return headers.find(([key]) => key.toLowerCase() === lowerName)?.[1] ?? null;
150:   }

(Showing lines 1-150 of 921. Use offset=151 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts",
  "offset": 700,
  "limit": 240
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts</path>
<type>file</type>
<content>
700:       // biome-ignore lint/suspicious/noExplicitAny: mock fetch accepts any input
701:       globalThis.fetch = (async (input: any, init?: RequestInit) => {
702:         const url = typeof input === "string" ? input : input.url;
703:         if (url.endsWith("/v1/audio/speech")) {
704:           requests.push({ url, headers: init?.headers });
705:           return new Response(createValidWav(), {
706:             status: 200,
707:             headers: { "Content-Type": "audio/wav" },
708:           });
709:         }
710:         return new Response(JSON.stringify({ status: "ok" }), {
711:           status: 200,
712:           headers: { "Content-Type": "application/json" },
713:         });
714:       }) as typeof fetch;
715: 
716:       const pi = createMockPi();
717:       // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
718:       extensionFactory(pi as any);
719: 
720:       await tools.tts.execute("tc_1", { text: "Remote auth works" }, undefined, undefined, createMockCtx());
721:       await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));
722: 
723:       assert.equal(requests.length, 1);
724:       assert.equal(requests[0].url, "http://remote.test:8880/v1/audio/speech");
725:       assert.equal(headerValue(requests[0].headers, "authorization"), "Bearer test-token");
726:     });
727:   });
728: 
729:   // ── source field ───────────────────────────────────────────────
730: 
731:   describe("source field", () => {
732:     it('"tool" from tts tool', async () => {
733:       const pi = createMockPi();
734:       // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
735:       extensionFactory(pi as any);
736: 
737:       await tools.tts.execute("tc_1", { text: "Src" }, undefined, undefined, createMockCtx());
738:       await new Promise((r) => setTimeout(r, 50));
739: 
740:       const events = getEvents(pi, "voice:speak_start");
741:       if (events.length > 0) {
742:         assert.equal((events[0].data as VoiceSpeakStartEvent).source, "tool");
743:       }
744:     });
745: 
746:     it('"sample" from TUI playSampleTts', async () => {
747:       const pi = createMockPi();
748:       // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
749:       extensionFactory(pi as any);
750: 
751:       const handlerPromise = commands.voice.handler([], createMockCtx());
752:       await new Promise((r) => setTimeout(r, 10));
753:       assert.ok(tuiComponent);
754: 
755:       tuiComponent.handleInput(KEY_ENTER);
756:       await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));
757: 
758:       const events = getEvents(pi, "voice:speak_start");
759:       if (events.length > 0) {
760:         assert.equal((events[0].data as VoiceSpeakStartEvent).source, "sample");
761:       }
762: 
763:       tuiComponent.handleInput(KEY_ESCAPE);
764:       await handlerPromise;
765:     });
766:   });
767: 
768:   // ── paired lifecycle ───────────────────────────────────────────
769: 
770:   describe("speak_start / speak_end pairing", () => {
771:     it("every speak_start has a corresponding speak_end", async () => {
772:       const pi = createMockPi();
773:       // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
774:       extensionFactory(pi as any);
775: 
776:       await tools.tts.execute("tc_1", { text: "Pair" }, undefined, undefined, createMockCtx());
777:       await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));
778: 
779:       const starts = getEvents(pi, "voice:speak_start").length;
780:       const ends = getEvents(pi, "voice:speak_end").length;
781:       assert.equal(ends, starts, "speak_end count should match speak_start count");
782:     });
783:   });
784: 
785:   describe("auto-TTS ordering", () => {
786:     it("speaks streaming thinking before message_end final text", async () => {
787:       writeTestConfig({
788:         events: {
789:           message_update: { content: "thinking" },
790:           message_end: { content: "text" },
791:         },
792:       });
793: 
794:       const pi = createMockPi();
795:       // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
796:       extensionFactory(pi as any);
797: 
798:       const updateHandler = piEventHandlers.message_update;
799:       const endHandler = piEventHandlers.message_end;
800:       assert.ok(updateHandler, "message_update handler should be registered");
801:       assert.ok(endHandler, "message_end handler should be registered");
802: 
803:       await updateHandler({ assistantMessageEvent: { type: "thinking_delta", delta: "Reasoning first." } });
804:       await updateHandler({ assistantMessageEvent: { type: "thinking_end" } });
805:       await endHandler(
806:         {
807:           message: {
808:             role: "assistant",
809:             content: [{ type: "text", text: "Final answer last." }],
810:           },
811:         },
812:         createMockCtx(),
813:       );
814:       await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE * 2));
815: 
816:       const starts = getEvents(pi, "voice:speak_start").map(
817:         (event) => (event.data as VoiceSpeakStartEvent).text,
818:       );
819:       assert.deepEqual(starts, ["Reasoning first.", "Final answer last."]);
820:     });
821:   });
822: 
823:   // ── auto-TTS (no model available) ──────────────────────────────
824: 
825:   describe("auto-TTS without model", () => {
826:     it("does not emit speak events when no model is available", async () => {
827:       const pi = createMockPi();
828:       // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
829:       extensionFactory(pi as any);
830: 
831:       const handler = piEventHandlers.agent_end;
832:       assert.ok(handler, "agent_end handler should be registered");
833: 
834:       await handler(
835:         {
836:           messages: [
837:             {
838:               role: "assistant",
839:               content: [{ type: "text", text: "No model test" }],
840:             },
841:           ],
842:         },
843:         createMockCtx(),
844:       );
845:       await new Promise((r) => setTimeout(r, 50));
846: 
847:       assert.equal(
848:         getEvents(pi, "voice:speak_start").length,
849:         0,
850:         "Should not emit speak_start without a model",
851:       );
852:       assert.equal(
853:         getEvents(pi, "voice:speak_end").length,
854:         0,
855:         "Should not emit speak_end without a model",
856:       );
857:     });
858: 
859:     it("does not emit speak events when TTS is disabled", async () => {
860:       writeTestConfig({ enabled: false });
861:       const pi = createMockPi();
862:       // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
863:       extensionFactory(pi as any);
864: 
865:       const handler = piEventHandlers.agent_end;
866:       assert.ok(handler);
867: 
868:       await handler(
869:         {
870:           messages: [
871:             {
872:               role: "assistant",
873:               content: [{ type: "text", text: "Disabled test" }],
874:             },
875:           ],
876:         },
877:         createMockCtx(),
878:       );
879:       await new Promise((r) => setTimeout(r, 50));
880: 
881:       assert.equal(getEvents(pi, "voice:speak_start").length, 0);
882:     });
883:   });
884: 
885:   // ── text preparation ────────────────────────────────────────────
886: 
887:   describe("text preparation", () => {
888:     it("removes common markdown formatting characters", () => {
889:       assert.equal(
890:         prepareTextForSpeech("# Title\n\n***note*** Run `npm test` before [shipping](url)."),
891:         "Title\n\nnote Run npm test before shipping.",
892:       );
893:     });
894: 
895:     it("replaces fenced code blocks with a spoken description", () => {
896:       const prepared = prepareTextForSpeech(`Here is the fix:
897: 
898: \`\`\`ts
899: function add(a: number, b: number) {
900:   return a + b;
901: }
902: \`\`\`
903: 
904: Then run tests.`);
905: 
906:       assert.match(prepared, /TypeScript code block with 3 non empty lines/);
907:       assert.doesNotMatch(prepared, /```/);
908:       assert.doesNotMatch(prepared, /return a \+ b/);
909:     });
910: 
911:     it("detects fenced code blocks", () => {
912:       assert.equal(containsFencedCodeBlock("```ts\nconst x = 1;\n```"), true);
913:       assert.equal(containsFencedCodeBlock("No code fences here."), false);
914:     });
915: 
916:     it("handles unterminated fenced code blocks without throwing", () => {
917:       const prepared = prepareTextForSpeech("```bash\nnpm test");
918:       assert.match(prepared, /shell code block with 1 non empty lines/);
919:     });
920:   });
921: });

(End of file - total 921 lines)
</content>
```

---

## Assistant (Plan · GPT-5.6 Sol · 24.4s)

_Thinking:_

**Exploring config and git history**

_Thinking:_

**Designing speech scheduler and queue config**

_Thinking:_

**Defining TTS queue interruption options**

_Thinking:_

**Designing user interrupt behavior**

_Thinking:_

**Evaluating input event handling options**

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts",
  "offset": 500,
  "limit": 135
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts</path>
<type>file</type>
<content>
500:     type: "before_agent_start";
501:     /** The raw user prompt text (after expansion). */
502:     prompt: string;
503:     /** Images attached to the user prompt, if any. */
504:     images?: ImageContent[];
505:     /** The fully assembled system prompt string. */
506:     systemPrompt: string;
507:     /** Structured options used to build the system prompt. Extensions can inspect this to understand what Pi loaded without re-discovering resources. */
508:     systemPromptOptions: BuildSystemPromptOptions;
509: }
510: /** Fired when an agent loop starts */
511: export interface AgentStartEvent {
512:     type: "agent_start";
513: }
514: /** Fired when an agent loop ends */
515: export interface AgentEndEvent {
516:     type: "agent_end";
517:     messages: AgentMessage[];
518: }
519: /** Fired at the start of each turn */
520: export interface TurnStartEvent {
521:     type: "turn_start";
522:     turnIndex: number;
523:     timestamp: number;
524: }
525: /** Fired at the end of each turn */
526: export interface TurnEndEvent {
527:     type: "turn_end";
528:     turnIndex: number;
529:     message: AgentMessage;
530:     toolResults: ToolResultMessage[];
531: }
532: /** Fired when a message starts (user, assistant, or toolResult) */
533: export interface MessageStartEvent {
534:     type: "message_start";
535:     message: AgentMessage;
536: }
537: /** Fired during assistant message streaming with token-by-token updates */
538: export interface MessageUpdateEvent {
539:     type: "message_update";
540:     message: AgentMessage;
541:     assistantMessageEvent: AssistantMessageEvent;
542: }
543: /** Fired when a message ends */
544: export interface MessageEndEvent {
545:     type: "message_end";
546:     message: AgentMessage;
547: }
548: /** Fired when a tool starts executing */
549: export interface ToolExecutionStartEvent {
550:     type: "tool_execution_start";
551:     toolCallId: string;
552:     toolName: string;
553:     args: any;
554: }
555: /** Fired during tool execution with partial/streaming output */
556: export interface ToolExecutionUpdateEvent {
557:     type: "tool_execution_update";
558:     toolCallId: string;
559:     toolName: string;
560:     args: any;
561:     partialResult: any;
562: }
563: /** Fired when a tool finishes executing */
564: export interface ToolExecutionEndEvent {
565:     type: "tool_execution_end";
566:     toolCallId: string;
567:     toolName: string;
568:     result: any;
569:     isError: boolean;
570: }
571: export type ModelSelectSource = "set" | "cycle" | "restore";
572: /** Fired when a new model is selected */
573: export interface ModelSelectEvent {
574:     type: "model_select";
575:     model: Model<any>;
576:     previousModel: Model<any> | undefined;
577:     source: ModelSelectSource;
578: }
579: /** Fired when a new thinking level is selected */
580: export interface ThinkingLevelSelectEvent {
581:     type: "thinking_level_select";
582:     level: ThinkingLevel;
583:     previousLevel: ThinkingLevel;
584: }
585: /** Fired when user executes a bash command via ! or !! prefix */
586: export interface UserBashEvent {
587:     type: "user_bash";
588:     /** The command to execute */
589:     command: string;
590:     /** True if !! prefix was used (excluded from LLM context) */
591:     excludeFromContext: boolean;
592:     /** Current working directory */
593:     cwd: string;
594: }
595: /** Source of user input */
596: export type InputSource = "interactive" | "rpc" | "extension";
597: /** Fired when user input is received, before agent processing */
598: export interface InputEvent {
599:     type: "input";
600:     /** The input text */
601:     text: string;
602:     /** Attached images, if any */
603:     images?: ImageContent[];
604:     /** Where the input came from */
605:     source: InputSource;
606:     /** How the input will be delivered during streaming, or undefined when idle */
607:     streamingBehavior?: "steer" | "followUp";
608: }
609: /** Result from input event handler */
610: export type InputEventResult = {
611:     action: "continue";
612: } | {
613:     action: "transform";
614:     text: string;
615:     images?: ImageContent[];
616: } | {
617:     action: "handled";
618: };
619: interface ToolCallEventBase {
620:     type: "tool_call";
621:     toolCallId: string;
622: }
623: export interface BashToolCallEvent extends ToolCallEventBase {
624:     toolName: "bash";
625:     input: BashToolInput;
626: }
627: export interface ReadToolCallEvent extends ToolCallEventBase {
628:     toolName: "read";
629:     input: ReadToolInput;
630: }
631: export interface EditToolCallEvent extends ToolCallEventBase {
632:     toolName: "edit";
633:     input: EditToolInput;
634: }

(Showing lines 500-634 of 1209. Use offset=635 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md",
  "offset": 260,
  "limit": 105
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md</path>
<type>file</type>
<content>
260:   "dependencies": {
261:     "zod": "^3.0.0",
262:     "chalk": "^5.0.0"
263:   },
264:   "pi": {
265:     "extensions": ["./src/index.ts"]
266:   }
267: }
268: ```
269: 
270: Run `npm install` in the extension directory, then imports from `node_modules/` work automatically.
271: 
272: ## Events
273: 
274: ### Lifecycle Overview
275: 
276: ```
277: pi starts
278:   │
279:   ├─► project_trust (user/global and CLI extensions only, before project resources load)
280:   ├─► session_start { reason: "startup" }
281:   └─► resources_discover { reason: "startup" }
282:       │
283:       ▼
284: user sends prompt ─────────────────────────────────────────┐
285:   │                                                        │
286:   ├─► (extension commands checked first, bypass if found)  │
287:   ├─► input (can intercept, transform, or handle)          │
288:   ├─► (skill/template expansion if not handled)            │
289:   ├─► before_agent_start (can inject message, modify system prompt)
290:   ├─► agent_start                                          │
291:   ├─► message_start / message_update / message_end         │
292:   │                                                        │
293:   │   ┌─── turn (repeats while LLM calls tools) ───┐       │
294:   │   │                                            │       │
295:   │   ├─► turn_start                               │       │
296:   │   ├─► context (can modify messages)            │       │
297:   │   ├─► before_provider_request (can inspect or replace payload)
298:   │   ├─► after_provider_response (status + headers, before stream consume)
299:   │   │                                            │       │
300:   │   │   LLM responds, may call tools:            │       │
301:   │   │     ├─► tool_execution_start               │       │
302:   │   │     ├─► tool_call (can block)              │       │
303:   │   │     ├─► tool_execution_update              │       │
304:   │   │     ├─► tool_result (can modify)           │       │
305:   │   │     └─► tool_execution_end                 │       │
306:   │   │                                            │       │
307:   │   └─► turn_end                                 │       │
308:   │                                                        │
309:   └─► agent_end                                            │
310:                                                            │
311: user sends another prompt ◄────────────────────────────────┘
312: 
313: /new (new session) or /resume (switch session)
314:   ├─► session_before_switch (can cancel)
315:   ├─► session_shutdown
316:   ├─► session_start { reason: "new" | "resume", previousSessionFile? }
317:   └─► resources_discover { reason: "startup" }
318: 
319: /fork or /clone
320:   ├─► session_before_fork (can cancel)
321:   ├─► session_shutdown
322:   ├─► session_start { reason: "fork", previousSessionFile }
323:   └─► resources_discover { reason: "startup" }
324: 
325: /compact or auto-compaction
326:   ├─► session_before_compact (can cancel or customize)
327:   └─► session_compact
328: 
329: /tree navigation
330:   ├─► session_before_tree (can cancel or customize)
331:   └─► session_tree
332: 
333: /model or Ctrl+P (model selection/cycling)
334:   ├─► thinking_level_select (if model change changes/clamps thinking level)
335:   └─► model_select
336: 
337: thinking level changes (settings, keybinding, pi.setThinkingLevel())
338:   └─► thinking_level_select
339: 
340: exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)
341:   └─► session_shutdown
342: ```
343: 
344: ### Startup Events
345: 
346: #### project_trust
347: 
348: Fired before pi decides whether to trust a project with dynamic configs (`.pi` or `.agents/skills`). It runs during startup and when session replacement (for example `/resume`) enters a cwd whose trust has not been resolved in the current process. Only user/global extensions and CLI `-e` extensions participate; project-local extensions are not loaded until after trust is resolved.
349: 
350: ```typescript
351: pi.on("project_trust", async (event, ctx) => {
352:   // event.cwd - current working directory
353:   // ctx has a limited trust context: cwd, mode, hasUI, and select/confirm/input/notify UI helpers
354:   if (await ctx.ui.confirm("Trust project?", event.cwd)) {
355:     return { trusted: "yes", remember: true };
356:   }
357:   return { trusted: "undecided" };
358: });
359: ```
360: 
361: A `project_trust` handler must return `{ trusted: "yes" | "no" | "undecided" }`. A user/global or CLI extension that returns `"yes"` or `"no"` owns the decision; the first yes/no decision wins and suppresses the built-in trust prompt. Use `remember: true` to persist a yes/no decision; otherwise it applies only to the current process. Return `"undecided"` to let later handlers or the built-in trust flow decide. Check `ctx.hasUI` before prompting. If no handler returns yes/no, normal trust resolution continues: saved `trust.json` decisions apply first, then `defaultProjectTrust` controls whether pi asks, trusts, or declines by default.
362: 
363: ### Resource Events
364: 

(Showing lines 260-364 of 2681. Use offset=365 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md",
  "offset": 530,
  "limit": 55
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md</path>
<type>file</type>
<content>
530: The `systemPromptOptions` field gives extensions access to the same structured data Pi uses to build the system prompt. This lets you inspect what Pi has loaded — custom prompts, guidelines, tool snippets, context files, skills — without re-discovering resources or re-parsing flags. Use it when your extension needs to make deep, informed changes to the system prompt while respecting user-provided configuration.
531: 
532: Inside `before_agent_start`, `event.systemPrompt` and `ctx.getSystemPrompt()` both reflect the chained system prompt as of the current handler. Later `before_agent_start` handlers can still modify it again.
533: 
534: #### agent_start / agent_end
535: 
536: Fired once per user prompt.
537: 
538: ```typescript
539: pi.on("agent_start", async (_event, ctx) => {});
540: 
541: pi.on("agent_end", async (event, ctx) => {
542:   // event.messages - messages from this prompt
543: });
544: ```
545: 
546: #### turn_start / turn_end
547: 
548: Fired for each turn (one LLM response + tool calls).
549: 
550: ```typescript
551: pi.on("turn_start", async (event, ctx) => {
552:   // event.turnIndex, event.timestamp
553: });
554: 
555: pi.on("turn_end", async (event, ctx) => {
556:   // event.turnIndex, event.message, event.toolResults
557: });
558: ```
559: 
560: #### message_start / message_update / message_end
561: 
562: Fired for message lifecycle updates.
563: 
564: - `message_start` and `message_end` fire for user, assistant, and toolResult messages.
565: - `message_update` fires for assistant streaming updates.
566: - `message_end` handlers can return `{ message }` to replace the finalized message. The replacement must keep the same `role`.
567: 
568: ```typescript
569: pi.on("message_start", async (event, ctx) => {
570:   // event.message
571: });
572: 
573: pi.on("message_update", async (event, ctx) => {
574:   // event.message
575:   // event.assistantMessageEvent (token-by-token stream event)
576: });
577: 
578: pi.on("message_end", async (event, ctx) => {
579:   if (event.message.role !== "assistant") return;
580: 
581:   return {
582:     message: {
583:       ...event.message,
584:       usage: {

(Showing lines 530-584 of 2681. Use offset=585 to continue.)
</content>
```

**Tool: grep**

**Input:**
```json
{
  "pattern": "interface InputEvent|type InputEvent|InputEventResult|inputType",
  "path": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist",
  "include": "*.d.ts"
}
```

**Output:**
```
Found 7 matches
/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:
  Line 7: export type { AgentEndEvent, AgentStartEvent, AgentToolResult, AgentToolUpdateCallback, AppKeybinding, AutocompleteProviderFactory, BashToolCallEvent, BeforeAgentStartEvent, BeforeAgentStartEventResult, BeforeProviderRequestEvent, BeforeProviderRequestEventResult, BuildSystemPromptOptions, CompactOptions, ContextEvent, ContextUsage, CustomToolCallEvent, EditToolCallEvent, ExecOptions, ExecResult, Extension, ExtensionActions, ExtensionAPI, ExtensionCommandContext, ExtensionCommandContextActions, ExtensionContext, ExtensionContextActions, ExtensionError, ExtensionEvent, ExtensionFactory, ExtensionFlag, ExtensionHandler, ExtensionRuntime, ExtensionShortcut, ExtensionUIContext, ExtensionUIDialogOptions, ExtensionWidgetOptions, FindToolCallEvent, GrepToolCallEvent, InputEvent, InputEventResult, InputSource, KeybindingsManager, LoadExtensionsResult, LsToolCallEvent, MessageRenderer, MessageRenderOptions, ProjectTrustContext, ProjectTrustEvent, ProjectTrustEventDecision, ProjectTrustEventResult, ProjectTrustHandler, ProviderConfig, ProviderModelConfig, ReadToolCallEvent, RegisteredCommand, RegisteredTool, ResolvedCommand, SessionBeforeCompactEvent, SessionBeforeForkEvent, SessionBeforeSwitchEvent, SessionBeforeTreeEvent, SessionCompactEvent, SessionShutdownEvent, SessionStartEvent, SessionTreeEvent, SlashCommandInfo, SlashCommandSource, SourceInfo, TerminalInputHandler, ToolCallEvent, ToolCallEventResult, ToolDefinition, ToolExecutionMode, ToolInfo, ToolRenderResultOptions, ToolResultEvent, TurnEndEvent, TurnStartEvent, UserBashEvent, UserBashEventResult, WidgetPlacement, WorkingIndicatorOptions, WriteToolCallEvent, } from "./core/extensions/index.ts";


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.d.ts:
  Line 9: export type { AfterProviderResponseEvent, AgentEndEvent, AgentStartEvent, AgentToolResult, AgentToolUpdateCallback, AppendEntryHandler, AppKeybinding, AutocompleteProviderFactory, BashToolCallEvent, BashToolResultEvent, BeforeAgentStartEvent, BeforeAgentStartEventResult, BeforeProviderRequestEvent, BeforeProviderRequestEventResult, BuildSystemPromptOptions, CompactOptions, ContextEvent, ContextEventResult, ContextUsage, CustomToolCallEvent, CustomToolResultEvent, EditorFactory, EditToolCallEvent, EditToolResultEvent, ExecOptions, ExecResult, Extension, ExtensionActions, ExtensionAPI, ExtensionCommandContext, ExtensionCommandContextActions, ExtensionContext, ExtensionContextActions, ExtensionError, ExtensionEvent, ExtensionFactory, ExtensionFlag, ExtensionHandler, ExtensionMode, ExtensionRuntime, ExtensionShortcut, ExtensionUIContext, ExtensionUIDialogOptions, ExtensionWidgetOptions, FindToolCallEvent, FindToolResultEvent, GetActiveToolsHandler, GetAllToolsHandler, GetCommandsHandler, GetThinkingLevelHandler, GrepToolCallEvent, GrepToolResultEvent, InputEvent, InputEventResult, InputSource, KeybindingsManager, LoadExtensionsResult, LsToolCallEvent, LsToolResultEvent, MessageEndEvent, MessageRenderer, MessageRenderOptions, MessageStartEvent, MessageUpdateEvent, ModelSelectEvent, ModelSelectSource, ProjectTrustContext, ProjectTrustEvent, ProjectTrustEventDecision, ProjectTrustEventResult, ProjectTrustHandler, ProviderConfig, ProviderModelConfig, ReadToolCallEvent, ReadToolResultEvent, RegisteredCommand, RegisteredTool, ReplacedSessionContext, ResolvedCommand, ResourcesDiscoverEvent, ResourcesDiscoverResult, SendMessageHandler, SendUserMessageHandler, SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionBeforeForkEvent, SessionBeforeForkResult, SessionBeforeSwitchEvent, SessionBeforeSwitchResult, SessionBeforeTreeEvent, SessionBeforeTreeResult, SessionCompactEvent, SessionEvent, SessionShutdownEvent, SessionStartEvent, SessionTreeEvent, SetActiveToolsHandler, S...

/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.d.ts:
  Line 12: import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, BeforeProviderRequestEvent, ContextEvent, Extension, ExtensionActions, ExtensionCommandContext, ExtensionCommandContextActions, ExtensionContext, ExtensionContextActions, ExtensionError, ExtensionEvent, ExtensionFlag, ExtensionMode, ExtensionRuntime, ExtensionShortcut, ExtensionUIContext, InputEvent, InputEventResult, InputSource, LoadExtensionsResult, MessageEndEvent, MessageRenderer, ProjectTrustContext, ProjectTrustEvent, ProjectTrustEventResult, ProviderConfig, RegisteredTool, ReplacedSessionContext, ResolvedCommand, ResourcesDiscoverEvent, SessionBeforeCompactResult, SessionBeforeForkResult, SessionBeforeSwitchResult, SessionBeforeTreeResult, SessionShutdownEvent, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult, UserBashEvent, UserBashEventResult } from "./types.ts";

  Line 163:     emitInput(text: string, images: ImageContent[] | undefined, source: InputSource, streamingBehavior?: "steer" | "followUp"): Promise<InputEventResult>;


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:
  Line 598: export interface InputEvent {

  Line 610: export type InputEventResult = {

  Line 846:     on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

```

**Tool: grep**

**Input:**
```json
{
  "pattern": "pi\\.on\\(\"input\"|event\\.source|event\\.text",
  "path": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent",
  "include": "*.{ts,js,md}"
}
```

**Output:**
```
Found 21 matches
/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/examples/extensions/input-transform-streaming.ts:
  Line 19: 	pi.on("input", async (event) => {

  Line 25: 		if (!TRIGGER.test(event.text)) {

  Line 36: 			text: `${event.text}\n\nCurrent uncommitted changes:\n\`\`\`\n${stdout.trim()}\n\`\`\``,


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:
  Line 675:   // event.source - "set" | "cycle" | "restore"

  Line 682:   ctx.ui.notify(`Model changed (${event.source}): ${prev} -> ${next}`, "info");

  Line 849: pi.on("input", async (event, ctx) => {

  Line 850:   // event.text - raw input (before skill/template expansion)

  Line 852:   // event.source - "interactive" (typed), "rpc" (API), or "extension" (via sendUserMessage)

  Line 858:   if (event.text.startsWith("?quick "))

  Line 859:     return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  Line 862:   if (event.text === "ping") {

  Line 868:   if (event.source === "extension") return { action: "continue" };

  Line 871:   if (event.text.startsWith("/skill:")) {


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/examples/extensions/inline-bash.ts:
  Line 23: 	pi.on("input", async (event, ctx) => {

  Line 24: 		const text = event.text;


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/examples/extensions/input-transform.ts:
  Line 15: 	pi.on("input", async (event, ctx) => {

  Line 17: 		if (event.source === "extension") {

  Line 22: 		if (event.text.startsWith("?quick ")) {

  Line 23: 			const query = event.text.slice(7).trim();

  Line 32: 		if (event.text.toLowerCase() === "ping") {

  Line 36: 		if (event.text.toLowerCase() === "time") {

```

---

## Assistant (Plan · GPT-5.6 Sol · 27.1s)

_Thinking:_

**Assessing input handler sequencing issue**

_Thinking:_

**Designing typed speech segmentation pipeline**

_Thinking:_

**Planning configurable code block modes**

_Thinking:_

**Planning structured tool output handling**

_Thinking:_

**Designing output normalization and filtering**

_Thinking:_

**Centralizing message_end content processing**

_Thinking:_

**Checking node_modules summarizers**

**Tool: grep**

**Input:**
```json
{
  "pattern": "toolName: \"(bash|read|grep|find|ls)\"|name: \"(bash|read|grep|find|ls)\"",
  "path": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist",
  "include": "*.js"
}
```

**Output:**
```
Found 5 matches
/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js:
  Line 134:         name: "read",


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:
  Line 192:         name: "bash",


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js:
  Line 75:         name: "grep",


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js:
  Line 71:         name: "find",


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.js:
  Line 57:         name: "ls",

```

**Tool: grep**

**Input:**
```json
{
  "pattern": "format.*Bytes|bytes|line.*output|truncat",
  "path": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools",
  "include": "*.js"
}
```

**Output:**
```
Found 100 matches (more matches available)
/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/output-accumulator.js:
  Line 5: import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "./truncate.js";

  Line 70:         const tailTruncation = truncateTail(this.getSnapshotText(), {

  Line 74:         const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;

  Line 75:         const truncatedBy = truncated

  Line 76:             ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))

  Line 78:         const truncation = {

  Line 80:             truncated,

  Line 81:             truncatedBy,

  Line 87:         if (options.persistIfTruncated && truncation.truncated) {

  Line 91:             content: truncation.content,

  Line 92:             truncation,

  Line 123:         const bytes = byteLength(text);

  Line 124:         this.totalDecodedBytes += bytes;

  Line 126:         this.tailBytes += bytes;

  Line 137:             this.currentLineBytes += bytes;


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js:
  Line 8: export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateLine, truncateTail, } from "./truncate.js";


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js:
  Line 2:  * Shared truncation utilities for tool outputs.

  Line 8:  * Never returns partial lines (except bash tail truncation edge case).

  Line 24:  * Format bytes as human-readable size.

  Line 26: export function formatSize(bytes) {

  Line 27:     if (bytes < 1024) {

  Line 28:         return `${bytes}B`;

  Line 30:     else if (bytes < 1024 * 1024) {

  Line 31:         return `${(bytes / 1024).toFixed(1)}KB`;

  Line 34:         return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

  Line 38:  * Truncate content from the head (keep first N lines/bytes).

  Line 44: export function truncateHead(content, options = {}) {

  Line 50:     // Check if no truncation needed

  Line 54:             truncated: false,

  Line 55:             truncatedBy: null,

  Line 71:             truncated: true,

  Line 72:             truncatedBy: "bytes",

  Line 86:     let truncatedBy = "lines";

  Line 91:             truncatedBy = "bytes";

  Line 99:         truncatedBy = "lines";

  Line 105:         truncated: true,

  Line 106:         truncatedBy,

  Line 118:  * Truncate content from the tail (keep last N lines/bytes).

  Line 123: export function truncateTail(content, options = {}) {

  Line 129:     // Check if no truncation needed

  Line 133:             truncated: false,

  Line 134:             truncatedBy: null,

  Line 148:     let truncatedBy = "lines";

  Line 150:     for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {

  Line 152:         const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

  Line 154:             truncatedBy = "bytes";

  Line 158:                 const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);

  Line 159:                 outputLinesArr.unshift(truncatedLine);

  Line 160:                 outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");

  Line 170:         truncatedBy = "lines";

  Line 176:         truncated: true,

  Line 177:         truncatedBy,

  Line 192: function truncateStringToBytesFromEnd(str, maxBytes) {

  Line 206:  * Truncate a single line to max characters, adding [truncated] suffix.

  Line 209: export function truncateLine(line, maxChars = GREP_MAX_LINE_LENGTH) {

  Line 213:     return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };

  Line 215: //# sourceMappingURL=truncate.js.map

/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js:
  Line 12: import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine, } from "./truncate.js";

  Line 48:         const lines = output.split("\n");

  Line 58:     const truncation = result.details?.truncation;

  Line 60:     if (matchLimit || truncation?.truncated || linesTruncated) {

  Line 64:         if (truncation?.truncated)

  Line 65:             warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);

  Line 67:             warnings.push("some lines truncated");

  Line 77:         description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,

  Line 183:                                 // Truncate long lines so grep output stays compact.

  Line 184:                                 const { text: truncatedText, wasTruncated } = truncateLine(sanitized);

  Line 188:                                     block.push(`${relativePath}:${current}: ${truncatedText}`);

  Line 190:                                     block.push(`${relativePath}-${current}- ${truncatedText}`);

  Line 246:                                     const { text: truncatedText, wasTruncated } = truncateLine(sanitized);

  Line 249:                                     outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);

  Line 257:                             // Apply byte truncation. There is no line limit here because the match limit already capped rows.

  Line 258:                             const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

  Line 259:                             let output = truncation.content;

  Line 261:                             // Build actionable notices for truncation and match limits.

  Line 267:                             if (truncation.truncated) {

  Line 269:                                 details.truncation = truncation;

  Line 272:                                 notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);


/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js:
  Line 15: import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

  Line 116:     const truncation = result.details?.truncation;

  Line 117:     if (truncation?.truncated) {

  Line 118:         if (truncation.firstLineExceedsLimit) {

  Line 119:             text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;

  Line 121:         else if (truncation.truncatedBy === "lines") {

  Line 122:             text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;

  Line 125:             text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;

  Line 136:         description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,

  Line 215:                             // If limit is specified by the user, honor it first. Otherwise truncateHead decides.

  Line 224:                             // Apply truncation, respecting both line and byte limits.

  Line 225:                             const truncation = truncateHead(selectedContent);

  Line 227:                             if (truncation.firstLineExceedsLimit) {

  Line 231:                                 details = { truncation };

  Line 233:                             else if (truncation.truncated) {

  Line 235:                                 const endLineDisplay = startLineDisplay + truncation.outputLines - 1;

  Line 237:                                 outputText = truncation.content;

  Line 238:                                 if (truncation.truncatedBy === "lines") {

  Line 244:                                 details = { truncation };

  Line 250:                                 outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;

  Line 253:                                 // No truncation and no remaining user-limited content.

  Line 254:                                 outputText = truncation.content;


(Results truncated. Consider using a more specific path or pattern.)
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-ai/dist/types.d.ts",
  "offset": 215,
  "limit": 90
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-ai/dist/types.d.ts</path>
<type>file</type>
<content>
215: export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;
216: export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (model: ImagesModel<TApi>, context: ImagesContext, options?: TOptions) => Promise<AssistantImages>;
217: export interface TextSignatureV1 {
218:     v: 1;
219:     id: string;
220:     phase?: "commentary" | "final_answer";
221: }
222: export interface TextContent {
223:     type: "text";
224:     text: string;
225:     textSignature?: string;
226: }
227: export interface ThinkingContent {
228:     type: "thinking";
229:     thinking: string;
230:     thinkingSignature?: string;
231:     /** When true, the thinking content was redacted by safety filters. The opaque
232:      *  encrypted payload is stored in `thinkingSignature` so it can be passed back
233:      *  to the API for multi-turn continuity. */
234:     redacted?: boolean;
235: }
236: export interface ImageContent {
237:     type: "image";
238:     data: string;
239:     mimeType: string;
240: }
241: export interface ToolCall {
242:     type: "toolCall";
243:     id: string;
244:     name: string;
245:     arguments: Record<string, any>;
246:     thoughtSignature?: string;
247: }
248: export interface Usage {
249:     input: number;
250:     output: number;
251:     cacheRead: number;
252:     cacheWrite: number;
253:     /** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
254:     cacheWrite1h?: number;
255:     totalTokens: number;
256:     cost: {
257:         input: number;
258:         output: number;
259:         cacheRead: number;
260:         cacheWrite: number;
261:         total: number;
262:     };
263: }
264: export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
265: export interface UserMessage {
266:     role: "user";
267:     content: string | (TextContent | ImageContent)[];
268:     timestamp: number;
269: }
270: export interface AssistantMessage {
271:     role: "assistant";
272:     content: (TextContent | ThinkingContent | ToolCall)[];
273:     api: Api;
274:     provider: ProviderId;
275:     model: string;
276:     responseModel?: string;
277:     responseId?: string;
278:     diagnostics?: AssistantMessageDiagnostic[];
279:     usage: Usage;
280:     stopReason: StopReason;
281:     errorMessage?: string;
282:     timestamp: number;
283: }
284: export interface ToolResultMessage<TDetails = any> {
285:     role: "toolResult";
286:     toolCallId: string;
287:     toolName: string;
288:     content: (TextContent | ImageContent)[];
289:     details?: TDetails;
290:     isError: boolean;
291:     timestamp: number;
292: }
293: export type Message = UserMessage | AssistantMessage | ToolResultMessage;
294: export type ImagesInputContent = TextContent | ImageContent;
295: export type ImagesOutputContent = TextContent | ImageContent;
296: export interface ImagesContext {
297:     input: ImagesInputContent[];
298: }
299: export type ImagesStopReason = "stop" | "error" | "aborted";
300: export interface AssistantImages {
301:     api: ImagesApi;
302:     provider: ImagesProviderId;
303:     model: string;
304:     output: ImagesOutputContent[];

(Showing lines 215-304 of 591. Use offset=305 to continue.)
</content>
```

**Tool: grep**

**Input:**
```json
{
  "pattern": "interface (Bash|Read|Grep|Find|Ls)ToolResultEvent",
  "path": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts"
}
```

**Error:**
```
Ripgrep JSON record exceeded 65536 bytes
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/package.json"
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/package.json</path>
<type>file</type>
<content>
1: {
2:   "name": "my-pi",
3:   "version": "0.1.0",
4:   "private": true,
5:   "description": "Personal Pi packages, extensions, skills, prompts, and themes.",
6:   "type": "module",
7:   "keywords": [
8:     "pi-package",
9:     "pi",
10:     "pi-coding-agent"
11:   ],
12:   "workspaces": [
13:     "packages/*"
14:   ],
15:   "scripts": {
16:     "check": "pnpm -r run typecheck",
17:     "test": "pnpm -r test",
18:     "voice:server": "pnpm --filter @jac/pi-voice server",
19:     "voice:cli": "pnpm --filter @jac/pi-voice cli"
20:   },
21:   "pi": {
22:     "extensions": [
23:       "packages/pi-voice/extensions/index.ts",
24:       "packages/pi-snippets/extensions/index.ts"
25:     ],
26:     "skills": [
27:       "skills"
28:     ],
29:     "prompts": [
30:       "prompts"
31:     ],
32:     "themes": [
33:       "themes"
34:     ]
35:   },
36:   "devDependencies": {
37:     "@biomejs/biome": "^2.4.14",
38:     "typescript": "^5.0.0"
39:   }
40: }

(End of file - total 40 lines)
</content>
```

**Tool: bash**

**Input:**
```json
{
  "command": "git status --short && git log --oneline -10 -- \"packages/pi-voice\"",
  "workdir": "/home/jesse/gh/my-pi"
}
```

**Output:**
```
 M .gitignore
 M README.md
 M package.json
 M pnpm-lock.yaml
?? agent/
?? docs/
?? packages/pi-snippets/
?? scripts/
13cbadc chore:💤 change name pi-setups -> my-pi
677034e chore:💤🤖 workspace, configs & migrate pi-voice -> packages

```

---

## Assistant (Plan · GPT-5.6 Sol · 26.5s)

_Thinking:_

**Clarifying scope and config focus**

_Thinking:_

**Designing flexible rule matching syntax**

_Thinking:_

**Deciding single-pass rule application**

_Thinking:_

**Designing robust token-based replacement system**

_Thinking:_

**Planning external pronunciation config file**

_Thinking:_

**Defining minimal pronunciation file config**

_Thinking:_

**Planning config loader refactor**

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts",
  "offset": 1,
  "limit": 100
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts</path>
<type>file</type>
<content>
1: /**
2:  * pi-voice extension — /voice command and tts tool.
3:  *
4:  * TUI settings (via /voice):
5:  *   - TTS enabled/disabled (toggle)
6:  *   - Voice selector (fetched from server when model is loaded)
7:  *   - Speed selector (0.5 – 3.0)
8:  *
9:  * Persistence:
10:  *   - Global defaults: ~/.pi/voice/config.json
11:  *   - Session overrides: pi.appendEntry("voice-session", ...)
12:  *
13:  * Auto-TTS events:
14:  *   - Configured via events: Record<string, EventConfig> in ~/.pi/voice/config.json
15:  *   - EventConfig is one of:
16:  *     - { content?: "text" | "thinking" | "all" } — speak extracted event content directly
17:  *     - { prompt: string, content?: "text" | "thinking" | "all", model?: { provider, id } }
18:  *       — summarize extracted event content via LLM, then speak
19:  *     - { text: string } — speak fixed text directly (no LLM)
20:  *   - text is mutually exclusive with prompt/content
21:  *   - model is optional per-event; if omitted, inherits the active session model
22:  *   - Default: agent_end with last_message context
23:  *   - Any event name can be used; presence in config = enabled
24:  *   - Built-in pi events (agent_end, turn_end, message_end) use pi.on()
25:  *   - Custom events (e.g. ask:started) use the shared pi.events bus
26:  *   - Uses per-event model if configured, otherwise inherits the active session model
27:  *
28:  * Agent tool:
29:  *   - tts: converts text → WAV via the TTS server, plays it.
30:  *     Uses session overrides > global defaults.
31:  */
32: 
33: import { exec as execCb, spawn } from "node:child_process";
34: import {
35:   appendFileSync,
36:   existsSync,
37:   mkdirSync,
38:   readFileSync,
39:   unlinkSync,
40:   writeFileSync,
41: } from "node:fs";
42: import { homedir } from "node:os";
43: import { join, resolve } from "node:path";
44: import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
45: import {
46:   defaultSttModelDir,
47:   startLocalSttSession,
48:   type LocalSttSession,
49:   type SttProgress,
50:   type SttRuntimeConfig,
51: } from "./stt.ts";
52: 
53: const Type = await loadTypebox();
54: 
55: async function loadTypebox() {
56:   try {
57:     const mod = (await import("typebox")) as { Type?: unknown };
58:     if (mod.Type) return mod.Type as ReturnType<typeof fallbackTypebox>;
59:   } catch {
60:     /* use lightweight fallback for tests/dev installs without peer deps */
61:   }
62:   return fallbackTypebox();
63: }
64: 
65: function fallbackTypebox() {
66:   return {
67:     Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
68:       type: "object",
69:       properties,
70:       ...options,
71:     }),
72:     String: (options: Record<string, unknown> = {}) => ({ type: "string", ...options }),
73:     Number: (options: Record<string, unknown> = {}) => ({ type: "number", ...options }),
74:     Boolean: (options: Record<string, unknown> = {}) => ({ type: "boolean", ...options }),
75:     Literal: (value: unknown) => ({ const: value }),
76:     Union: (schemas: unknown[]) => ({ anyOf: schemas }),
77:     Optional: (schema: unknown) => schema,
78:     Record: (_key: unknown, value: unknown) => ({ type: "object", additionalProperties: value }),
79:   };
80: }
81: 
82: function matchesKey(data: string, name: string): boolean {
83:   if (name.length === 1) return data === name;
84:   switch (name) {
85:     case "escape":
86:       return data === "\x1b";
87:     case "enter":
88:       return data === "\r" || data === "\n";
89:     case "up":
90:       return data === "\x1b[A";
91:     case "down":
92:       return data === "\x1b[B";
93:     case "right":
94:       return data === "\x1b[C";
95:     case "left":
96:       return data === "\x1b[D";
97:     default:
98:       return false;
99:   }
100: }

(Showing lines 1-100 of 2121. Use offset=101 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js",
  "offset": 170,
  "limit": 100
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js</path>
<type>file</type>
<content>
170:         }
171:         if (truncation?.truncated) {
172:             if (truncation.truncatedBy === "lines") {
173:                 warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
174:             }
175:             else {
176:                 warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`);
177:             }
178:         }
179:         component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
180:     }
181:     if (startedAt !== undefined) {
182:         const label = options.isPartial ? "Elapsed" : "Took";
183:         const endTime = endedAt ?? Date.now();
184:         component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
185:     }
186: }
187: export function createBashToolDefinition(cwd, options) {
188:     const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
189:     const commandPrefix = options?.commandPrefix;
190:     const spawnHook = options?.spawnHook;
191:     return {
192:         name: "bash",
193:         label: "bash",
194:         description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
195:         promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
196:         parameters: bashSchema,
197:         async execute(_toolCallId, { command, timeout }, signal, onUpdate, _ctx) {
198:             const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
199:             const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
200:             const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
201:             let acceptingOutput = true;
202:             let updateTimer;
203:             let updateDirty = false;
204:             let lastUpdateAt = 0;
205:             const emitOutputUpdate = () => {
206:                 if (!onUpdate || !updateDirty)
207:                     return;
208:                 updateDirty = false;
209:                 lastUpdateAt = Date.now();
210:                 const snapshot = output.snapshot({ persistIfTruncated: true });
211:                 onUpdate({
212:                     content: [{ type: "text", text: snapshot.content || "" }],
213:                     details: {
214:                         truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
215:                         fullOutputPath: snapshot.fullOutputPath,
216:                     },
217:                 });
218:             };
219:             const clearUpdateTimer = () => {
220:                 if (updateTimer) {
221:                     clearTimeout(updateTimer);
222:                     updateTimer = undefined;
223:                 }
224:             };
225:             const scheduleOutputUpdate = () => {
226:                 if (!onUpdate)
227:                     return;
228:                 updateDirty = true;
229:                 const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
230:                 if (delay <= 0) {
231:                     clearUpdateTimer();
232:                     emitOutputUpdate();
233:                     return;
234:                 }
235:                 updateTimer ??= setTimeout(() => {
236:                     updateTimer = undefined;
237:                     emitOutputUpdate();
238:                 }, delay);
239:             };
240:             if (onUpdate) {
241:                 onUpdate({ content: [], details: undefined });
242:             }
243:             const handleData = (data) => {
244:                 if (!acceptingOutput)
245:                     return;
246:                 output.append(data);
247:                 scheduleOutputUpdate();
248:             };
249:             const finishOutput = async () => {
250:                 acceptingOutput = false;
251:                 output.finish();
252:                 clearUpdateTimer();
253:                 emitOutputUpdate();
254:                 const snapshot = output.snapshot({ persistIfTruncated: true });
255:                 await output.closeTempFile();
256:                 return snapshot;
257:             };
258:             const formatOutput = (snapshot, emptyText = "(no output)") => {
259:                 const truncation = snapshot.truncation;
260:                 let text = snapshot.content || emptyText;
261:                 let details;
262:                 if (truncation.truncated) {
263:                     details = { truncation, fullOutputPath: snapshot.fullOutputPath };
264:                     const startLine = truncation.totalLines - truncation.outputLines + 1;
265:                     const endLine = truncation.totalLines;
266:                     if (truncation.lastLinePartial) {
267:                         const lastLineSize = formatSize(output.getLastLineBytes());
268:                         text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
269:                     }

(Showing lines 170-269 of 346. Use offset=270 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js",
  "offset": 190,
  "limit": 80
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js</path>
<type>file</type>
<content>
190:                             else {
191:                                 let textNote = `Read image file [${mimeType}]`;
192:                                 if (nonVisionImageNote)
193:                                     textNote += `\n${nonVisionImageNote}`;
194:                                 content = [
195:                                     { type: "text", text: textNote },
196:                                     { type: "image", data: buffer.toString("base64"), mimeType },
197:                                 ];
198:                             }
199:                         }
200:                         else {
201:                             // Read text content.
202:                             const buffer = await ops.readFile(absolutePath);
203:                             const textContent = buffer.toString("utf-8");
204:                             const allLines = textContent.split("\n");
205:                             const totalFileLines = allLines.length;
206:                             // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
207:                             const startLine = offset ? Math.max(0, offset - 1) : 0;
208:                             const startLineDisplay = startLine + 1;
209:                             // Check if offset is out of bounds.
210:                             if (startLine >= allLines.length) {
211:                                 throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
212:                             }
213:                             let selectedContent;
214:                             let userLimitedLines;
215:                             // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
216:                             if (limit !== undefined) {
217:                                 const endLine = Math.min(startLine + limit, allLines.length);
218:                                 selectedContent = allLines.slice(startLine, endLine).join("\n");
219:                                 userLimitedLines = endLine - startLine;
220:                             }
221:                             else {
222:                                 selectedContent = allLines.slice(startLine).join("\n");
223:                             }
224:                             // Apply truncation, respecting both line and byte limits.
225:                             const truncation = truncateHead(selectedContent);
226:                             let outputText;
227:                             if (truncation.firstLineExceedsLimit) {
228:                                 // First line alone exceeds the byte limit. Point the model at a bash fallback.
229:                                 const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
230:                                 outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
231:                                 details = { truncation };
232:                             }
233:                             else if (truncation.truncated) {
234:                                 // Truncation occurred. Build an actionable continuation notice.
235:                                 const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
236:                                 const nextOffset = endLineDisplay + 1;
237:                                 outputText = truncation.content;
238:                                 if (truncation.truncatedBy === "lines") {
239:                                     outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
240:                                 }
241:                                 else {
242:                                     outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
243:                                 }
244:                                 details = { truncation };
245:                             }
246:                             else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
247:                                 // User-specified limit stopped early, but the file still has more content.
248:                                 const remaining = allLines.length - (startLine + userLimitedLines);
249:                                 const nextOffset = startLine + userLimitedLines + 1;
250:                                 outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
251:                             }
252:                             else {
253:                                 // No truncation and no remaining user-limited content.
254:                                 outputText = truncation.content;
255:                             }
256:                             content = [{ type: "text", text: outputText }];
257:                         }
258:                         if (aborted)
259:                             return;
260:                         signal?.removeEventListener("abort", onAbort);
261:                         resolve({ content, details });
262:                     }
263:                     catch (error) {
264:                         signal?.removeEventListener("abort", onAbort);
265:                         if (!aborted)
266:                             reject(error);
267:                     }
268:                 })();
269:             });

(Showing lines 190-269 of 289. Use offset=270 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js",
  "offset": 225,
  "limit": 65
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js</path>
<type>file</type>
<content>
225:                             if (aborted) {
226:                                 settle(() => reject(new Error("Operation aborted")));
227:                                 return;
228:                             }
229:                             if (!killedDueToLimit && code !== 0 && code !== 1) {
230:                                 const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
231:                                 settle(() => reject(new Error(errorMsg)));
232:                                 return;
233:                             }
234:                             if (matchCount === 0) {
235:                                 settle(() => resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }));
236:                                 return;
237:                             }
238:                             // Format matches after streaming finishes so custom readFile() backends can be async.
239:                             for (const match of matches) {
240:                                 if (contextValue === 0 && match.lineText !== undefined) {
241:                                     const relativePath = formatPath(match.filePath);
242:                                     const sanitized = match.lineText
243:                                         .replace(/\r\n/g, "\n")
244:                                         .replace(/\r/g, "")
245:                                         .replace(/\n$/, "");
246:                                     const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
247:                                     if (wasTruncated)
248:                                         linesTruncated = true;
249:                                     outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
250:                                 }
251:                                 else {
252:                                     const block = await formatBlock(match.filePath, match.lineNumber);
253:                                     outputLines.push(...block);
254:                                 }
255:                             }
256:                             const rawOutput = outputLines.join("\n");
257:                             // Apply byte truncation. There is no line limit here because the match limit already capped rows.
258:                             const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
259:                             let output = truncation.content;
260:                             const details = {};
261:                             // Build actionable notices for truncation and match limits.
262:                             const notices = [];
263:                             if (matchLimitReached) {
264:                                 notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
265:                                 details.matchLimitReached = effectiveLimit;
266:                             }
267:                             if (truncation.truncated) {
268:                                 notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
269:                                 details.truncation = truncation;
270:                             }
271:                             if (linesTruncated) {
272:                                 notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
273:                                 details.linesTruncated = true;
274:                             }
275:                             if (notices.length > 0)
276:                                 output += `\n\n[${notices.join(". ")}]`;
277:                             settle(() => resolve({
278:                                 content: [{ type: "text", text: output }],
279:                                 details: Object.keys(details).length > 0 ? details : undefined,
280:                             }));
281:                         });
282:                     }
283:                     catch (err) {
284:                         settle(() => reject(err));
285:                     }
286:                 })();
287:             });
288:         },
289:         renderCall(args, theme, context) {

(Showing lines 225-289 of 304. Use offset=290 to continue.)
</content>
```

**Tool: grep**

**Input:**
```json
{
  "pattern": "Value\\.Check|Value\\.Parse|Compile\\(",
  "path": "/home/jesse/gh/my-pi",
  "include": "*.ts"
}
```

**Output:**
```
No files found
```

---

## Assistant (Plan · GPT-5.6 Sol · 527.3s)

_Thinking:_

**Planning config normalization strategy**

_Thinking:_

**Planning clarifying questions for playback behavior**

_Thinking:_

**Preparing targeted config questions for user**

A maintainable implementation should treat these as two separable subsystems: a turn-aware cancellable speech scheduler, and a single context-aware text pipeline used exactly once before synthesis. I recommend deterministic technical cleanup as the normal path, with LLM summarization opt-in per code/tool segment rather than automatically rewriting an entire response.

**Tool: question**

**Input:**
```json
{
  "questions": [
    {
      "header": "New-Turn Trigger",
      "question": "When a new user message is submitted while old speech is playing, when should stale speech be interrupted?",
      "options": [
        {
          "label": "On submission (Recommended)",
          "description": "Stop immediately on normal interactive/RPC input, before the next agent response begins."
        },
        {
          "label": "When agent consumes it",
          "description": "Wait for a user message_start event, avoiding interruption for input another extension handles."
        },
        {
          "label": "Discard queued only",
          "description": "Let current playback finish, but remove older speech that has not started."
        }
      ]
    },
    {
      "header": "Technical Summaries",
      "question": "Should LLM-based code/tool summaries remain available after deterministic cleanup is added?",
      "options": [
        {
          "label": "Optional per profile (Recommended)",
          "description": "Default to deterministic cleanup; allow explicit LLM summaries with deterministic fallback."
        },
        {
          "label": "Deterministic only",
          "description": "No extra model calls; use bounded excerpts and structural descriptions only."
        },
        {
          "label": "LLM by default",
          "description": "Summarize long technical segments with the active model unless disabled."
        }
      ]
    }
  ]
}
```

**Output:**
```
User has answered your questions: "When a new user message is submitted while old speech is playing, when should stale speech be interrupted?"="On submission (Recommended)", "Should LLM-based code/tool summaries remain available after deterministic cleanup is added?"="Optional per profile (Recommended)". You can now continue with the user's answers in mind.
```

---

## Assistant (Plan · GPT-5.6 Sol · 406.2s)

_Thinking:_

**Planning test inspection and architecture critique**

_Thinking:_

**Inspecting config and input handler chaining**

**Tool: task**

**Input:**
```json
{
  "description": "Critique voice redesign",
  "subagent_type": "general",
  "prompt": "Read-only design critique; do not edit files. Based on /home/jesse/gh/my-pi/packages/pi-voice current source, evaluate this proposed incremental redesign against the user's goals: (1) config queue.onUserInput = continue|drop-pending|interrupt, default continue, selected interrupt triggers on normal input submission and uses speech epochs plus AbortControllers to cancel stale auto/tool synthesis and playback; (2) extract one context-aware speech text pipeline that parses Markdown into prose/inline-code/code-block segments, performs deterministic technical cleanup, optional per-profile LLM summarization only for selected technical segments, pronunciation rules once, then semantic chunking; (3) external ~/.pi/voice/pronunciations.json rules with literal/regex and scopes by segment kind/tool/event/role/source; (4) event roles filter and profile selection. Identify overengineering, missing race/cancellation semantics, backwards-compatibility hazards, unsafe rule semantics, and the smallest robust module/config/test boundaries. Return concise recommendations with file:line references. Do not implement."
}
```

**Output:**
```
<task id="ses_0405731b5ffe5s9HOqCSwq517A" state="completed">
<task_result>
**Findings**
1. **Cancellation needs one owner and precise states.** There are currently four independent queues: `autoTTSTail`, `streamTail`, `audioQueue`, and the server queue. Fetches, LLM generation, and player processes are not cancellable; the `tts` tool also ignores its supplied `_signal` (`extensions/index.ts:825-827`, `888-925`, `1330-1364`, `1476-1548`, `1980-2009`; `extensions/server.ts:392-472`). Replace the three client queues with one speech scheduler owning jobs from preparation through playback.
2. **Define policy semantics before implementing epochs.** Recommended:
   - `continue`: preserve active and pending jobs.
   - `drop-pending`: cancel only jobs not yet dequeued; active means the entire summary/synthesis/playback operation.
   - `interrupt`: drop pending jobs and abort the active auto/tool job; samples and STT cues remain unaffected.
   - Synthesize chunks just in time. Current chunk fallback pre-synthesizes later chunks while earlier ones play, creating stale work (`extensions/index.ts:1348-1363`).
3. **An epoch alone does not prevent stale post-input work.** During streaming, old `message_update` events or a later old-turn `tts` call can arrive after input and accidentally capture the new epoch. The global `streamBuffer` worsens this (`extensions/index.ts:1496-1574`). Bind speech generation to the agent turn: mark the old turn stale on input, clear its stream buffer, and do not advance the producing-turn epoch until the corresponding user `message_start`. Cancel all jobs on session/tree changes; current queues survive those transitions (`extensions/index.ts:2031-2041`).
4. **Use the actual `input` event, with an explicit source policy.** Pi exposes submission-time `input` with `interactive|rpc|extension`; slash commands are processed before it (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:595-607,846`; `dist/core/agent-session.js:713-727`). Treat interactive and RPC as normal input; normally exclude extension-injected input to avoid recursive cancellation.
5. **Active local inference cannot truly be aborted today.** The server observes disconnect only while queued, removes the listener before processing, and `tts.generate()` has no signal (`extensions/server.ts:406-425`, `465-468`). Client abort can prevent playback and discard results, but active Kokoro CPU work continues. Document this as best-effort cancellation. A worker/process-based preemption protocol would be disproportionate for this increment.
6. **Playback abort must settle, not merely kill.** Retain handles for fetch readers and spawned players; abort fetch, cancel the reader, close stdin, kill the process, remove temp files, and settle each job exactly once. Do not release the audio slot until the old child closes, or new and old audio can overlap. Also rethrow `AbortError` rather than entering the remote stream fallback (`extensions/index.ts:1212-1225`, `1247-1325`, `1340-1345`).
7. **The unified text pipeline is justified, but preserve both raw and cleaned segment text.** Current preprocessing is regex-based and invoked repeatedly by auto, tool, and `speak()` paths (`extensions/index.ts:418-487`, `1372`, `1432-1468`, `1998`). Technical summarization needs raw code; deterministic fallback needs cleaned text. Use segment records carrying both, apply pronunciation exactly once after optional summarization, then chunk.
8. **Do not run an LLM once per technical segment.** That multiplies latency, cost, ordering, and cancellation races. Batch selected segments once per utterance/profile, retain stable segment IDs, and fall back deterministically if output is missing or malformed. Abort must not invoke fallback. Current summarization swallows every failure and has no cancellation (`extensions/index.ts:751-814`).
9. **Streaming Markdown conflicts with context-aware parsing.** Current punctuation flushing can split fences and inline code before sanitization (`extensions/index.ts:1496-1574`). Buffer technical/incomplete Markdown until a final event, or maintain a small stateful fence/inline scanner. Do not add a full incremental CommonMark engine or LLM summarization to live deltas in the first iteration.
10. **Preserve shipped event semantics.** Existing `{prompt, model?, content?}` summarizes the entire event and is documented behavior (`extensions/index.ts:109-127`, `1439-1455`; `CHANGELOG.md:18-24`). Do not reinterpret it as technical-segment summarization. Make profiles opt-in and retain the legacy path until an explicit migration.
11. **Configuration loading needs one validated boundary.** `_VoiceConfigSchema` is currently unused while `loadConfig()` manually normalizes a subset (`extensions/index.ts:212-265`, `668-700`). Preserve the important distinction that an existing config without `events` disables auto-TTS (`extensions/index.ts:672-684`). Also avoid whole-file rewrites that discard unknown/new fields when `/voice` saves (`extensions/index.ts:703-705`, `1782-1803`).
12. **Roles and scopes require normalized context.** `extractLastMessage()` currently ignores role and simply chooses the last message (`extensions/index.ts:716-746`). For message arrays, select the latest message matching configured roles; defaulting to assistant matches existing interface comments, but is still a behavior change worth documenting. Carry `{source,event,role,tool,profile}` through the pipeline. Keep event-level `profile` and `roles` properties; avoid a separate routing or profile-inheritance system.
13. **Built-in event registration must remain distinct from the shared bus.** Only four Pi events are registered with `pi.on`; every other configured name is treated as custom (`extensions/index.ts:2066-2115`). If tool/event scopes include built-in tool lifecycle events, register those through `pi.on`, not `pi.events`.
14. **JavaScript regex pronunciation rules are a denial-of-service surface.** Assistant/tool text is untrusted, and catastrophic regexes cannot be safely timed out in-process. Prefer a linear-time regex engine; otherwise defer regex and ship literals first. If regex remains mandatory, restrict flags, reject empty matches, cap rule/input/output sizes, apply rules in file order, and use literal replacement callbacks so `$1`/`$&` are not expanded unexpectedly. Scope fields should combine with AND, values within a field with OR, and missing context should not match.

**Smallest Boundaries**
- `config.ts`: config/default parsing, profile resolution, immutable pronunciation-rule snapshot.
- `speech-text.ts`: pure Markdown segmentation, deterministic cleanup, scoped rules, semantic chunking.
- `speech-runtime.ts`: FIFO job state, epochs, AbortControllers, synthesis/player lifecycle, paired start/end events.
- Keep event extraction and Pi registration in `index.ts`; do not split every pipeline stage into its own module.

**Test Boundaries**
- Pure `speech-text.test.ts`: fences, inline code, deterministic cleanup, scope matching, rule order/growth, chunk boundaries.
- Deterministic `speech-runtime.test.ts` with fake deferred synthesizer/player: FIFO, all three policies, cancellation at every await boundary, stale-turn rejection, no overlap, and exactly one terminal event.
- `config.test.ts`: missing/invalid queue values, absent `events`, legacy prompt behavior, unknown profiles, malformed pronunciation files.
- Thin event integration tests for input source filtering, role selection, profile selection, and session changes.
- Isolate tests with a temporary `PI_VOICE_DIR`; current event tests mutate real `~/.pi/voice/config.json` (`extensions/events.test.ts:30-32`, `66-116`). Also include them in scripts: `npm test` currently runs only the expensive server integration suite (`package.json:48`).
</task_result>
</task>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
  "offset": 830,
  "limit": 55
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js</path>
<type>file</type>
<content>
830:                         error: message,
831:                         stack,
832:                     });
833:                 }
834:             }
835:         }
836:         return { skillPaths, promptPaths, themePaths };
837:     }
838:     /** Emit input event. Transforms chain, "handled" short-circuits. */
839:     async emitInput(text, images, source, streamingBehavior) {
840:         const ctx = this.createContext();
841:         let currentText = text;
842:         let currentImages = images;
843:         for (const ext of this.extensions) {
844:             for (const handler of ext.handlers.get("input") ?? []) {
845:                 try {
846:                     const event = {
847:                         type: "input",
848:                         text: currentText,
849:                         images: currentImages,
850:                         source,
851:                         streamingBehavior,
852:                     };
853:                     const result = (await handler(event, ctx));
854:                     if (result?.action === "handled")
855:                         return result;
856:                     if (result?.action === "transform") {
857:                         currentText = result.text;
858:                         currentImages = result.images ?? currentImages;
859:                     }
860:                 }
861:                 catch (err) {
862:                     this.emitError({
863:                         extensionPath: ext.path,
864:                         event: "input",
865:                         error: err instanceof Error ? err.message : String(err),
866:                         stack: err instanceof Error ? err.stack : undefined,
867:                     });
868:                 }
869:             }
870:         }
871:         return currentText !== text || currentImages !== images
872:             ? { action: "transform", text: currentText, images: currentImages }
873:             : { action: "continue" };
874:     }
875: }
876: //# sourceMappingURL=runner.js.map

(End of file - total 876 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/tsconfig.json"
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/tsconfig.json</path>
<type>file</type>
<content>
1: {
2:   "compilerOptions": {
3:     "target": "ES2022",
4:     "module": "NodeNext",
5:     "moduleResolution": "NodeNext",
6:     "lib": ["ES2022", "DOM"],
7:     "strict": false,
8:     "skipLibCheck": true,
9:     "noEmit": true,
10:     "allowImportingTsExtensions": true,
11:     "types": ["node"]
12:   },
13:   "include": ["extensions/**/*.ts", "src/**/*.ts", "src/**/*.js"]
14: }

(End of file - total 14 lines)
</content>
```

**Tool: grep**

**Input:**
```json
{
  "pattern": "function createMockPi|piEventHandlers|globalThis.fetch|beforeEach|afterEach",
  "path": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts"
}
```

**Output:**
```
Found 17 matches
/home/jesse/gh/my-pi/packages/pi-voice/extensions/events.test.ts:
  Line 22: import { afterEach, beforeEach, describe, it } from "node:test";

  Line 165: let piEventHandlers: Record<string, (...args: any[]) => Promise<void>>;

  Line 176: const originalFetch = globalThis.fetch;

  Line 183: function createMockPi() {

  Line 190:   piEventHandlers = {};

  Line 220:       piEventHandlers[event] = handler;

  Line 244:   globalThis.fetch = (async (input: any) => {

  Line 314:   beforeEach(() => {

  Line 320:   afterEach(() => {

  Line 321:     globalThis.fetch = originalFetch;

  Line 610:       globalThis.fetch = originalFetch;

  Line 656:       globalThis.fetch = (async (input: any, init?: RequestInit) => {

  Line 701:       globalThis.fetch = (async (input: any, init?: RequestInit) => {

  Line 798:       const updateHandler = piEventHandlers.message_update;

  Line 799:       const endHandler = piEventHandlers.message_end;

  Line 831:       const handler = piEventHandlers.agent_end;

  Line 865:       const handler = piEventHandlers.agent_end;

```

---

## Assistant (Plan · GPT-5.6 Sol · 80.1s)

_Thinking:_

**Designing robust turn ownership**

_Thinking:_

**Defining speech generation epochs**

_Thinking:_

**Integrating TTS with turn epochs**

_Thinking:_

**Clarifying message queuing and suppression logic**

_Thinking:_

**Designing centralized SpeechScheduler module**

_Thinking:_

**Planning abortable queued job execution**

_Thinking:_

**Refining source queue semantics**

_Thinking:_

**Evaluating sequential speech synthesis fallback**

_Thinking:_

**Designing configurable speech profiles**

_Thinking:_

**Defining configurable user profiles**

_Thinking:_

**Designing profile inheritance simplification**

_Thinking:_

**Deciding on technical profile opt-in and behavior changes**

_Thinking:_

**Designing processing profiles with detailed code handling**

_Thinking:_

**Planning source declaration summaries for code blocks**

_Thinking:_

**Defining log output truncation strategy**

_Thinking:_

**Designing tool call metadata tracking**

_Thinking:_

**Refining token verbalization approach**

_Thinking:_

**Designing configurable pronunciation rules**

_Thinking:_

**Defining rule matching precedence and reload methods**

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts",
  "offset": 1600,
  "limit": 330
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/index.ts</path>
<type>file</type>
<content>
1600:     }
1601:   }
1602: 
1603:   async function fetchVoices(config = getEffective()): Promise<string[]> {
1604:     const path = config.backend === "remote" ? "/v1/voices" : "/voices";
1605:     const remote = config.backend === "remote" ? remoteConfig(config) : null;
1606:     const res = await fetch(`${effectiveServerUrl(config)}${path}`, {
1607:       headers: remote ? remoteAuthHeaders(remote) : undefined,
1608:     });
1609:     if (!res.ok) return [];
1610:     const data = (await res.json()) as { voices?: string[] } | Array<{ id?: string }>;
1611:     if (Array.isArray(data)) return data.map((voice) => voice.id).filter(Boolean) as string[];
1612:     return data.voices ?? [];
1613:   }
1614: 
1615:   // ── /voice command ─────────────────────────────────────────────
1616: 
1617:   pi.registerCommand("voice", {
1618:     description: "Configure TTS voice and speed",
1619:     handler: async (_args, ctx) => {
1620:       const effective = getEffective();
1621: 
1622:       const health = await fetchHealth(effective);
1623:       let voices: string[] = [];
1624:       if (health?.modelLoaded) {
1625:         try {
1626:           voices = await fetchVoices(effective);
1627:         } catch {
1628:           voices = [];
1629:         }
1630:       }
1631: 
1632:       await ctx.ui.custom((_tui, theme, _kb, done) => {
1633:         let enabled = effective.enabled;
1634:         let voiceIdx = voices.length > 0 ? Math.max(0, voices.indexOf(effective.voice)) : -1;
1635:         let speedIdx = speedToIndex(effective.speed);
1636:         let selectedRow = 0;
1637:         let playing = false;
1638:         let playError: string | null = null;
1639:         let feedback: string | null = null;
1640: 
1641:         const rowDefs: Array<{ id: string }> = [
1642:           { id: "enabled" },
1643:           ...(voices.length > 0 ? [{ id: "voice" }] : []),
1644:           { id: "speed" },
1645:         ];
1646: 
1647:         const sampleText = "The quick brown fox jumps over the lazy dog.";
1648: 
1649:         function emitConfig() {
1650:           pi.events.emit("voice:config", {
1651:             enabled,
1652:             voice: voices.length > 0 ? voices[voiceIdx] : defaults.voice,
1653:             speed: Number.parseFloat(SPEED_VALUES[speedIdx]),
1654:           });
1655:         }
1656: 
1657:         async function playSampleTts() {
1658:           const voice = voices.length > 0 ? voices[voiceIdx] : defaults.voice;
1659:           const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
1660:           const sampleConfig = { ...effective, voice, speed };
1661:           pi.events.emit("voice:speak_start", {
1662:             text: sampleText,
1663:             voice,
1664:             speed,
1665:             source: "sample",
1666:           });
1667:           try {
1668:             const playbackError = await synthesizeAndPlay(sampleText, sampleConfig);
1669:             pi.events.emit("voice:speak_end", {
1670:               text: sampleText,
1671:               source: "sample",
1672:               ...(playbackError ? { error: playbackError } : {}),
1673:             });
1674:           } catch (error) {
1675:             pi.events.emit("voice:speak_end", {
1676:               text: sampleText,
1677:               source: "sample",
1678:               error: error instanceof Error ? error.message : String(error),
1679:             });
1680:             throw error;
1681:           }
1682:         }
1683: 
1684:         return {
1685:           render(_width: number) {
1686:             const lines: string[] = [];
1687: 
1688:             // Title
1689:             lines.push(theme.fg("accent", theme.bold("Voice")));
1690: 
1691:             // Server status
1692:             const statusText = health
1693:               ? health.modelLoaded
1694:                 ? `● Server running (${health.activeDtype})`
1695:                 : health.loading
1696:                   ? "◐ Server loading…"
1697:                   : "○ Server up (no model)"
1698:               : "✗ Server not detected";
1699:             const statusColor = health?.modelLoaded
1700:               ? "success"
1701:               : health?.loading
1702:                 ? "warning"
1703:                 : health
1704:                   ? "dim"
1705:                   : "dim";
1706:             lines.push(`  ${theme.fg(statusColor, statusText)}`);
1707:             const serverHint = health?.modelLoaded
1708:               ? theme.fg("dim", "  pi-voice server stop to stop")
1709:               : health
1710:                 ? theme.fg("dim", "  pi-voice server start to start")
1711:                 : theme.fg("dim", "  pi-voice server start to start");
1712:             lines.push(serverHint);
1713: 
1714:             // Active events
1715:             const activeEvents = effective.events ? Object.keys(effective.events) : [];
1716:             if (activeEvents.length > 0) {
1717:               lines.push(`  ${theme.fg("dim", `Events: ${activeEvents.join(", ")}`)}`);
1718:             }
1719: 
1720:             const stt = sttConfig(effective);
1721:             lines.push(
1722:               `  ${theme.fg(stt.enabled ? "success" : "dim", `STT: ${stt.enabled ? "on" : "off"} (${stt.enabled ? sttStatus : "disabled"})`)}`,
1723:             );
1724:             lines.push(`  ${theme.fg("dim", "Use /dictate for voice input")}`);
1725: 
1726:             // Setting rows
1727:             for (let i = 0; i < rowDefs.length; i++) {
1728:               const row = rowDefs[i];
1729:               const selected = i === selectedRow;
1730:               const cursor = selected ? "→" : " ";
1731: 
1732:               if (row.id === "enabled") {
1733:                 const val = enabled ? "on" : "off";
1734:                 const left = selected ? "◂ " : "  ";
1735:                 const right = selected ? " ▸" : "";
1736:                 lines.push(`${cursor} TTS    ${left}${val}${right}`);
1737:               } else if (row.id === "voice") {
1738:                 const val = voices[voiceIdx] ?? "";
1739:                 const hint = voiceHint(val);
1740:                 const left = selected ? "◂ " : "  ";
1741:                 const right = selected ? " ▸" : "";
1742:                 lines.push(
1743:                   `${cursor} Voice  ${left}${val}${right} ${theme.fg("dim", `(${hint})`)}`,
1744:                 );
1745:               } else if (row.id === "speed") {
1746:                 const val = SPEED_VALUES[speedIdx];
1747:                 const left = selected ? "◂ " : "  ";
1748:                 const right = selected ? " ▸" : "";
1749:                 lines.push(`${cursor} Speed  ${left}${val}${right}`);
1750:               }
1751:             }
1752: 
1753:             lines.push("");
1754: 
1755:             if (playing) {
1756:               lines.push(`  ${theme.fg("warning", "▶ Playing sample…")}`);
1757:             } else if (playError) {
1758:               lines.push(`  ${theme.fg("error", `✗ ${playError}`)}`);
1759:             } else if (feedback) {
1760:               lines.push(`  ${theme.fg("success", feedback)}`);
1761:             }
1762: 
1763:             lines.push(
1764:               theme.fg("dim", " ↑↓ navigate • ←→ change • s save default • r reset • esc close"),
1765:             );
1766: 
1767:             return lines;
1768:           },
1769:           invalidate() {},
1770:           handleInput(data: string) {
1771:             if (matchesKey(data, "escape")) {
1772:               persistSession();
1773:               done(undefined);
1774:               return;
1775:             }
1776: 
1777:             if (playError) playError = null;
1778:             if (feedback) feedback = null;
1779: 
1780:             if (playing) return;
1781: 
1782:             if (matchesKey(data, "s")) {
1783:               const voice = voices.length > 0 ? voices[voiceIdx] : defaults.voice;
1784:               const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
1785:               defaults = { ...defaults, enabled, voice, speed };
1786:               saveConfig(defaults);
1787:               feedback = "✓ Saved as default";
1788:               _tui.requestRender();
1789:               return;
1790:             }
1791: 
1792:             if (matchesKey(data, "r")) {
1793:               session = {};
1794:               // Write full defaults (including agent_end event) back to disk
1795:               saveConfig({ ...DEFAULT_CONFIG });
1796:               defaults = loadConfig();
1797:               persistSession();
1798:               enabled = defaults.enabled;
1799:               voiceIdx = voices.length > 0 ? Math.max(0, voices.indexOf(defaults.voice)) : -1;
1800:               speedIdx = speedToIndex(defaults.speed);
1801:               emitConfig();
1802:               feedback = "✓ Reset to defaults";
1803:               _tui.requestRender();
1804:               return;
1805:             }
1806: 
1807:             if (matchesKey(data, "up")) {
1808:               selectedRow = (selectedRow - 1 + rowDefs.length) % rowDefs.length;
1809:               _tui.requestRender();
1810:               return;
1811:             }
1812:             if (matchesKey(data, "down")) {
1813:               selectedRow = (selectedRow + 1) % rowDefs.length;
1814:               _tui.requestRender();
1815:               return;
1816:             }
1817: 
1818:             const rowId = rowDefs[selectedRow]?.id;
1819: 
1820:             if (matchesKey(data, "left") || matchesKey(data, "right")) {
1821:               const dir = matchesKey(data, "right") ? 1 : -1;
1822:               if (rowId === "enabled") {
1823:                 enabled = !enabled;
1824:                 session.enabled = enabled;
1825:               } else if (rowId === "voice" && voices.length > 0) {
1826:                 voiceIdx = (voiceIdx + dir + voices.length) % voices.length;
1827:                 session.voice = voices[voiceIdx];
1828:               } else if (rowId === "speed") {
1829:                 speedIdx = (speedIdx + dir + SPEED_VALUES.length) % SPEED_VALUES.length;
1830:                 const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
1831:                 session.speed = speed;
1832:               }
1833:               persistSession();
1834:               emitConfig();
1835:               _tui.requestRender();
1836:               return;
1837:             }
1838: 
1839:             if (matchesKey(data, "enter")) {
1840:               playing = true;
1841:               playError = null;
1842:               _tui.requestRender();
1843:               playSampleTts()
1844:                 .then(() => {
1845:                   playing = false;
1846:                   _tui.requestRender();
1847:                 })
1848:                 .catch((err: unknown) => {
1849:                   playing = false;
1850:                   playError = err instanceof Error ? err.message : String(err);
1851:                   _tui.requestRender();
1852:                 });
1853:               return;
1854:             }
1855:           },
1856:         };
1857:       });
1858:     },
1859:   });
1860: 
1861:   pi.registerCommand("voice-debug", {
1862:     description: "Show pi-voice runtime config and backend status",
1863:     handler: async (_args, ctx) => {
1864:       defaults = loadConfig();
1865:       const effective = getEffective();
1866:       const health = await fetchHealth(effective);
1867:       const remote = remoteConfig(effective);
1868:       const stt = sttConfig(effective);
1869:       const player = streamingPcmPlayer();
1870:       const events = effective.events ? Object.keys(effective.events) : [];
1871:       const configExists = existsSync(CONFIG_PATH);
1872:       const configBytes = configExists ? readFileSync(CONFIG_PATH, "utf-8").length : 0;
1873: 
1874:       await ctx.ui.custom(
1875:         (_tui, theme, _kb, done) => ({
1876:           render() {
1877:             const lines = [
1878:               theme.bold("pi-voice debug"),
1879:               "",
1880:               `runtime config: ${CONFIG_PATH}`,
1881:               `runtime config exists: ${configExists ? "yes" : "no"}${configExists ? ` (${configBytes} bytes)` : ""}`,
1882:               `debug log: ${DEBUG_LOG_PATH}`,
1883:               "template config: config/voice-config.example.json (copy manually or via scripts/install-server-macos.sh)",
1884:               "",
1885:               `enabled: ${effective.enabled}`,
1886:               `backend: ${effective.backend}`,
1887:               `voice: ${effective.voice}`,
1888:               `speed: ${effective.speed}`,
1889:               `local url: http://${effective.host}:${effective.port}`,
1890:               `remote url: ${remote.baseUrl}`,
1891:               `remote auth token: ${remote.authToken.trim() ? "configured" : "not configured"}`,
1892:               `remote speech path: ${remote.speechPath}`,
1893:               `remote stream path: ${remote.streamPath}`,
1894:               `remote stream: ${remote.stream} (${remote.streamFormat})`,
1895:               `remote chunk fallback: ${remote.chunkText} (${remote.chunkMaxChars} chars)`,
1896:               `streaming player: ${player ? player.command : "none; using chunked WAV fallback"}`,
1897:               `stt: ${stt.enabled ? "enabled" : "disabled"} (${sttStatus})`,
1898:               `stt model dir: ${stt.modelDir}`,
1899:               `stt language: ${stt.language ?? "auto"}`,
1900:               `stt audio cues: ${stt.audioCues ? "enabled" : "disabled"}`,
1901:               `events: ${events.length ? events.join(", ") : "none"}`,
1902:               `footer status: ${statusLine(effective)}`,
1903:               "",
1904:               `health: ${health ? `${health.status} modelLoaded=${health.modelLoaded} active=${health.activeDtype}` : "offline"}`,
1905:               "",
1906:               theme.fg("dim", "esc/enter closes"),
1907:             ];
1908:             if (effective.backend === "local" && effective.remote) {
1909:               lines.splice(8, 0, theme.fg("warning", "remote block is configured but inactive because backend is local"));
1910:             }
1911:             return lines;
1912:           },
1913:           invalidate() {},
1914:           handleInput(data: string) {
1915:             if (matchesKey(data, "escape") || matchesKey(data, "enter")) done(undefined);
1916:           },
1917:         }),
1918:         { overlay: true },
1919:       );
1920:     },
1921:   });
1922: 
1923:   pi.registerCommand("voice-log", {
1924:     description: "Show recent pi-voice debug log lines",
1925:     handler: async (_args, ctx) => {
1926:       const lines = readDebugLogTail(40);
1927:       await ctx.ui.custom(
1928:         (_tui, theme, _kb, done) => ({
1929:           render() {

(Showing lines 1600-1929 of 2121. Use offset=1930 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts",
  "offset": 380,
  "limit": 125
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/extensions/server.ts</path>
<type>file</type>
<content>
380:     if (!tts) {
381:       json(res, { message: "No model loaded" });
382:       return;
383:     }
384:     await unloadModel();
385:     json(res, { message: "Model unloaded" });
386:   } catch (err) {
387:     console.error("[pi-voice] Unload error:", err);
388:     json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
389:   }
390: }
391: 
392: // ── TTS request queue (serializes /tts calls — one synthesis at a time) ────
393: let ttsQueueTail: Promise<void> = Promise.resolve();
394: let ttsQueueDepth = 0;
395: 
396: function enqueueTTS<T>(
397:   label: string,
398:   _req: IncomingMessage,
399:   res: ServerResponse,
400:   fn: () => Promise<T>,
401: ): Promise<T> {
402:   ttsQueueDepth++;
403:   const depth = ttsQueueDepth;
404:   console.log(`[pi-voice] Queue: enqueued "${label}" (depth=${depth})`);
405: 
406:   // Track real client disconnect via the response close event.
407:   // Note: req.destroyed is always true after readBody() consumes the stream,
408:   // so it cannot be used to detect actual disconnects.
409:   let disconnected = false;
410:   const onClose = () => {
411:     disconnected = true;
412:   };
413:   res.on("close", onClose);
414: 
415:   return new Promise<T>((resolve, reject) => {
416:     ttsQueueTail = ttsQueueTail.then(async () => {
417:       ttsQueueDepth--;
418:       res.removeListener("close", onClose);
419: 
420:       // Client disconnected while waiting — skip synthesis
421:       if (disconnected) {
422:         console.log(`[pi-voice] Queue: skipping "${label}" (client disconnected)`);
423:         reject(new Error("Client disconnected"));
424:         return;
425:       }
426: 
427:       console.log(`[pi-voice] Queue: processing "${label}"`);
428:       try {
429:         resolve(await fn());
430:       } catch (err) {
431:         reject(err);
432:       }
433:     });
434:   });
435: }
436: 
437: async function handleTTS(req: IncomingMessage, res: ServerResponse) {
438:   try {
439:     // Read the body outside the queue so the request is fully consumed
440:     // before entering the queue (avoids hanging on slow clients).
441:     const rawBody = await readBody(req);
442:     const body = JSON.parse(rawBody);
443:     const text = (body.text as string | undefined)?.trim();
444:     const label = text ? `"${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"` : "(empty)";
445: 
446:     const result = await enqueueTTS(label, req, res, async () => {
447:       if (!tts || !activeDtype) {
448:         return {
449:           error: "No model loaded. Download and activate a model first.",
450:           status: 503,
451:         } as const;
452:       }
453: 
454:       if (!text) {
455:         return { error: "Missing or empty 'text' field", status: 400 } as const;
456:       }
457: 
458:       const voice = (body.voice as string) || "af_heart";
459:       const speed = Number(body.speed ?? 1.0);
460: 
461:       console.log(
462:         `[pi-voice] Synthesizing: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}" (voice=${voice}, speed=${speed}, dtype=${activeDtype})`,
463:       );
464: 
465:       const audio = await tts.generate(text, {
466:         voice: voice as keyof typeof tts.voices,
467:         speed,
468:       });
469:       const samples = audio.audio as Float32Array;
470:       const sampleRate = audio.sampling_rate;
471:       return { wav: float32ToWav(samples, sampleRate) } as const;
472:     });
473: 
474:     if ("error" in result) {
475:       json(res, { error: result.error }, result.status);
476:     } else {
477:       res.writeHead(200, {
478:         "Content-Type": "audio/wav",
479:         "Content-Length": result.wav.length,
480:       });
481:       res.end(result.wav);
482:     }
483:   } catch (err) {
484:     // Don't log client disconnect as an error — it's expected behavior
485:     if (err instanceof Error && err.message === "Client disconnected") {
486:       return;
487:     }
488:     console.error("[pi-voice] TTS error:", err);
489:     if (!res.headersSent) {
490:       json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
491:     }
492:   }
493: }
494: 
495: function handleShutdown(req: IncomingMessage, res: ServerResponse) {
496:   json(res, { status: "shutting down" });
497:   console.log("[pi-voice] Shutdown requested");
498:   req.socket.destroy();
499:   process.exit(0);
500: }
501: 
502: // ── WAV encoder (Float32 → 16-bit PCM) ────────────────────────────
503: function float32ToWav(samples: Float32Array, sampleRate: number): Buffer {
504:   const numChannels = 1;

(Showing lines 380-504 of 584. Use offset=505 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js",
  "offset": 250,
  "limit": 100
}
```

**Output:**
```
<path>/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js</path>
<type>file</type>
<content>
250:                 acceptingOutput = false;
251:                 output.finish();
252:                 clearUpdateTimer();
253:                 emitOutputUpdate();
254:                 const snapshot = output.snapshot({ persistIfTruncated: true });
255:                 await output.closeTempFile();
256:                 return snapshot;
257:             };
258:             const formatOutput = (snapshot, emptyText = "(no output)") => {
259:                 const truncation = snapshot.truncation;
260:                 let text = snapshot.content || emptyText;
261:                 let details;
262:                 if (truncation.truncated) {
263:                     details = { truncation, fullOutputPath: snapshot.fullOutputPath };
264:                     const startLine = truncation.totalLines - truncation.outputLines + 1;
265:                     const endLine = truncation.totalLines;
266:                     if (truncation.lastLinePartial) {
267:                         const lastLineSize = formatSize(output.getLastLineBytes());
268:                         text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
269:                     }
270:                     else if (truncation.truncatedBy === "lines") {
271:                         text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
272:                     }
273:                     else {
274:                         text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
275:                     }
276:                 }
277:                 return { text, details };
278:             };
279:             const appendStatus = (text, status) => `${text ? `${text}\n\n` : ""}${status}`;
280:             try {
281:                 let exitCode;
282:                 try {
283:                     const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
284:                         onData: handleData,
285:                         signal,
286:                         timeout,
287:                         env: spawnContext.env,
288:                     });
289:                     exitCode = result.exitCode;
290:                 }
291:                 catch (err) {
292:                     const snapshot = await finishOutput();
293:                     const { text } = formatOutput(snapshot, "");
294:                     if (err instanceof Error && err.message === "aborted") {
295:                         throw new Error(appendStatus(text, "Command aborted"));
296:                     }
297:                     if (err instanceof Error && err.message.startsWith("timeout:")) {
298:                         const timeoutSecs = err.message.split(":")[1];
299:                         throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
300:                     }
301:                     throw err;
302:                 }
303:                 const snapshot = await finishOutput();
304:                 const { text: outputText, details } = formatOutput(snapshot);
305:                 if (exitCode !== 0 && exitCode !== null) {
306:                     throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
307:                 }
308:                 return { content: [{ type: "text", text: outputText }], details };
309:             }
310:             finally {
311:                 clearUpdateTimer();
312:             }
313:         },
314:         renderCall(args, _theme, context) {
315:             const state = context.state;
316:             if (context.executionStarted && state.startedAt === undefined) {
317:                 state.startedAt = Date.now();
318:                 state.endedAt = undefined;
319:             }
320:             const text = context.lastComponent ?? new Text("", 0, 0);
321:             text.setText(formatBashCall(args));
322:             return text;
323:         },
324:         renderResult(result, options, _theme, context) {
325:             const state = context.state;
326:             if (state.startedAt !== undefined && options.isPartial && !state.interval) {
327:                 state.interval = setInterval(() => context.invalidate(), 1000);
328:             }
329:             if (!options.isPartial || context.isError) {
330:                 state.endedAt ??= Date.now();
331:                 if (state.interval) {
332:                     clearInterval(state.interval);
333:                     state.interval = undefined;
334:                 }
335:             }
336:             const component = context.lastComponent ?? new BashResultRenderComponent();
337:             rebuildBashResultRenderComponent(component, result, options, context.showImages, state.startedAt, state.endedAt);
338:             component.invalidate();
339:             return component;
340:         },
341:     };
342: }
343: export function createBashTool(cwd, options) {
344:     return wrapToolDefinition(createBashToolDefinition(cwd, options));
345: }
346: //# sourceMappingURL=bash.js.map

(End of file - total 346 lines)
</content>
```

**Tool: grep**

**Input:**
```json
{
  "pattern": "ToolExecution(Start|End)|MessageStartEvent|SessionShutdownEvent",
  "path": "/home/jesse/gh/my-pi/packages/pi-voice/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts"
}
```

**Error:**
```
Ripgrep JSON record exceeded 65536 bytes
```

---

## Assistant (Plan · GPT-5.6 Sol · 7.6s)

_Thinking:_

**Planning sequential build and status updates**

**Tool: todowrite**

**Input:**
```json
{
  "todos": [
    {
      "content": "Map pi-voice architecture, lifecycle events, queues, and configuration loading",
      "status": "completed",
      "priority": "high"
    },
    {
      "content": "Analyze existing text sanitization and code/tool-output handling",
      "status": "completed",
      "priority": "high"
    },
    {
      "content": "Design configurable queue interruption and pronunciation rule semantics",
      "status": "in_progress",
      "priority": "high"
    },
    {
      "content": "Produce implementation plan with tests, docs, and unresolved decisions",
      "status": "pending",
      "priority": "high"
    }
  ]
}
```

**Output:**
```
[
  {
    "content": "Map pi-voice architecture, lifecycle events, queues, and configuration loading",
    "status": "completed",
    "priority": "high"
  },
  {
    "content": "Analyze existing text sanitization and code/tool-output handling",
    "status": "completed",
    "priority": "high"
  },
  {
    "content": "Design configurable queue interruption and pronunciation rule semantics",
    "status": "in_progress",
    "priority": "high"
  },
  {
    "content": "Produce implementation plan with tests, docs, and unresolved decisions",
    "status": "pending",
    "priority": "high"
  }
]
```

---

## Assistant (Plan · GPT-5.6 Sol · 98.3s)

_Thinking:_

**Designing speech runtime scheduler**

_Thinking:_

**Configuring queue input handling**

_Thinking:_

**Defining cancellation end event**

_Thinking:_

**Updating server shutdown and speech processing**

_Thinking:_

**Refining event roles and pipeline order**

_Thinking:_

**Designing profile inheritance structure**

_Thinking:_

**Outlining technical mode behaviors and output handling**

_Thinking:_

**Planning fenced code block buffering**

_Thinking:_

**Designing stateful streaming buffer**

_Thinking:_

**Planning pronunciation config loading and validation**

_Thinking:_

**Planning config schema centralization**

_Thinking:_

**Refining config validation and test setup**

_Thinking:_

**Planning scheduler tests and documentation updates**

_Thinking:_

**Planning integration and test modules**

_Thinking:_

**Defining runtime process boundaries and module roles**

_Thinking:_

**Reviewing profile inheritance strategy**

_Thinking:_

**Clarifying built-in and custom profile structure**

_Thinking:_

**Evaluating prompt override options**

_Thinking:_

**Planning inline and promptFile support**

_Thinking:_

**Defining tool output transformations and voice event handling**

_Thinking:_

**Designing speech cancellation and scheduling logic**

_Thinking:_

**Refining TTS queue handling**

_Thinking:_

**Planning optional TTS queue skipping**

_Thinking:_

**Adding role filtering for tool outputs**

_Thinking:_

**Planning comprehensive design and task sequencing**

The submission-time choice needs one extra guard: after input cancels the old generation, late deltas/tool calls from that old turn must remain suppressed until Pi emits the next user `message_start`; otherwise stale work could enter the new queue under a fresh ID. Active local Kokoro inference cannot be preempted by its current API, but disconnecting will clear waiting stale requests and prevent stale playback; at most the one already-running synthesis must finish before the new request starts.

**Tool: todowrite**

**Input:**
```json
{
  "todos": [
    {
      "content": "Map pi-voice architecture, lifecycle events, queues, and configuration loading",
      "status": "completed",
      "priority": "high"
    },
    {
      "content": "Analyze existing text sanitization and code/tool-output handling",
      "status": "completed",
      "priority": "high"
    },
    {
      "content": "Design configurable queue interruption and pronunciation rule semantics",
      "status": "completed",
      "priority": "high"
    },
    {
      "content": "Produce implementation plan with tests, docs, and unresolved decisions",
      "status": "in_progress",
      "priority": "high"
    }
  ]
}
```

**Output:**
```
[
  {
    "content": "Map pi-voice architecture, lifecycle events, queues, and configuration loading",
    "status": "completed",
    "priority": "high"
  },
  {
    "content": "Analyze existing text sanitization and code/tool-output handling",
    "status": "completed",
    "priority": "high"
  },
  {
    "content": "Design configurable queue interruption and pronunciation rule semantics",
    "status": "completed",
    "priority": "high"
  },
  {
    "content": "Produce implementation plan with tests, docs, and unresolved decisions",
    "status": "in_progress",
    "priority": "high"
  }
]
```

---

## Assistant (Plan · GPT-5.6 Sol · 24.2s)

_Thinking:_

**Planning phased tool output parsing**

_Thinking:_

**Designing modular config with profiles**

_Thinking:_

**Refining path segment replacement rules**

_Thinking:_

**Planning path segmentation and processing architecture**

**Tool: todowrite**

**Input:**
```json
{
  "todos": [
    {
      "content": "Map pi-voice architecture, lifecycle events, queues, and configuration loading",
      "status": "completed",
      "priority": "high"
    },
    {
      "content": "Analyze existing text sanitization and code/tool-output handling",
      "status": "completed",
      "priority": "high"
    },
    {
      "content": "Design configurable queue interruption and pronunciation rule semantics",
      "status": "completed",
      "priority": "high"
    },
    {
      "content": "Produce implementation plan with tests, docs, and unresolved decisions",
      "status": "completed",
      "priority": "high"
    }
  ]
}
```

**Output:**
```
[
  {
    "content": "Map pi-voice architecture, lifecycle events, queues, and configuration loading",
    "status": "completed",
    "priority": "high"
  },
  {
    "content": "Analyze existing text sanitization and code/tool-output handling",
    "status": "completed",
    "priority": "high"
  },
  {
    "content": "Design configurable queue interruption and pronunciation rule semantics",
    "status": "completed",
    "priority": "high"
  },
  {
    "content": "Produce implementation plan with tests, docs, and unresolved decisions",
    "status": "completed",
    "priority": "high"
  }
]
```

---

## Assistant (Plan · GPT-5.6 Sol · 40.6s)

**Recommendation**

Split the work into three focused components rather than adding more conditions to `extensions/index.ts`:

- `config.ts`: validated configuration and pronunciation-file loading.
- `speech-text.ts`: pure technical text processing and pronunciation.
- `speech-runtime.ts`: FIFO scheduling, cancellation, and turn ownership.

Keep Pi event registration, model summarization, HTTP requests, and UI integration in `extensions/index.ts`.

**Current Causes**

- `message_end` accepts user, assistant, and `toolResult` messages without role filtering, so configured raw narration sends complete tool output: `extensions/index.ts:716`, `extensions/index.ts:2082`.
- Speech passes through independent `autoTTSTail`, `streamTail`, and `audioQueue` queues. None support cancellation or turn identity: `extensions/index.ts:825`, `extensions/index.ts:888`.
- Any fenced block in raw output causes the entire message to be rewritten by an LLM: `extensions/index.ts:1458`.
- The deterministic fallback discards everything except language and line count: `extensions/index.ts:406`.
- `prepareTextForSpeech()` is often applied before `speak()` and again inside it, which would make pronunciation replacements cascade: `extensions/index.ts:1372`, `extensions/index.ts:1432`, `extensions/index.ts:1998`.

## Proposed Configuration

```json
{
  "speech": {
    "queue": {
      "onUserInput": "interrupt",
      "inputSources": ["interactive", "rpc"]
    },
    "processing": {
      "defaultProfile": "monitor",
      "pronunciationFile": "pronunciations.json",
      "profiles": {
        "monitor": {
          "base": "technical",
          "limits": {
            "maxLines": 12,
            "maxChars": 1200
          },
          "code": {
            "shortMaxLines": 3,
            "shortMaxChars": 240,
            "longMode": "outline"
          },
          "toolOutput": {
            "headLines": 6,
            "tailLines": 4
          }
        },
        "monitorWithLlm": {
          "base": "technical",
          "code": {
            "longMode": "llm",
            "fallback": "outline"
          }
        }
      }
    }
  },
  "events": {
    "message_update": {
      "content": "thinking",
      "roles": ["assistant"],
      "profile": "monitor"
    },
    "message_end": {
      "content": "text",
      "roles": ["assistant", "toolResult"],
      "profile": "monitor"
    }
  }
}
```

Queue policies:

- `continue`: current behavior and backward-compatible default.
- `drop-pending`: finish the active utterance but discard older queued jobs.
- `interrupt`: discard pending jobs and stop active preparation, synthesis, and playback.

Users who do not want tool narration can set `roles` to only `["assistant"]`.

## 1. Turn-Aware Scheduler

Replace the three client-side queues with one scheduler owning jobs from preparation through playback.

Each job carries:

- Job and user-generation IDs.
- Source: `auto`, `tool`, or `sample`.
- Event, role, and tool metadata.
- One `AbortController`.
- State: queued, preparing, synthesizing, playing, completed, or cancelled.

Submission-time behavior:

1. `pi.on("input")` handles configured input sources.
2. `interrupt` invalidates the current generation, clears queued jobs, aborts the active job, and clears streaming buffers.
3. Late deltas and tool calls from the old turn remain suppressed.
4. The next user `message_start` activates a fresh generation.
5. New assistant speech is then accepted normally.

Cancellation must propagate through:

- Nested summary sessions via `session.abort()`.
- WAV and PCM `fetch()` calls.
- PCM readers and player stdin.
- Active `afplay`, `aplay`, `ffplay`, or `play` processes.
- Temporary WAV cleanup.
- The currently ignored TTS tool abort signal.

A cancelled job that emitted `voice:speak_start` should emit exactly one matching `voice:speak_end` with additive fields such as `cancelled: true` and `reason: "new-user-input"`. Jobs cancelled before starting speech emit neither event.

Session tree changes, shutdown, and disabling TTS should also cancel applicable jobs.

### Local Kokoro Limitation

An already-running `tts.generate()` cannot currently be preempted. Aborting its HTTP client can:

- Remove all waiting stale server requests.
- Prevent the stale result from being returned or played.
- Allow the newest request to run after the active generation finishes.

Actually terminating active inference would require moving Kokoro into a killable worker process, which is disproportionate for this improvement.

## 2. Technical Speech Pipeline

Process every utterance exactly once:

1. Select content using event and role filters.
2. Parse Markdown into typed segments.
3. Transform code and tool output.
4. Optionally summarize selected long technical segments.
5. Apply pronunciation rules.
6. Split on semantic boundaries.
7. Send chunks to synthesis.

Suggested segment kinds include prose, inline code, code block, command, path, URL, error, and opaque token. Preserve raw and cleaned forms so deterministic fallbacks never lose the original information.

### Code Blocks

Preserve surrounding prose verbatim instead of summarizing the entire response.

Deterministic handling:

- Short shell blocks: announce and speak bounded commands.
- Long shell blocks: list the first important commands and report omitted count.
- TypeScript/Python/etc.: announce declarations such as functions, classes, interfaces, and important calls.
- JSON/YAML: announce top-level keys and selected scalar values.
- Diffs: announce affected files and addition/removal counts.
- Unknown code: provide language, useful first lines, and omitted count.

For example, prefer:

> “The TypeScript block defines `add`, which accepts two numbers and returns their sum.”

over:

> “The output contains a TypeScript block with three lines.”

### Tool Output

Track `tool_execution_start` arguments by tool-call ID, then combine them with `toolResult` metadata.

Provide bounded deterministic treatment for common tools:

- `bash`: command, success/error state, important output tail.
- `read`: file and range, followed by a source outline or short excerpt.
- `grep`: match count, distinct files, and a few representative matches.
- `find`/`ls`: result count and sample paths.
- Unknown tools: bounded head/tail with omitted line count.
- Errors: retain more exact detail than successful output.

Normalize obviously unsuitable tokens:

- Convert byte counts to spoken kilobytes or megabytes.
- Replace UUIDs, long hashes, base64 blobs, and high-entropy values with a descriptor plus a short distinguishing prefix/suffix.
- Collapse repeated lines or identifiers and report their count.
- Preserve normal identifiers, commands, paths, statuses, and error messages.

### Optional LLM Mode

Keep existing explicit `{prompt, model}` behavior as whole-message summarization.

For profile-based technical summaries:

- Send only long technical segments, not surrounding prose.
- Batch all selected segments into one model request.
- Require IDs in the response so summaries can be reinserted correctly.
- Fall back to deterministic outlines on model failure.
- Do not invoke fallback after intentional cancellation.

## 3. Pronunciation Rules

Load `${PI_VOICE_DIR}/pronunciations.json`, or a configured path relative to `PI_VOICE_DIR`.

```json
{
  "version": 1,
  "rules": [
    {
      "match": "ctl",
      "replace": " control",
      "mode": "suffix",
      "scope": {
        "kinds": ["prose", "inlineCode", "command"]
      }
    },
    {
      "match": "~",
      "replace": "home",
      "mode": "pathSegment",
      "scope": {
        "kinds": ["path"]
      }
    },
    {
      "match": "etc",
      "replace": "etsy",
      "mode": "pathSegment",
      "scope": {
        "kinds": ["path"]
      }
    }
  ]
}
```

Recommended rule semantics:

- Modes: `word` default, `prefix`, `suffix`, `pathSegment`, and explicitly unsafe `literal`.
- Scope fields: source, event, role, segment kind, tool, code language, and spoken language.
- Scope fields combine with AND; values within a field combine with OR.
- Match against original text and construct output once, preventing replacements from matching other replacements.
- Resolve overlaps by longest match, then file order.
- Do not support arbitrary JavaScript regex initially. Literal/token modes cover the examples without exposing catastrophic-regex behavior.
- Validate files before activation and retain the last valid rules if reload fails.
- Reload on session start and through a new `/voice-reload` command.

## Implementation Sequence

1. Isolate tests from real `~/.pi/voice/config.json`; current event tests modify the user’s live config.
2. Add validated config normalization while preserving unknown keys such as `defaultModel` when `/voice` saves.
3. Introduce `speech-runtime.ts` and route all auto/tool/sample speech through one scheduler.
4. Add submission-time cancellation, generation suppression, process/fetch aborting, and lifecycle cleanup.
5. Add pure `speech-text.ts` segmentation, technical profiles, tool metadata, opaque-token handling, and semantic chunking.
6. Add external scoped pronunciation rules.
7. Update `README.md`, `voice-config.example.json`, add `pronunciations.example.json`, and document the active-local-inference limitation.
8. Add all test files to the package test script and run tests, typecheck, and lint.

Highest-value tests are FIFO compatibility, interruption during every asynchronous phase, stale post-input events, no overlapping playback, code/tool golden outputs, role filtering, non-cascading pronunciation, malformed configuration, and cancellation event pairing.

No files were changed during this planning pass.

---

