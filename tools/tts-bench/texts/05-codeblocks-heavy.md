The following response contains multiple code blocks and command snippets. It is designed to represent a worst-case narration input for code-heavy assistant answers.

```bash
PI_VOICE_MODEL=q8 PI_VOICE_PORT=8181 scripts/start-pi-voice-server.sh
```

```json
{
  "enabled": true,
  "voice": "af_heart",
  "speed": 1.0,
  "events": {
    "message_end": {
      "content": "thinking",
      "prompt": "Prepare a concise spoken version of the assistant reasoning. Plain text only."
    },
    "agent_end": {
      "content": "text"
    }
  }
}
```

```ts
pi.on("message_update", async (event, ctx) => {
  if (event.assistantMessageEvent.type !== "text_delta") return;
  buffer += event.assistantMessageEvent.delta;
  flushSentenceSizedChunksWhenReady(buffer);
});
```

A good TTS pipeline should turn this into a short explanation of the server command, voice configuration, and streamed delta handler.
