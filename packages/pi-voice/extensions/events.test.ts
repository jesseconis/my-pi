/**
 * Unit tests for the pi-voice event system (PRD.md).
 *
 * Tests that the extension emits events on pi.events.emit() per spec:
 *   - voice:config       — on any settings change (TUI toggle, voice, speed, reset, alt+v)
 *   - voice:speak_start  — before TTS synthesis
 *   - voice:speak_end    — after playback (success or error)
 *
 * The extension exports a default factory function(pi). We mock the full
 * pi API, call through the factory, then trigger actions via the captured
 * registrations.
 *
 * Note: Each mock pi has its own _emitted array to prevent cross-test
 * leakage from fire-and-forget speak() callbacks still running from
 * previous tests.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import extensionFactory, {
  containsFencedCodeBlock,
  prepareTextForSpeech,
} from "./index.ts";

// ── Constants ──────────────────────────────────────────────────────

const CONFIG_DIR = resolve(homedir(), ".pi", "voice");
const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
const KEY_ESCAPE = "\x1b";
const KEY_ENTER = "\r";
const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const _KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_R = "r";

/** Wait time for afplay to start, play, and callback to fire (~850ms observed). */
const PLAYBACK_SETTLE = 1200;

// ── Types (mirror PRD interfaces for assertions) ───────────────────

interface VoiceConfigEvent {
  enabled: boolean;
  voice: string;
  speed: number;
}

type VoiceSpeakSource = "tool" | "auto" | "sample";

interface VoiceSpeakStartEvent {
  text: string;
  voice: string;
  speed: number;
  source: VoiceSpeakSource;
}

interface VoiceSpeakEndEvent {
  text: string;
  source: VoiceSpeakSource;
  error?: string;
}

// ── Config backup / restore ────────────────────────────────────────

let configBackup: string | null = null;

function backupConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      configBackup = readFileSync(CONFIG_PATH, "utf-8");
    } else {
      configBackup = null;
    }
  } catch {
    configBackup = null;
  }
}

function restoreConfig() {
  try {
    if (configBackup !== null) {
      writeFileSync(CONFIG_PATH, configBackup);
    } else {
      try {
        unlinkSync(CONFIG_PATH);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* best effort */
  }
}

/** Write a clean test config without event model (avoids real model lookup). */
function writeTestConfig(overrides: Record<string, unknown> = {}) {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        enabled: true,
        voice: "af_heart",
        speed: 1.0,
        events: {
          agent_end: { prompt: "Summarize in one sentence." },
        },
        ...overrides,
      },
      null,
      2,
    ),
  );
}

// ── Valid WAV buffer ───────────────────────────────────────────────

/** Minimal valid WAV that afplay/aplay can play (1 sample of silence at 44100Hz). */
function createValidWav(): ArrayBuffer {
  const buf = new ArrayBuffer(46);
  const v = new DataView(buf);
  // RIFF header
  v.setUint32(0, 0x52494646, false); // "RIFF"
  v.setUint32(4, 38, true); // file size - 8
  v.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt chunk
  v.setUint32(12, 0x666d7420, false); // "fmt "
  v.setUint32(16, 16, true); // chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 44100, true); // sample rate
  v.setUint32(28, 88200, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  // data chunk
  v.setUint32(36, 0x64617461, false); // "data"
  v.setUint32(40, 2, true); // data size
  v.setInt16(44, 0, true); // silence
  return buf;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const lowerName = name.toLowerCase();
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === lowerName)?.[1] ?? null;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1] ?? null;
}

// ── Mock infrastructure ────────────────────────────────────────────

/** Registered commands, tools, shortcuts, event handlers. */
// biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
let commands: Record<string, { handler: (...args: any[]) => Promise<any> }>;
// biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
let tools: Record<string, { execute: (...args: any[]) => Promise<any> }>;
// biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
let shortcuts: Record<string, { handler: (ctx: any) => Promise<void> }>;
// biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
let piEventHandlers: Record<string, (...args: any[]) => Promise<void>>;

/** Captured TUI component from /voice command. */
let tuiComponent: {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  invalidate: () => void;
} | null;
let tuiDone: ((result: unknown) => void) | null;
let tuiPromise: Promise<unknown> | null;

const originalFetch = globalThis.fetch;

/**
 * Build a mock pi with its own _emitted array.
 * Each test gets a fresh mock, so old fire-and-forget callbacks
 * from previous tests don't leak events.
 */
function createMockPi() {
  const _emitted: Array<{ event: string; data: unknown }> = [];
  const _entries: Array<{ customType: string; data: unknown }> = [];

  commands = {};
  tools = {};
  shortcuts = {};
  piEventHandlers = {};
  tuiComponent = null;
  tuiDone = null;
  tuiPromise = null;

  return {
    _emitted,
    _entries,
    events: {
      emit(event: string, data: unknown) {
        _emitted.push({ event, data });
      },
      on() {
        return () => {};
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
    registerCommand(name: string, config: { handler: (...args: any[]) => Promise<any> }) {
      commands[name] = config;
    },
    registerTool(config: Record<string, unknown>) {
      // biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
      tools[config.name as string] = config as any;
    },
    // biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
    registerShortcut(key: string, config: { handler: (ctx: any) => Promise<void> }) {
      shortcuts[key] = config;
    },
    // biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
    on(event: string, handler: (...args: any[]) => Promise<void>) {
      piEventHandlers[event] = handler;
    },
    appendEntry(customType: string, data: unknown) {
      _entries.push({ customType, data });
    },
  };
}

/** Mock fetch to return canned server responses. */
function mockFetch(responses?: {
  health?: Record<string, unknown>;
  voices?: string[];
  ttsOk?: boolean;
}) {
  const healthResponse = responses?.health ?? {
    status: "ok",
    activeDtype: "q4",
    modelLoaded: true,
    loading: false,
  };
  const voicesResponse = responses?.voices ?? ["af_heart", "af_alloy", "bf_emma"];
  const ttsOk = responses?.ttsOk ?? true;

  // biome-ignore lint/suspicious/noExplicitAny: mock fetch accepts any input
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.endsWith("/health")) {
      return new Response(JSON.stringify(healthResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/voices")) {
      return new Response(JSON.stringify({ voices: voicesResponse }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/tts")) {
      if (!ttsOk) {
        return new Response(JSON.stringify({ error: "Server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(createValidWav(), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }) as typeof fetch;
}

/** Build a mock ExtensionContext. */
function createMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    ui: {
      // biome-ignore lint/suspicious/noExplicitAny: mock factory is intentionally any
      async custom(factory: any) {
        tuiPromise = new Promise((resolve) => {
          tuiDone = resolve;
        });
        const mockTui = { requestRender() {} };
        const mockTheme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };
        const mockKb = {};
        tuiComponent = factory(mockTui, mockTheme, mockKb, (result: unknown) => {
          tuiDone?.(result);
        });
        return tuiPromise;
      },
      notify() {},
    },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => null },
    model: undefined,
    ...overrides,
  };
}

/** Helper: filter emitted events by name for a specific mock pi. */
// biome-ignore lint/suspicious/noExplicitAny: mock pi is intentionally any
function getEvents(pi: any, name: string): Array<{ event: string; data: unknown }> {
  // biome-ignore lint/suspicious/noExplicitAny: filter callback uses any for flexibility
  return pi._emitted.filter((e: any) => e.event === name);
}

// ── Test suite ─────────────────────────────────────────────────────

describe("pi-voice event system", () => {
  beforeEach(() => {
    backupConfig();
    writeTestConfig();
    mockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreConfig();
    tuiComponent = null;
    tuiDone = null;
    tuiPromise = null;
  });

  // ── voice:config ───────────────────────────────────────────────

  describe("voice:config", () => {
    it("emits when TTS is toggled via /voice TUI", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_LEFT);
      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;

      const events = getEvents(pi, "voice:config");
      assert.ok(events.length >= 1, `Expected voice:config, got ${events.length}`);

      const payload = events[0].data as VoiceConfigEvent;
      assert.equal(typeof payload.enabled, "boolean");
      assert.equal(typeof payload.voice, "string");
      assert.equal(typeof payload.speed, "number");
    });

    it("emits when voice is changed via /voice TUI", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_DOWN);
      tuiComponent.handleInput(KEY_RIGHT);
      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;

      const events = getEvents(pi, "voice:config");
      assert.ok(events.length >= 1);
    });

    it("emits when speed is changed via /voice TUI", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_DOWN);
      tuiComponent.handleInput(KEY_DOWN);
      tuiComponent.handleInput(KEY_RIGHT);
      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;

      const events = getEvents(pi, "voice:config");
      assert.ok(events.length >= 1);
    });

    it("emits when settings are reset via /voice TUI", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_R);
      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;

      const events = getEvents(pi, "voice:config");
      assert.ok(events.length >= 1, "Reset should emit voice:config");
    });
  });

  // ── alt+v keybind ──────────────────────────────────────────────

  describe("alt+v keybind", () => {
    it("emits voice:config when toggling TTS", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await shortcuts["alt+v"].handler(createMockCtx());

      const events = getEvents(pi, "voice:config");
      assert.equal(events.length, 1);

      const payload = events[0].data as VoiceConfigEvent;
      assert.equal(typeof payload.enabled, "boolean");
      assert.equal(typeof payload.voice, "string");
      assert.equal(typeof payload.speed, "number");
    });

    it("toggles enabled state (on → off → on)", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await shortcuts["alt+v"].handler(createMockCtx());
      const first = getEvents(pi, "voice:config")[0].data as VoiceConfigEvent;
      assert.equal(first.enabled, false, "First toggle should disable");

      await shortcuts["alt+v"].handler(createMockCtx());
      const second = getEvents(pi, "voice:config")[1].data as VoiceConfigEvent;
      assert.equal(second.enabled, true, "Second toggle should enable");
    });

    it("persists toggle to session state", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await shortcuts["alt+v"].handler(createMockCtx());

      assert.deepEqual(pi._entries.at(-1), {
        customType: "voice-session",
        data: { enabled: false },
      });
    });

    it("voice:config payload has exactly { enabled, voice, speed }", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await shortcuts["alt+v"].handler(createMockCtx());

      const payload = getEvents(pi, "voice:config")[0].data as VoiceConfigEvent;
      const keys = Object.keys(payload).sort();
      assert.deepEqual(keys, ["enabled", "speed", "voice"]);
    });
  });

  describe("dictation", () => {
    it("registers manual STT command", () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      assert.ok(commands.dictate, "/dictate command should be registered");
    });

    it("does not start STT when disabled", async () => {
      writeTestConfig({ stt: { enabled: false } });
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const notifications: string[] = [];
      await commands.dictate.handler(
        [],
        createMockCtx({
          ui: {
            notify(message: string) {
              notifications.push(message);
            },
            async custom() {
              throw new Error("STT overlay should not open when disabled");
            },
          },
        }),
      );

      assert.equal(notifications.length, 1);
      assert.match(notifications[0], /STT is disabled/);
    });
  });

  // ── voice:speak_start ──────────────────────────────────────────

  describe("voice:speak_start", () => {
    it("emits with source: tool when tts tool is invoked", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Hello" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 50));

      const events = getEvents(pi, "voice:speak_start");
      assert.ok(events.length >= 1);

      const payload = events[0].data as VoiceSpeakStartEvent;
      assert.equal(payload.text, "Hello");
      assert.equal(payload.source, "tool");
      assert.equal(typeof payload.voice, "string");
      assert.equal(typeof payload.speed, "number");
    });

    it("does NOT emit speak_start when TTS is disabled", async () => {
      writeTestConfig({ enabled: false });
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Muted" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 50));

      const events = getEvents(pi, "voice:speak_start");
      assert.equal(events.length, 0, "Should not emit speak_start when disabled");
    });

    it("emits with source: sample for TUI playSampleTts", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_ENTER);
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const events = getEvents(pi, "voice:speak_start");
      assert.ok(events.length >= 1);
      assert.equal((events[0].data as VoiceSpeakStartEvent).source, "sample");

      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;
    });

    it("payload matches VoiceSpeakStartEvent interface", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Check" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 50));

      const payload = getEvents(pi, "voice:speak_start")[0].data as VoiceSpeakStartEvent;
      const keys = Object.keys(payload).sort();
      assert.deepEqual(keys, ["source", "speed", "text", "voice"]);
    });

    it("sanitizes markdown before speaking manual tts text", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute(
        "tc_1",
        { text: "***note*** Run `npm test` before shipping." },
        undefined,
        undefined,
        createMockCtx(),
      );
      await new Promise((r) => setTimeout(r, 50));

      const payload = getEvents(pi, "voice:speak_start")[0].data as VoiceSpeakStartEvent;
      assert.equal(payload.text, "note Run npm test before shipping.");
    });
  });

  // ── voice:speak_end ────────────────────────────────────────────

  describe("voice:speak_end", () => {
    it("emits after successful playback with no error field", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Works" }, undefined, undefined, createMockCtx());
      // Wait for: fetch → write WAV → exec afplay → callback
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const events = getEvents(pi, "voice:speak_end");
      assert.ok(events.length >= 1, `Expected voice:speak_end, got ${events.length}`);

      const payload = events[0].data as VoiceSpeakEndEvent;
      assert.equal(payload.text, "Works");
      assert.equal(payload.source, "tool");
      assert.equal("error" in payload, false, "Successful speak_end should not have error field");
    });

    it("emits with error field on TTS server failure", async () => {
      globalThis.fetch = originalFetch;
      mockFetch({ ttsOk: false });

      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Fails" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 100));

      const events = getEvents(pi, "voice:speak_end");
      assert.ok(events.length >= 1);

      const payload = events[0].data as VoiceSpeakEndEvent;
      assert.equal(payload.source, "tool");
      assert.ok(payload.error, "Should have error field on failure");
      assert.equal(typeof payload.error, "string");
    });

    it("payload has text + source at minimum", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Shape" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const payload = getEvents(pi, "voice:speak_end")[0].data as VoiceSpeakEndEvent;
      assert.ok("text" in payload, "Should have text");
      assert.ok("source" in payload, "Should have source");
    });
  });

  describe("remote backend", () => {
    it("posts OpenAI-compatible speech requests when backend is remote", async () => {
      writeTestConfig({
        backend: "remote",
        remote: {
          baseUrl: "http://remote.test:8880",
          stream: false,
          chunkText: false,
        },
      });

      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      // biome-ignore lint/suspicious/noExplicitAny: mock fetch accepts any input
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/v1/audio/speech")) {
          requests.push({
            url,
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          });
          return new Response(createValidWav(), {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          });
        }
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Remote works" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "http://remote.test:8880/v1/audio/speech");
      assert.equal(requests[0].body.input, "Remote works");
      assert.equal(requests[0].body.voice, "af_heart");
      assert.equal(requests[0].body.response_format, "wav");
    });

    it("sends bearer auth token when configured", async () => {
      writeTestConfig({
        backend: "remote",
        remote: {
          baseUrl: "http://remote.test:8880",
          authToken: "test-token",
          stream: false,
          chunkText: false,
        },
      });

      const requests: Array<{ url: string; headers: HeadersInit | undefined }> = [];
      // biome-ignore lint/suspicious/noExplicitAny: mock fetch accepts any input
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/v1/audio/speech")) {
          requests.push({ url, headers: init?.headers });
          return new Response(createValidWav(), {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          });
        }
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Remote auth works" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "http://remote.test:8880/v1/audio/speech");
      assert.equal(headerValue(requests[0].headers, "authorization"), "Bearer test-token");
    });
  });

  // ── source field ───────────────────────────────────────────────

  describe("source field", () => {
    it('"tool" from tts tool', async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Src" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 50));

      const events = getEvents(pi, "voice:speak_start");
      if (events.length > 0) {
        assert.equal((events[0].data as VoiceSpeakStartEvent).source, "tool");
      }
    });

    it('"sample" from TUI playSampleTts', async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_ENTER);
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const events = getEvents(pi, "voice:speak_start");
      if (events.length > 0) {
        assert.equal((events[0].data as VoiceSpeakStartEvent).source, "sample");
      }

      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;
    });
  });

  // ── paired lifecycle ───────────────────────────────────────────

  describe("speak_start / speak_end pairing", () => {
    it("every speak_start has a corresponding speak_end", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Pair" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const starts = getEvents(pi, "voice:speak_start").length;
      const ends = getEvents(pi, "voice:speak_end").length;
      assert.equal(ends, starts, "speak_end count should match speak_start count");
    });
  });

  describe("auto-TTS ordering", () => {
    it("speaks streaming thinking before message_end final text", async () => {
      writeTestConfig({
        events: {
          message_update: { content: "thinking" },
          message_end: { content: "text" },
        },
      });

      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const updateHandler = piEventHandlers.message_update;
      const endHandler = piEventHandlers.message_end;
      assert.ok(updateHandler, "message_update handler should be registered");
      assert.ok(endHandler, "message_end handler should be registered");

      await updateHandler({ assistantMessageEvent: { type: "thinking_delta", delta: "Reasoning first." } });
      await updateHandler({ assistantMessageEvent: { type: "thinking_end" } });
      await endHandler(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Final answer last." }],
          },
        },
        createMockCtx(),
      );
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE * 2));

      const starts = getEvents(pi, "voice:speak_start").map(
        (event) => (event.data as VoiceSpeakStartEvent).text,
      );
      assert.deepEqual(starts, ["Reasoning first.", "Final answer last."]);
    });
  });

  // ── auto-TTS (no model available) ──────────────────────────────

  describe("auto-TTS without model", () => {
    it("does not emit speak events when no model is available", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handler = piEventHandlers.agent_end;
      assert.ok(handler, "agent_end handler should be registered");

      await handler(
        {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "No model test" }],
            },
          ],
        },
        createMockCtx(),
      );
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(
        getEvents(pi, "voice:speak_start").length,
        0,
        "Should not emit speak_start without a model",
      );
      assert.equal(
        getEvents(pi, "voice:speak_end").length,
        0,
        "Should not emit speak_end without a model",
      );
    });

    it("does not emit speak events when TTS is disabled", async () => {
      writeTestConfig({ enabled: false });
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handler = piEventHandlers.agent_end;
      assert.ok(handler);

      await handler(
        {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Disabled test" }],
            },
          ],
        },
        createMockCtx(),
      );
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(getEvents(pi, "voice:speak_start").length, 0);
    });
  });

  // ── text preparation ────────────────────────────────────────────

  describe("text preparation", () => {
    it("removes common markdown formatting characters", () => {
      assert.equal(
        prepareTextForSpeech("# Title\n\n***note*** Run `npm test` before [shipping](url)."),
        "Title\n\nnote Run npm test before shipping.",
      );
    });

    it("replaces fenced code blocks with a spoken description", () => {
      const prepared = prepareTextForSpeech(`Here is the fix:

\`\`\`ts
function add(a: number, b: number) {
  return a + b;
}
\`\`\`

Then run tests.`);

      assert.match(prepared, /TypeScript code block with 3 non empty lines/);
      assert.doesNotMatch(prepared, /```/);
      assert.doesNotMatch(prepared, /return a \+ b/);
    });

    it("detects fenced code blocks", () => {
      assert.equal(containsFencedCodeBlock("```ts\nconst x = 1;\n```"), true);
      assert.equal(containsFencedCodeBlock("No code fences here."), false);
    });

    it("handles unterminated fenced code blocks without throwing", () => {
      const prepared = prepareTextForSpeech("```bash\nnpm test");
      assert.match(prepared, /shell code block with 1 non empty lines/);
    });
  });
});
