/**
 * pi-voice extension — /voice command and tts tool.
 *
 * TUI settings (via /voice):
 *   - TTS enabled/disabled (toggle)
 *   - Voice selector (fetched from server when model is loaded)
 *   - Speed selector (0.5 – 3.0)
 *
 * Persistence:
 *   - Global defaults: ~/.pi/voice/config.json
 *   - Session overrides: pi.appendEntry("voice-session", ...)
 *
 * Auto-TTS events:
 *   - Configured via events: Record<string, EventConfig> in ~/.pi/voice/config.json
 *   - EventConfig is one of:
 *     - { content?: "text" | "thinking" | "all" } — speak extracted event content directly
 *     - { prompt: string, content?: "text" | "thinking" | "all", model?: { provider, id } }
 *       — summarize extracted event content via LLM, then speak
 *     - { text: string } — speak fixed text directly (no LLM)
 *   - text is mutually exclusive with prompt/content
 *   - model is optional per-event; if omitted, inherits the active session model
 *   - Default: agent_end with last_message context
 *   - Any event name can be used; presence in config = enabled
 *   - Built-in pi events (agent_end, turn_end, message_end) use pi.on()
 *   - Custom events (e.g. ask:started) use the shared pi.events bus
 *   - Uses per-event model if configured, otherwise inherits the active session model
 *
 * Agent tool:
 *   - tts: converts text → WAV via the TTS server, plays it.
 *     Uses session overrides > global defaults.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SPEECH_CONFIG,
  loadPronunciations,
  normalizeSpeechConfig,
  resolveConfiguredProfile,
  type SpeechVoiceConfig,
} from "./config.ts";
import { type SpeechCancellationReason, SpeechScheduler } from "./speech-runtime.ts";
import {
  codeSummaryTargets,
  type PronunciationFile,
  prepareSpeechText,
  type SpeechContext,
  type SpeechProfileConfig,
  type SpeechRole,
  shouldSummarizeToolOutput,
} from "./speech-text.ts";
import {
  defaultSttModelDir,
  type LocalSttSession,
  type SttProgress,
  type SttRuntimeConfig,
  startLocalSttSession,
} from "./stt.ts";

const Type = await loadTypebox();

async function loadTypebox() {
  try {
    const mod = (await import("typebox")) as { Type?: unknown };
    if (mod.Type) return mod.Type as ReturnType<typeof fallbackTypebox>;
  } catch {
    /* use lightweight fallback for tests/dev installs without peer deps */
  }
  return fallbackTypebox();
}

function fallbackTypebox() {
  return {
    Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
      type: "object",
      properties,
      ...options,
    }),
    String: (options: Record<string, unknown> = {}) => ({ type: "string", ...options }),
    Number: (options: Record<string, unknown> = {}) => ({ type: "number", ...options }),
    Boolean: (options: Record<string, unknown> = {}) => ({ type: "boolean", ...options }),
    Literal: (value: unknown) => ({ const: value }),
    Union: (schemas: unknown[]) => ({ anyOf: schemas }),
    Optional: (schema: unknown) => schema,
    Record: (_key: unknown, value: unknown) => ({ type: "object", additionalProperties: value }),
  };
}

function matchesKey(data: string, name: string): boolean {
  if (name.length === 1) return data === name;
  switch (name) {
    case "escape":
      return data === "\x1b";
    case "enter":
      return data === "\r" || data === "\n";
    case "up":
      return data === "\x1b[A";
    case "down":
      return data === "\x1b[B";
    case "right":
      return data === "\x1b[C";
    case "left":
      return data === "\x1b[D";
    default:
      return false;
  }
}

// ── Types ──────────────────────────────────────────────────────────

interface ModelConfig {
  provider: string;
  id: string;
}

type EventConfig = SummarizeEventConfig | DirectEventConfig | RawEventConfig;

type SpeechContentMode = "text" | "thinking" | "all";

interface SummarizeEventConfig {
  prompt: string;
  model?: ModelConfig;
  /** Which assistant content blocks to summarize/speak. Defaults to final text only. */
  content?: SpeechContentMode;
  roles?: SpeechRole[];
  profile?: string;
}

interface DirectEventConfig {
  text: string;
  profile?: string;
}

interface RawEventConfig {
  /** Which assistant content blocks to speak directly. Defaults to final text only. */
  content?: SpeechContentMode;
  roles?: SpeechRole[];
  profile?: string;
}

interface FullVoiceConfig {
  enabled: boolean;
  voice: string;
  speed: number;
  backend: "local" | "remote";
  host: string;
  port: number;
  remote?: RemoteVoiceConfig;
  stt?: SttVoiceConfig;
  speech?: SpeechVoiceConfig;
  events?: Record<string, EventConfig>;
}

interface RemoteVoiceConfig {
  baseUrl?: string;
  host?: string;
  port?: number;
  authToken?: string;
  speechPath?: string;
  streamPath?: string;
  stream?: boolean;
  streamFormat?: "pcm" | "wav";
  chunkText?: boolean;
  chunkMaxChars?: number;
}

interface SttVoiceConfig {
  enabled?: boolean;
  mode?: "local";
  modelDir?: string;
  language?: string;
  audioCues?: boolean;
  startCue?: string;
  finishCue?: string;
}

interface VoiceSessionState {
  enabled?: boolean;
  voice?: string;
  speed?: number;
}

// ── Event Types (exported) ──────────────────────────────────────

export type VoiceSpeakSource = "tool" | "auto" | "sample";

export interface VoiceConfigEvent {
  enabled: boolean;
  voice: string;
  speed: number;
}

export interface VoiceSpeakStartEvent {
  text: string;
  voice: string;
  speed: number;
  source: VoiceSpeakSource;
}

export interface VoiceSpeakEndEvent {
  text: string;
  source: VoiceSpeakSource;
  error?: string;
  cancelled?: boolean;
  cancellationReason?: string;
}

export interface VoiceEventMap {
  "voice:config": VoiceConfigEvent;
  "voice:speak_start": VoiceSpeakStartEvent;
  "voice:speak_end": VoiceSpeakEndEvent;
}

// ── Constants ──────────────────────────────────────────────────────

const CONFIG_DIR = resolve(process.env.PI_VOICE_DIR ?? join(homedir(), ".pi", "voice"));
const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
const DEBUG_LOG_PATH = resolve(CONFIG_DIR, "debug.log");
const MACOS_SOUND_DIR = "/System/Library/Sounds";
const SPEED_VALUES = [
  "0.5",
  "0.75",
  "1.0",
  "1.25",
  "1.5",
  "1.75",
  "2.0",
  "2.25",
  "2.5",
  "2.75",
  "3.0",
];

const DEFAULT_SUMMARY_PROMPT =
  "You are preparing text for a text-to-speech system. " +
  "You will receive a message from a conversation enclosed in quadruple backticks. " +
  "Summarize it in one single very short sentence, two at most. " +
  "Use a dry, matter-of-fact tone. " +
  "Do not use any markdown formatting, just plain text. " +
  "Prefer words over symbols or abbreviations, as this will be read aloud. " +
  "Output only the sentence, nothing else.";

const TECHNICAL_CODE_SUMMARY_PROMPT =
  "Summarize only the supplied code blocks for spoken monitoring. Preserve important commands, " +
  "identifiers, files, errors, and APIs. Return JSON only as an array of objects with numeric id " +
  'and plain-text summary fields, for example [{"id":0,"summary":"Defines loadConfig."}].';

const TECHNICAL_TOOL_SUMMARY_PROMPT =
  "Summarize this tool result for spoken monitoring. Preserve the tool name, command or file when " +
  "provided, success or failure, important errors, and consequential values. Omit opaque identifiers " +
  "and repetitive output. Return one concise plain-text paragraph with no Markdown.";

const DEFAULT_REMOTE_CONFIG: Required<RemoteVoiceConfig> = {
  baseUrl: "http://127.0.0.1:8880",
  host: "127.0.0.1",
  port: 8880,
  authToken: "",
  speechPath: "/v1/audio/speech",
  streamPath: "/v1/audio/speech/stream",
  stream: true,
  streamFormat: "pcm",
  chunkText: true,
  chunkMaxChars: 240,
};

const DEFAULT_STT_CONFIG: Required<SttVoiceConfig> = {
  enabled: true,
  mode: "local",
  modelDir: defaultSttModelDir(),
  language: "en",
  audioCues: true,
  startCue: `${MACOS_SOUND_DIR}/Pop.aiff`,
  finishCue: `${MACOS_SOUND_DIR}/Glass.aiff`,
};

function debugLog(event: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(
      DEBUG_LOG_PATH,
      `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`,
    );
  } catch {
    /* logging must never break TTS */
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textPreview(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function readDebugLogTail(maxLines = 30): string[] {
  try {
    if (!existsSync(DEBUG_LOG_PATH)) return [];
    return readFileSync(DEBUG_LOG_PATH, "utf-8").trimEnd().split("\n").slice(-maxLines);
  } catch {
    return [];
  }
}

function speedToIndex(speed: number): number {
  const idx = SPEED_VALUES.findIndex((s) => Number.parseFloat(s) === speed);
  return idx >= 0 ? idx : 0;
}

function voiceHint(name: string): string {
  const langMap: Record<string, string> = {
    a: "American",
    b: "British",
    j: "Japanese",
    z: "Mandarin",
    e: "Spanish",
    f: "French",
    h: "Hindi",
    i: "Italian",
    p: "Brazilian",
  };
  const genderMap: Record<string, string> = { f: "female", m: "male" };
  const lang = langMap[name[0]] ?? "";
  const gender = genderMap[name[1]] ?? "";
  if (lang && gender) return `${lang} ${gender}`;
  if (gender) return gender;
  return lang;
}

export function containsFencedCodeBlock(text: string): boolean {
  return /^\s*(`{3,}|~{3,})/m.test(text);
}

export function prepareTextForSpeech(text: string): string {
  return prepareSpeechText(text);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function withLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = trimTrailingSlash(value.trim());
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function remoteConfig(config: FullVoiceConfig): Required<RemoteVoiceConfig> {
  const remote = config.remote ?? {};
  const host = remote.host ?? DEFAULT_REMOTE_CONFIG.host;
  const port = remote.port ?? DEFAULT_REMOTE_CONFIG.port;
  return {
    baseUrl: normalizeBaseUrl(remote.baseUrl ?? `http://${host}:${port}`),
    host,
    port,
    authToken: remote.authToken ?? DEFAULT_REMOTE_CONFIG.authToken,
    speechPath: withLeadingSlash(remote.speechPath ?? DEFAULT_REMOTE_CONFIG.speechPath),
    streamPath: withLeadingSlash(remote.streamPath ?? DEFAULT_REMOTE_CONFIG.streamPath),
    stream: remote.stream ?? DEFAULT_REMOTE_CONFIG.stream,
    streamFormat: remote.streamFormat ?? DEFAULT_REMOTE_CONFIG.streamFormat,
    chunkText: remote.chunkText ?? DEFAULT_REMOTE_CONFIG.chunkText,
    chunkMaxChars: remote.chunkMaxChars ?? DEFAULT_REMOTE_CONFIG.chunkMaxChars,
  };
}

function sttConfig(config: FullVoiceConfig): SttRuntimeConfig {
  const stt = config.stt ?? {};
  return {
    enabled: stt.enabled ?? DEFAULT_STT_CONFIG.enabled,
    modelDir: stt.modelDir ?? DEFAULT_STT_CONFIG.modelDir,
    language: stt.language ?? DEFAULT_STT_CONFIG.language,
    audioCues: stt.audioCues ?? DEFAULT_STT_CONFIG.audioCues,
    startCue: stt.startCue ?? DEFAULT_STT_CONFIG.startCue,
    finishCue: stt.finishCue ?? DEFAULT_STT_CONFIG.finishCue,
  };
}

function remoteUrl(config: FullVoiceConfig, path: string): string {
  const remote = remoteConfig(config);
  return `${remote.baseUrl}${withLeadingSlash(path)}`;
}

function remoteAuthHeaders(remote: Required<RemoteVoiceConfig>): Record<string, string> {
  const token = remote.authToken.trim();
  if (!token) return {};
  return {
    Authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
  };
}

function remoteJsonHeaders(remote: Required<RemoteVoiceConfig>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...remoteAuthHeaders(remote),
  };
}

function splitSpeechText(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const parts = normalized.match(/[^.!?;:]+[.!?;:]?|\S+/g) ?? [normalized];
  const chunks: string[] = [];
  let current = "";

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (!current) {
      current = part;
      continue;
    }
    if (current.length + 1 + part.length <= maxChars) {
      current = `${current} ${part}`;
      continue;
    }
    chunks.push(current);
    current = part;
  }

  if (current) chunks.push(current);
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxChars * 1.5) return [chunk];
    const split: string[] = [];
    for (let i = 0; i < chunk.length; i += maxChars) {
      split.push(chunk.slice(i, i + maxChars).trim());
    }
    return split.filter(Boolean);
  });
}

function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function streamingPcmPlayer(): { command: string; args: string[] } | null {
  const ffplay = findExecutable("ffplay");
  if (ffplay) {
    return {
      command: ffplay,
      args: [
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-sample_rate",
        "24000",
        "-ch_layout",
        "mono",
        "-i",
        "pipe:0",
      ],
    };
  }

  const play = findExecutable("play");
  if (play) {
    return { command: play, args: ["-q", "-t", "s16", "-r", "24000", "-c", "1", "-"] };
  }

  const aplay = findExecutable("aplay");
  if (aplay) {
    return { command: aplay, args: ["-q", "-f", "S16_LE", "-r", "24000", "-c", "1"] };
  }

  return null;
}

function wavPlaybackTimeoutMs(wavBuffer: Buffer): number | undefined {
  if (wavBuffer.length < 44 || wavBuffer.toString("ascii", 0, 4) !== "RIFF") {
    return undefined;
  }
  const byteRate = wavBuffer.readUInt32LE(28);
  const dataSize = wavBuffer.readUInt32LE(40);
  if (!byteRate || !dataSize) return undefined;
  const durationMs = (dataSize / byteRate) * 1000;
  return Math.ceil(Math.max(30_000, durationMs + 15_000));
}

const DEFAULT_CONFIG: FullVoiceConfig = {
  enabled: true,
  voice: "af_heart",
  speed: 1.0,
  backend: "local",
  host: "127.0.0.1",
  port: 8181,
  remote: { ...DEFAULT_REMOTE_CONFIG },
  stt: { ...DEFAULT_STT_CONFIG },
  speech: normalizeSpeechConfig(DEFAULT_SPEECH_CONFIG),
  events: {
    agent_end: {
      prompt: DEFAULT_SUMMARY_PROMPT,
    },
  },
};

// ── Config file persistence (~/.pi/voice/config.json) ──────────────

function loadConfig(): FullVoiceConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      // Do NOT merge with DEFAULT_CONFIG — only what the user has written runs.
      // If events is missing from user config, no auto-TTS events fire.
      const config = {
        enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
        voice: raw.voice ?? DEFAULT_CONFIG.voice,
        speed: raw.speed ?? DEFAULT_CONFIG.speed,
        backend: raw.backend === "remote" ? "remote" : DEFAULT_CONFIG.backend,
        host: raw.host ?? DEFAULT_CONFIG.host,
        port: raw.port ?? DEFAULT_CONFIG.port,
        remote: raw.remote ? { ...DEFAULT_REMOTE_CONFIG, ...raw.remote } : DEFAULT_CONFIG.remote,
        stt: raw.stt ? { ...DEFAULT_STT_CONFIG, ...raw.stt } : DEFAULT_CONFIG.stt,
        speech: normalizeSpeechConfig(raw.speech),
        events: raw.events,
      };
      debugLog("config_loaded", {
        path: CONFIG_PATH,
        backend: config.backend,
        local: `${config.host}:${config.port}`,
        remote: config.remote?.baseUrl,
        stt: config.stt?.enabled ? "enabled" : "disabled",
        events: config.events ? Object.keys(config.events) : [],
      });
      return config;
    }
  } catch (error) {
    debugLog("config_load_error", { path: CONFIG_PATH, error: errorText(error) });
    /* use defaults */
  }
  debugLog("config_default", { path: CONFIG_PATH, backend: DEFAULT_CONFIG.backend });
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: FullVoiceConfig, replace = false) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let output: Record<string, unknown> = config as unknown as Record<string, unknown>;
  if (!replace && existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        output = {
          ...raw,
          enabled: config.enabled,
          voice: config.voice,
          speed: config.speed,
        };
      }
    } catch {
      /* replace malformed config with the normalized values */
    }
  }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(output, null, 2)}\n`);
}

// ── Context Extraction ────────────────────────────────────────────

interface ExtractedMessage {
  text: string;
  role?: SpeechRole;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

interface SpeechMessageLike {
  role?: SpeechRole;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

function extractLastMessage(
  event: unknown,
  mode: SpeechContentMode = "text",
  roles?: SpeechRole[],
): ExtractedMessage {
  const data = event as {
    messages?: SpeechMessageLike[];
    message?: SpeechMessageLike;
    toolResults?: SpeechMessageLike[];
  };
  const messages = data.messages && Array.isArray(data.messages)
    ? data.messages
    : data.message
      ? roles?.includes("toolResult") && Array.isArray(data.toolResults)
        ? [data.message, ...data.toolResults]
        : [data.message]
      : [];
  const message = roles?.length
    ? [...messages].reverse().find((candidate) => roles.includes(candidate?.role))
    : messages.at(-1);
  if (!message) return { text: "" };
  return {
    text: extractMessageContent(message.content, mode),
    role: message.role,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    isError: message.isError,
  };
}

function extractMessageContent(content: unknown, mode: SpeechContentMode): string {
  if (!content) return "";
  if (typeof content === "string") return mode === "thinking" ? "" : content;
  if (!Array.isArray(content)) return "";

  return content
    .map((value: unknown): string => {
      if (!value || typeof value !== "object") return "";
      const c = value as { type?: string; text?: string; thinking?: string };
      if ((mode === "text" || mode === "all") && c.type === "text" && c.text) {
        return c.text;
      }
      if (
        (mode === "thinking" || mode === "all") &&
        c.type === "thinking" &&
        c.thinking
      ) {
        return c.thinking;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// ── Event Processing ───────────────────────────────────────────────

async function generateSpeechText(
  prompt: string,
  context: string,
  ctx: ExtensionContext,
  modelConfig?: ModelConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    if (signal?.aborted) throw abortSignalError(signal);
    const {
      AuthStorage,
      createAgentSession,
      DefaultResourceLoader,
      SessionManager,
    } = await import("@earendil-works/pi-coding-agent");
    // Resolve model: per-event model > active session model
    const model = modelConfig
      ? ctx.modelRegistry.find(modelConfig.provider, modelConfig.id)
      : ctx.model;
    if (!model) {
      return null;
    }

    const userMessage = context
      ? `The following is a message from a conversation that you need to summarize:\n\n""""\n${context}\n""""`
      : "Generate speech text.";

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: resolve(homedir(), ".pi"),
      systemPromptOverride: () => prompt,
    });
    await abortableSetup(loader.reload(), signal);
    if (signal?.aborted) throw abortSignalError(signal);

    const { session } = await abortableSetup(
      createAgentSession({
        model,
        tools: [],
        sessionManager: SessionManager.inMemory(),
        authStorage: AuthStorage.create(),
        modelRegistry: ctx.modelRegistry,
        resourceLoader: loader,
      }),
      signal,
      ({ session: lateSession }) => {
        try {
          void Promise.resolve(lateSession.abort())
            .catch(() => {})
            .finally(() => lateSession.dispose());
        } catch {
          lateSession.dispose();
        }
      },
    );

    let unsub: (() => void) | undefined;
    const onAbort = () => {
      void Promise.resolve(session.abort()).catch((error) => {
        debugLog("summary_abort_error", { error: errorText(error) });
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      if (signal?.aborted) {
        onAbort();
        throw abortSignalError(signal);
      }
      let responseText = "";

      unsub = session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          for (const part of event.message.content) {
            if (part.type === "text" && part.text) {
              responseText += part.text;
            }
          }
        }
      });

      await session.prompt(userMessage);
      if (signal?.aborted) throw abortSignalError(signal);

      return responseText || null;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsub?.();
      session.dispose();
    }
  } catch {
    if (signal?.aborted) throw abortSignalError(signal);
    return null;
  }
}

function abortSignalError(signal: AbortSignal): Error {
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Speech cancelled",
  );
  error.name = "AbortError";
  return error;
}

function abortableSetup<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortSignalError(signal));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      rejectPromise(abortSignalError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          try {
            onLateResolve?.(value);
          } catch {
            /* late cleanup is best effort */
          }
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function parseCodeSummaries(value: string | null): Record<number, string> {
  if (!value) return {};
  const candidate = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!Array.isArray(parsed)) return {};
    const entries = parsed.flatMap((item): Array<[number, string]> => {
      if (!item || typeof item !== "object") return [];
      const id = (item as { id?: unknown }).id;
      const summary = (item as { summary?: unknown }).summary;
      return typeof id === "number" && Number.isInteger(id) && typeof summary === "string"
        ? [[id, summary.trim()]]
        : [];
    });
    return Object.fromEntries(entries.filter(([, summary]) => summary));
  } catch {
    return {};
  }
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let defaults = loadConfig();
  let pronunciations: PronunciationFile = { version: 1, rules: [] };
  let session: VoiceSessionState = {};
  let currentCtx: ExtensionContext | undefined;
  let lastVoiceStatus = "idle";
  let sttStatus = "ready";
  let streamBuffer = "";
  let streamJobCounter = 0;
  let nextSpeechGeneration = 0;
  let activeSpeechGeneration = 0;
  let waitingForUserMessage = false;
  const pendingUserGenerations: Array<{ generation: number; text: string }> = [];
  const toolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();

  function getEffective(): FullVoiceConfig {
    return {
      enabled: session.enabled ?? defaults.enabled,
      voice: session.voice ?? defaults.voice,
      speed: session.speed ?? defaults.speed,
      backend: defaults.backend,
      host: defaults.host,
      port: defaults.port,
      remote: defaults.remote,
      stt: defaults.stt,
      speech: defaults.speech,
      events: defaults.events,
    };
  }

  function effectiveServerUrl(config: FullVoiceConfig): string {
    return config.backend === "remote" ? remoteConfig(config).baseUrl : `http://${config.host}:${config.port}`;
  }

  function compactUrl(value: string): string {
    return value.replace(/^https?:\/\//, "");
  }

  function setVoiceStatus(message: string): void {
    lastVoiceStatus = message;
    debugLog("status", { message });
    updateStatusBar();
  }

  function setSttStatus(message: string): void {
    sttStatus = message;
    debugLog("stt_status", { message });
    updateStatusBar();
  }

  function statusLine(config = getEffective()): string {
    const stt = sttConfig(config);
    const sttText = stt.enabled ? `stt ${sttStatus}` : "stt off";
    if (!config.enabled) return `voice: off | ${sttText}`;
    const target = config.backend === "remote"
      ? compactUrl(remoteConfig(config).baseUrl)
      : `${config.host}:${config.port}`;
    return `voice: ${config.backend} ${target} ${lastVoiceStatus} | ${sttText}`;
  }

  function persistSession() {
    pi.appendEntry<VoiceSessionState>("voice-session", { ...session });
  }

  function reloadRuntimeConfig(): void {
    defaults = loadConfig();
    const result = loadPronunciations(CONFIG_DIR, defaults.speech, pronunciations);
    pronunciations = result.file;
    if (result.error) {
      debugLog("pronunciations_load_error", { path: result.path, error: result.error });
    } else {
      debugLog("pronunciations_loaded", {
        path: result.path,
        rules: pronunciations.rules.length,
      });
    }
  }

  function restoreSession(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "voice-session") {
        const data = entry.data as VoiceSessionState | undefined;
        if (data) session = { ...data };
      }
    }
    reloadRuntimeConfig();
  }

  // ── Speech scheduler ────────────────────────────────────────────

  const speechScheduler = new SpeechScheduler<void>();
  let audioFileCounter = 0;
  let ttsRequestCounter = 0;
  let autoTTSJobCounter = 0;

  function playSttCue(kind: "start" | "finish", config: SttRuntimeConfig): Promise<void> {
    if (!config.audioCues) return Promise.resolve();
    const cue = kind === "start" ? config.startCue : config.finishCue;
    if (process.platform === "darwin" && cue && existsSync(cue)) {
      return new Promise((resolve) => {
        const child = spawn("afplay", [cue], { stdio: "ignore" });
        child.on("error", () => resolve());
        child.on("close", () => resolve());
      });
    }
    try {
      process.stdout.write("\u0007");
    } catch {
      /* ignore */
    }
    return Promise.resolve();
  }

  function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined) return "";
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }

  function progressText(progress: SttProgress | null): string {
    if (!progress) return "Preparing STT...";
    if (progress.phase === "downloading") {
      const pct = progress.percent === undefined ? "" : ` ${progress.percent}%`;
      const bytes = progress.bytesReceived === undefined
        ? ""
        : ` ${formatBytes(progress.bytesReceived)}${progress.totalBytes ? `/${formatBytes(progress.totalBytes)}` : ""}`;
      return `${progress.message}${pct}${bytes}`.trim();
    }
    return progress.message;
  }

  function levelBar(level: number): string {
    const width = 18;
    const filled = Math.max(0, Math.min(width, Math.round(level * 60)));
    return `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  }

  function pasteToEditor(ctx: ExtensionContext, text: string): boolean {
    const ui = ctx.ui as ExtensionContext["ui"] & { pasteToEditor?: (value: string) => void };
    if (typeof ui.pasteToEditor !== "function") return false;
    ui.pasteToEditor(text);
    return true;
  }

  async function runDictation(ctx: ExtensionContext): Promise<void> {
    const effective = getEffective();
    const stt = sttConfig(effective);
    if (!stt.enabled) {
      ctx.ui.notify("STT is disabled. Set stt.enabled to true in ~/.pi/voice/config.json.", "info");
      setSttStatus("off");
      return;
    }

    let handle: LocalSttSession | null = null;
    let cancelled = false;

    await ctx.ui.custom(
      (tui, theme, _kb, done) => {
        let progress: SttProgress | null = null;
        let phase: "preparing" | "listening" | "processing" | "complete" | "error" = "preparing";
        let transcript = "";
        let partial = "";
        let error: string | null = null;
        let level = 0;
        let paused = false;
        let closing = false;

        const commit = async () => {
          if (closing) return;
          closing = true;
          phase = "processing";
          setSttStatus("processing");
          tui.requestRender();
          try {
            handle?.stop();
            const finalTranscript = (await handle?.finalTranscript) ?? transcript;
            transcript = finalTranscript.trim();
            partial = "";
            await playSttCue("finish", stt);
            if (transcript) {
              if (pasteToEditor(ctx, transcript)) {
                ctx.ui.notify("Dictation pasted. Press Enter to send.", "info");
              } else {
                ctx.ui.notify(`Dictation complete: ${transcript}`, "info");
              }
            } else {
              ctx.ui.notify("Dictation finished with no transcript.", "info");
            }
            phase = "complete";
            setSttStatus("ready");
            done(transcript);
          } catch (commitError) {
            error = errorText(commitError);
            phase = "error";
            setSttStatus("error");
            debugLog("stt_commit_error", { error });
            tui.requestRender();
          }
        };

        const cancel = () => {
          if (closing) return;
          closing = true;
          cancelled = true;
          handle?.stop();
          setSttStatus("ready");
          done(undefined);
        };

        void (async () => {
          try {
            setSttStatus("starting");
            handle = await startLocalSttSession(
              stt,
              {
                onProgress(nextProgress) {
                  progress = nextProgress;
                  setSttStatus(nextProgress.phase.replace(/_/g, " "));
                  tui.requestRender();
                },
                onAudioLevel(nextLevel) {
                  level = nextLevel;
                  tui.requestRender();
                },
                onPartial(text) {
                  partial = text;
                  tui.requestRender();
                },
                onTranscript(text) {
                  transcript = transcript ? `${transcript} ${text}` : text;
                  tui.requestRender();
                },
                onError(sttError) {
                  debugLog("stt_error", { error: errorText(sttError) });
                },
              },
              { startPaused: true },
            );
            if (cancelled) {
              handle.stop();
              return;
            }
            await playSttCue("start", stt);
            handle.setPaused(false);
            phase = "listening";
            setSttStatus("listening");
            tui.requestRender();
          } catch (startError) {
            error = errorText(startError);
            phase = "error";
            setSttStatus("error");
            debugLog("stt_start_error", { error });
            tui.requestRender();
          }
        })();

        return {
          render() {
            const lines = [theme.fg("accent", theme.bold("Dictation")), ""];
            if (phase === "preparing") {
              lines.push(`Status: ${progressText(progress)}`);
            } else if (phase === "listening") {
              lines.push(`Status: ${paused ? "paused" : "listening"}`);
            } else if (phase === "processing") {
              lines.push("Status: processing final transcript...");
            } else if (phase === "error") {
              lines.push(theme.fg("error", `Status: ${error ?? "STT failed"}`));
            } else {
              lines.push("Status: complete");
            }

            lines.push(`Mic: [${levelBar(level)}]`);
            lines.push("");
            lines.push(theme.bold("Transcript"));
            const body = transcript || partial ? transcript : theme.fg("dim", "Speak after the start cue...");
            lines.push(body);
            if (partial) lines.push(theme.fg("dim", partial));
            lines.push("");
            lines.push(theme.fg("dim", "Enter paste transcript • space pause/resume • esc cancel"));
            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "escape")) {
              cancel();
              return;
            }
            if (matchesKey(data, "enter")) {
              void commit();
              return;
            }
            if (data === " " && handle && phase === "listening") {
              paused = !paused;
              handle.setPaused(paused);
              setSttStatus(paused ? "paused" : "listening");
              tui.requestRender();
            }
          },
        };
      },
      { overlay: true },
    );
  }

  // ── Speak + Auto-TTS (closured over pi) ─────────────────────

  async function responseError(res: Response): Promise<string> {
    const text = await res.text();
    debugLog("http_error_body", { status: res.status, body: textPreview(text) });
    try {
      const data = JSON.parse(text) as { error?: string; detail?: string };
      return data.error ?? data.detail ?? `HTTP ${res.status}`;
    } catch {
      return text || `HTTP ${res.status}`;
    }
  }

  function abortError(signal?: AbortSignal): Error {
    const error = new Error(
      typeof signal?.reason === "string" ? signal.reason : "Speech cancelled",
    );
    error.name = "AbortError";
    return error;
  }

  function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal);
  }

  async function fetchTtsWav(
    text: string,
    config: FullVoiceConfig,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    throwIfAborted(signal);
    const remote = config.backend === "remote" ? remoteConfig(config) : null;
    const url = remote
      ? remoteUrl(config, remote.speechPath)
      : `http://${config.host}:${config.port}/tts`;
    const requestId = remote
      ? undefined
      : `${process.pid}-${Date.now()}-${++ttsRequestCounter}`;
    const body = remote
      ? {
          model: "kokoro",
          input: text,
          voice: config.voice,
          response_format: "wav",
          speed: config.speed,
        }
      : {
          text,
          voice: config.voice,
          speed: config.speed,
          requestId,
        };

    debugLog("tts_wav_request", {
      backend: config.backend,
      url,
      chars: text.length,
      voice: config.voice,
      speed: config.speed,
      preview: textPreview(text),
    });
    const onAbort = () => {
      if (!requestId) return;
      void fetch(`http://${config.host}:${config.port}/tts/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      }).catch((error) => {
        debugLog("tts_cancel_error", { requestId, error: errorText(error) });
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: remote ? remoteJsonHeaders(remote) : { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });

      debugLog("tts_wav_response", {
        url,
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get("content-type"),
        contentLength: res.headers.get("content-length"),
      });
      if (!res.ok) throw new Error(await responseError(res));
      setVoiceStatus(`${config.backend} audio ready`);
      const wav = Buffer.from(await res.arrayBuffer());
      throwIfAborted(signal);
      debugLog("tts_wav_buffer", { bytes: wav.length });
      return wav;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function playWavBuffer(
    wavBuffer: Buffer,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    throwIfAborted(signal);
    const outPath = join(
      CONFIG_DIR,
      `voice-${Date.now()}-${process.pid}-${++audioFileCounter}.wav`,
    );
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(outPath, wavBuffer);
    const playbackTimeout = wavPlaybackTimeoutMs(wavBuffer);
    debugLog("wav_play_start", {
      path: outPath,
      bytes: wavBuffer.length,
      timeoutMs: playbackTimeout,
      command: process.platform === "darwin" ? "afplay" : "aplay",
    });

    return await new Promise<string | undefined>((resolve, reject) => {
      const cmd = process.platform === "darwin" ? "afplay" : "aplay";
      const child = spawn(cmd, [outPath], { stdio: "ignore" });
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let killTimeout: NodeJS.Timeout | undefined;
      let terminationError: string | undefined;

      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        if (timeout) clearTimeout(timeout);
        if (killTimeout) clearTimeout(killTimeout);
        try {
          unlinkSync(outPath);
        } catch {
          /* ignore */
        }
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        const message = error ? errorText(error) : undefined;
        debugLog("wav_play_end", { path: outPath, error: message });
        if (signal?.aborted) reject(abortError(signal));
        else resolve(message);
      };
      const terminate = (message?: string) => {
        terminationError ??= message;
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        killTimeout ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1000);
      };
      const onAbort = () => terminate();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        terminationError = error.message;
        terminate(error.message);
      });
      child.on("close", (code, childSignal) => {
        finish(
          terminationError ??
            (code === 0 ? undefined : `${cmd} exited with ${childSignal ?? `code ${code}`}`),
        );
      });
      if (playbackTimeout) {
        timeout = setTimeout(() => {
          terminate(`${cmd} playback timed out`);
        }, playbackTimeout);
      }
      if (signal?.aborted) onAbort();
    });
  }

  async function playRemotePcmStream(
    speechText: string,
    config: FullVoiceConfig,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    throwIfAborted(signal);
    const player = streamingPcmPlayer();
    if (!player) throw new Error("No streaming PCM player found");

    const remote = remoteConfig(config);
    const url = remoteUrl(config, remote.streamPath);
    debugLog("pcm_stream_request", {
      url,
      chars: speechText.length,
      voice: config.voice,
      speed: config.speed,
      playerCommand: player.command,
      playerArgs: player.args,
      preview: textPreview(speechText),
    });
    const res = await fetch(url, {
      method: "POST",
      headers: remoteJsonHeaders(remote),
      body: JSON.stringify({
        model: "kokoro",
        input: speechText,
        voice: config.voice,
        response_format: "wav",
        stream_format: "pcm",
        speed: config.speed,
      }),
      signal,
    });

    debugLog("pcm_stream_response", {
      url,
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get("content-type"),
      contentLength: res.headers.get("content-length"),
      transferEncoding: res.headers.get("transfer-encoding"),
    });
    if (!res.ok) throw new Error(await responseError(res));
    if (!res.body) throw new Error("Remote TTS stream response had no body");
    setVoiceStatus("remote stream connected");

    return await new Promise<string | undefined>((resolve, reject) => {
          const child = spawn(player.command, player.args, { stdio: ["pipe", "ignore", "pipe"] });
          let error: string | undefined;
          let bytes = 0;
          let settled = false;
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let killTimeout: NodeJS.Timeout | undefined;
          const terminate = () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill("SIGTERM");
            killTimeout ??= setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, 1000);
          };
          const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            if (killTimeout) clearTimeout(killTimeout);
            void reader?.cancel().catch(() => {});
            child.stdin.destroy();
            debugLog("pcm_player_close", { code, error, bytes });
            if (signal?.aborted) reject(abortError(signal));
            else resolve(code === 0 ? undefined : (error ?? `${player.command} exited with code ${code}`));
          };
          const onAbort = () => {
            void reader?.cancel(signal?.reason).catch(() => {});
            child.stdin.destroy();
            terminate();
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          debugLog("pcm_player_start", {
            command: player.command,
            args: player.args,
            pid: child.pid,
          });

          child.on("error", (err) => {
            error = err.message;
            debugLog("pcm_player_error", { error: err.message });
            terminate();
          });
          child.stdin.on("error", (err) => {
            error = err.message;
            debugLog("pcm_player_stdin_error", { error: err.message });
          });
          child.stderr.on("data", (chunk: Buffer) => {
            const message = chunk.toString().trim();
            if (message) {
              error = message;
              debugLog("pcm_player_stderr", { message: textPreview(message) });
            }
          });
          child.on("close", (code) => {
            finish(code);
          });

          (async () => {
            reader = res.body?.getReader();
            if (!reader) throw new Error("Remote TTS stream response had no reader");
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                const buffer = Buffer.from(value);
                bytes += buffer.length;
                const canContinue = child.stdin.write(buffer);
                if (!canContinue) await new Promise((r) => child.stdin.once("drain", r));
              }
              child.stdin.end();
              debugLog("pcm_stream_read_done", { bytes });
            } catch (err) {
              if (signal?.aborted) return;
              error = errorText(err);
              debugLog("pcm_stream_read_error", { error, bytes });
              child.stdin.destroy();
              terminate();
            }
          })().catch((err) => {
            error = errorText(err);
            child.stdin.destroy();
            terminate();
          });
          if (signal?.aborted) onAbort();
        });
  }

  async function synthesizeAndPlay(
    speechText: string,
    config: FullVoiceConfig,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    throwIfAborted(signal);
    if (config.backend !== "remote") {
      return await playWavBuffer(await fetchTtsWav(speechText, config, signal), signal);
    }

    const remote = remoteConfig(config);
    if (remote.stream && remote.streamFormat === "pcm" && streamingPcmPlayer()) {
      try {
        return await playRemotePcmStream(speechText, config, signal);
      } catch (error) {
        throwIfAborted(signal);
        debugLog("remote_stream_fallback", { error: errorText(error) });
        setVoiceStatus("remote stream failed; chunk fallback");
      }
    }

    const chunks = remote.chunkText ? splitSpeechText(speechText, remote.chunkMaxChars) : [speechText];
    for (let i = 0; i < chunks.length; i++) {
      throwIfAborted(signal);
      const chunk = chunks[i];
      setVoiceStatus(`remote chunk ${i + 1}/${chunks.length}`);
      const wavBuffer = await fetchTtsWav(chunk, config, signal);
      const playbackError = await playWavBuffer(wavBuffer, signal);
      if (playbackError) return playbackError;
    }
    return undefined;
  }

  function cancellationReasonText(reason: SpeechCancellationReason | unknown): string {
    if (!reason || typeof reason !== "object" || !("type" in reason)) return "cancelled";
    if (reason.type === "stale-generation") return "new-user-input";
    if (reason.type === "cancel-all" && "detail" in reason && reason.detail) {
      return String(reason.detail);
    }
    return String(reason.type);
  }

  async function speakPrepared(
    speechText: string,
    config: FullVoiceConfig,
    source: VoiceSpeakSource,
    signal: AbortSignal,
  ): Promise<void> {
    if (!speechText) return;
    throwIfAborted(signal);

    const startEvent: VoiceSpeakStartEvent = {
      text: speechText,
      voice: config.voice,
      speed: config.speed,
      source,
    };
    pi.events.emit("voice:speak_start", startEvent);
    setVoiceStatus(`${config.backend} synth ${speechText.length} chars`);
    debugLog("speak_start", {
      source,
      backend: config.backend,
      chars: speechText.length,
      voice: config.voice,
      speed: config.speed,
      preview: textPreview(speechText),
    });

    try {
      const playbackError = await synthesizeAndPlay(speechText, config, signal);
      const endEvent: VoiceSpeakEndEvent = {
        text: speechText,
        source,
        ...(playbackError ? { error: playbackError } : {}),
      };
      pi.events.emit("voice:speak_end", endEvent);
      debugLog("speak_end", { source, error: playbackError });
      setVoiceStatus(playbackError ? "playback error" : "idle");
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && error.name === "AbortError");
      const cancellationReason = cancelled ? cancellationReasonText(signal.reason) : undefined;
      debugLog(cancelled ? "speak_cancelled" : "speak_error", {
        source,
        error: errorText(error),
        cancellationReason,
      });
      setVoiceStatus(cancelled ? "cancelled" : "tts error");
      const endEvent: VoiceSpeakEndEvent = {
        text: speechText,
        source,
        ...(cancelled
          ? { cancelled: true, cancellationReason }
          : { error: error instanceof Error ? error.message : String(error) }),
      };
      pi.events.emit("voice:speak_end", endEvent);
      throw error;
    }
  }

  function enqueueSpeech(
    source: VoiceSpeakSource,
    generation: number,
    cancellable: boolean,
    run: (signal: AbortSignal) => Promise<void>,
  ) {
    const result = speechScheduler.enqueue({ source, generation, cancellable, run });
    void result.then((outcome) => {
        if (outcome.status === "failed") {
          debugLog("speech_job_failed", {
            id: outcome.id,
            source,
            generation,
            error: errorText(outcome.error),
          });
        }
      });
    return result;
  }

  async function prepareConfiguredSpeech(
    input: string,
    eventName: string,
    eventConfig: EventConfig,
    extracted: ExtractedMessage,
    ctx: ExtensionContext,
    profile: SpeechProfileConfig,
    toolArgs: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const speechContext: SpeechContext = {
      source: "auto",
      event: eventName,
      role: extracted.role,
      tool: extracted.toolName,
    };

    if ("prompt" in eventConfig) {
      const generated = await generateSpeechText(
        eventConfig.prompt,
        input,
        ctx,
        eventConfig.model,
        signal,
      );
      return generated
        ? prepareSpeechText(generated, {
            context: { ...speechContext, role: "assistant", tool: undefined },
            profile,
            pronunciations,
          })
        : "";
    }

    let toolSummary: string | undefined;
    if (extracted.toolName && shouldSummarizeToolOutput(input, profile)) {
      setVoiceStatus(`summarizing ${extracted.toolName} output`);
      toolSummary =
        (await generateSpeechText(
          TECHNICAL_TOOL_SUMMARY_PROMPT,
          JSON.stringify({
            tool: extracted.toolName,
            args: toolArgs,
            isError: extracted.isError ?? false,
            output: input,
          }),
          ctx,
          undefined,
          signal,
        )) ?? undefined;
    }

    const targets = extracted.toolName ? [] : codeSummaryTargets(input, profile);
    let codeSummaries: Record<number, string> = {};
    if (targets.length > 0) {
      setVoiceStatus(`summarizing ${targets.length} code block${targets.length === 1 ? "" : "s"}`);
      codeSummaries = parseCodeSummaries(
        await generateSpeechText(
          TECHNICAL_CODE_SUMMARY_PROMPT,
          JSON.stringify(targets),
          ctx,
          undefined,
          signal,
        ),
      );
    }

    return prepareSpeechText(input, {
      context: speechContext,
      profile,
      pronunciations,
      toolArgs,
      isError: extracted.isError,
      codeSummaries,
      toolSummary,
    });
  }

  async function handleAutoTTS(
    eventName: string,
    ctx: ExtensionContext,
    config: FullVoiceConfig,
    jobId: number,
    signal: AbortSignal,
    extracted?: ExtractedMessage,
    toolArgs: Record<string, unknown> = {},
  ): Promise<void> {
    if (!config.enabled) return;
    if (!config.events?.[eventName]) return;
    if (eventName === "agent_end" && config.events.message_update) return;
    throwIfAborted(signal);

    const eventConfig = config.events[eventName];
    const profile = resolveConfiguredProfile(config.speech, eventConfig.profile);
    if ("text" in eventConfig) {
      const speechText = prepareSpeechText(eventConfig.text, {
        context: { source: "auto", event: eventName },
        profile,
        pronunciations,
      });
      if (!speechText) return;
      setVoiceStatus(`auto #${jobId} fixed ${eventName}`);
      await speakPrepared(speechText, config, "auto", signal);
      return;
    }

    if (!extracted?.text) return;
    setVoiceStatus(`auto #${jobId} preparing ${eventName}`);
    const speechText = await prepareConfiguredSpeech(
      extracted.text,
      eventName,
      eventConfig,
      extracted,
      ctx,
      profile,
      toolArgs,
      signal,
    );
    if (!speechText) return;
    await speakPrepared(speechText, config, "auto", signal);
  }

  function enqueueAutoTTS(
    eventName: string,
    event: unknown,
    ctx: ExtensionContext,
    config: FullVoiceConfig,
  ): void {
    const eventConfig = config.events?.[eventName];
    const extracted = eventConfig && !("text" in eventConfig)
      ? extractLastMessage(event, eventConfig.content ?? "text", eventConfig.roles)
      : undefined;
    const toolArgs = extracted?.toolCallId
      ? { ...(toolCalls.get(extracted.toolCallId)?.args ?? {}) }
      : {};

    if (eventName === "turn_end") {
      const turn = event as { toolResults?: Array<{ toolCallId?: string }> };
      for (const result of turn.toolResults ?? []) {
        if (result.toolCallId) toolCalls.delete(result.toolCallId);
      }
    } else if (eventName === "agent_end") {
      toolCalls.clear();
    }

    if (!config.enabled || waitingForUserMessage || !eventConfig) return;
    if (eventName === "agent_end" && config.events?.message_update) return;
    const jobId = ++autoTTSJobCounter;
    if (eventName === "message_end") flushStreamingAutoTTS(config, true);
    const generation = activeSpeechGeneration;
    enqueueSpeech("auto", generation, true, async (signal) => {
      await handleAutoTTS(eventName, ctx, config, jobId, signal, extracted, toolArgs);
    });
  }

  function firstCodeFenceSpan(value: string): { start: number; end?: number } | null {
    const lines = value.match(/[^\n]*(?:\n|$)/g) ?? [];
    let offset = 0;
    let open: { start: number; character: string; length: number } | undefined;
    for (const lineWithEnding of lines) {
      if (!lineWithEnding) continue;
      const line = lineWithEnding.endsWith("\n")
        ? lineWithEnding.slice(0, -1).replace(/\r$/, "")
        : lineWithEnding;
      if (!open) {
        const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];
        if (opening) {
          open = { start: offset, character: opening[0], length: opening.length };
        }
      } else {
        const closing = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
        if (closing?.[0] === open.character && closing.length >= open.length) {
          return { start: open.start, end: offset + lineWithEnding.length };
        }
      }
      offset += lineWithEnding.length;
    }
    return open ? { start: open.start } : null;
  }

  function nextStreamingChunk(force: boolean, maxChars: number): string | null {
    const text = streamBuffer.trimStart();
    streamBuffer = text;
    if (!streamBuffer) return null;

    const fence = firstCodeFenceSpan(streamBuffer);
    if (fence?.start === 0) {
      if (fence.end === undefined && !force) return null;
      const end = fence.end ?? streamBuffer.length;
      const chunk = streamBuffer.slice(0, end).trim();
      streamBuffer = streamBuffer.slice(end).trimStart();
      return chunk || null;
    }

    const availableEnd = fence?.start ?? streamBuffer.length;
    const available = streamBuffer.slice(0, availableEnd);
    const mustEmitBeforeFence = !!fence;

    const minChunk = Math.min(120, Math.max(60, Math.floor(maxChars / 2)));
    const punctuationMatches = [...available.matchAll(/[.!?;:]\s+/g)];
    const lastBoundary = punctuationMatches
      .filter((match) => (match.index ?? 0) + match[0].length <= maxChars)
      .at(-1);
    if (lastBoundary?.index !== undefined) {
      const end = lastBoundary.index + lastBoundary[0].length;
      if (end >= minChunk) {
        const chunk = streamBuffer.slice(0, end).trim();
        streamBuffer = streamBuffer.slice(end).trimStart();
        return chunk;
      }
    }

    if (!force && !mustEmitBeforeFence && available.length < maxChars) return null;
    const maximum = Math.min(maxChars, available.length);
    const end = available.lastIndexOf(" ", maximum);
    const cut = mustEmitBeforeFence && available.length <= maxChars
      ? available.length
      : end >= minChunk
        ? end
        : maximum;
    const chunk = available.slice(0, cut).trim();
    streamBuffer = streamBuffer.slice(cut).trimStart();
    return chunk;
  }

  function flushStreamingAutoTTS(config: FullVoiceConfig, force = false): void {
    const remote = remoteConfig(config);
    const jobId = ++streamJobCounter;
    const chunks: string[] = [];
    while (true) {
      const chunk = nextStreamingChunk(force, remote.chunkMaxChars);
      if (!chunk) break;
      chunks.push(chunk);
      if (!force) break;
    }
    if (chunks.length === 0) return;

    const eventConfig = config.events?.message_update;
    if (!eventConfig || "prompt" in eventConfig || "text" in eventConfig) return;
    const profile = resolveConfiguredProfile(config.speech, eventConfig.profile);
    const generation = activeSpeechGeneration;
    for (const chunk of chunks) {
      enqueueSpeech("auto", generation, true, async (signal) => {
        const speechText = prepareSpeechText(chunk, {
          context: { source: "auto", event: "message_update", role: "assistant" },
          profile,
          pronunciations,
        });
        if (!speechText) return;
        setVoiceStatus(`stream #${jobId} ${speechText.length} chars`);
        await speakPrepared(speechText, config, "auto", signal);
      });
    }
  }

  function handleMessageUpdateTTS(
    // biome-ignore lint/suspicious/noExplicitAny: event shape comes from pi runtime
    event: any,
    config: FullVoiceConfig,
  ): void {
    if (!config.enabled || waitingForUserMessage) return;
    const eventConfig = config.events?.message_update;
    if (!eventConfig || "prompt" in eventConfig || "text" in eventConfig) return;
    if (eventConfig.roles?.length && !eventConfig.roles.includes("assistant")) return;

    const mode = eventConfig.content ?? "text";
    const update = event.assistantMessageEvent;
    if ((mode === "text" || mode === "all") && update?.type === "text_delta") {
      streamBuffer += update.delta;
      flushStreamingAutoTTS(config);
      return;
    }
    if ((mode === "thinking" || mode === "all") && update?.type === "thinking_delta") {
      streamBuffer += update.delta;
      flushStreamingAutoTTS(config);
      return;
    }
    if (update?.type === "text_end" || update?.type === "thinking_end" || update?.type === "done") {
      flushStreamingAutoTTS(config, true);
    }
  }

  // ── Server API helpers ─────────────────────────────────────────

  async function fetchHealth(config = getEffective()) {
    try {
      const remote = config.backend === "remote" ? remoteConfig(config) : null;
      const res = await fetch(`${effectiveServerUrl(config)}/health`, {
        headers: remote ? remoteAuthHeaders(remote) : undefined,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Partial<{
        status: string;
        activeDtype: string | null;
        modelLoaded: boolean;
        loading: boolean;
      }>;
      return {
        status: data.status ?? "ok",
        activeDtype: config.backend === "remote" ? "remote" : (data.activeDtype ?? null),
        modelLoaded: config.backend === "remote" ? true : (data.modelLoaded ?? false),
        loading: data.loading ?? false,
      };
    } catch {
      return null;
    }
  }

  async function fetchVoices(config = getEffective()): Promise<string[]> {
    const path = config.backend === "remote" ? "/v1/voices" : "/voices";
    const remote = config.backend === "remote" ? remoteConfig(config) : null;
    const res = await fetch(`${effectiveServerUrl(config)}${path}`, {
      headers: remote ? remoteAuthHeaders(remote) : undefined,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { voices?: string[] } | Array<{ id?: string }>;
    if (Array.isArray(data)) return data.map((voice) => voice.id).filter(Boolean) as string[];
    return data.voices ?? [];
  }

  // ── /voice command ─────────────────────────────────────────────

  pi.registerCommand("voice", {
    description: "Configure TTS voice and speed",
    handler: async (_args, ctx) => {
      const effective = getEffective();

      const health = await fetchHealth(effective);
      let voices: string[] = [];
      if (health?.modelLoaded) {
        try {
          voices = await fetchVoices(effective);
        } catch {
          voices = [];
        }
      }

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        let enabled = effective.enabled;
        let voiceIdx = voices.length > 0 ? Math.max(0, voices.indexOf(effective.voice)) : -1;
        let speedIdx = speedToIndex(effective.speed);
        let selectedRow = 0;
        let playing = false;
        let playError: string | null = null;
        let feedback: string | null = null;

        const rowDefs: Array<{ id: string }> = [
          { id: "enabled" },
          ...(voices.length > 0 ? [{ id: "voice" }] : []),
          { id: "speed" },
        ];

        const sampleText = "The quick brown fox jumps over the lazy dog.";

        function emitConfig() {
          pi.events.emit("voice:config", {
            enabled,
            voice: voices.length > 0 ? voices[voiceIdx] : defaults.voice,
            speed: Number.parseFloat(SPEED_VALUES[speedIdx]),
          });
        }

        async function playSampleTts() {
          const voice = voices.length > 0 ? voices[voiceIdx] : defaults.voice;
          const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
          const sampleConfig = { ...effective, voice, speed };
          const speechText = prepareSpeechText(sampleText, {
            context: { source: "sample" },
            profile: resolveConfiguredProfile(sampleConfig.speech),
            pronunciations,
          });
          const result = await enqueueSpeech(
            "sample",
            activeSpeechGeneration,
            false,
            async (signal) => speakPrepared(speechText, sampleConfig, "sample", signal),
          );
          if (result.status === "failed") throw result.error;
        }

        return {
          render(_width: number) {
            const lines: string[] = [];

            // Title
            lines.push(theme.fg("accent", theme.bold("Voice")));

            // Server status
            const statusText = health
              ? health.modelLoaded
                ? `● Server running (${health.activeDtype})`
                : health.loading
                  ? "◐ Server loading…"
                  : "○ Server up (no model)"
              : "✗ Server not detected";
            const statusColor = health?.modelLoaded
              ? "success"
              : health?.loading
                ? "warning"
                : health
                  ? "dim"
                  : "dim";
            lines.push(`  ${theme.fg(statusColor, statusText)}`);
            const serverHint = health?.modelLoaded
              ? theme.fg("dim", "  pi-voice server stop to stop")
              : health
                ? theme.fg("dim", "  pi-voice server start to start")
                : theme.fg("dim", "  pi-voice server start to start");
            lines.push(serverHint);

            // Active events
            const activeEvents = effective.events ? Object.keys(effective.events) : [];
            if (activeEvents.length > 0) {
              lines.push(`  ${theme.fg("dim", `Events: ${activeEvents.join(", ")}`)}`);
            }

            const stt = sttConfig(effective);
            lines.push(
              `  ${theme.fg(stt.enabled ? "success" : "dim", `STT: ${stt.enabled ? "on" : "off"} (${stt.enabled ? sttStatus : "disabled"})`)}`,
            );
            lines.push(`  ${theme.fg("dim", "Use /dictate for voice input")}`);

            // Setting rows
            for (let i = 0; i < rowDefs.length; i++) {
              const row = rowDefs[i];
              const selected = i === selectedRow;
              const cursor = selected ? "→" : " ";

              if (row.id === "enabled") {
                const val = enabled ? "on" : "off";
                const left = selected ? "◂ " : "  ";
                const right = selected ? " ▸" : "";
                lines.push(`${cursor} TTS    ${left}${val}${right}`);
              } else if (row.id === "voice") {
                const val = voices[voiceIdx] ?? "";
                const hint = voiceHint(val);
                const left = selected ? "◂ " : "  ";
                const right = selected ? " ▸" : "";
                lines.push(
                  `${cursor} Voice  ${left}${val}${right} ${theme.fg("dim", `(${hint})`)}`,
                );
              } else if (row.id === "speed") {
                const val = SPEED_VALUES[speedIdx];
                const left = selected ? "◂ " : "  ";
                const right = selected ? " ▸" : "";
                lines.push(`${cursor} Speed  ${left}${val}${right}`);
              }
            }

            lines.push("");

            if (playing) {
              lines.push(`  ${theme.fg("warning", "▶ Playing sample…")}`);
            } else if (playError) {
              lines.push(`  ${theme.fg("error", `✗ ${playError}`)}`);
            } else if (feedback) {
              lines.push(`  ${theme.fg("success", feedback)}`);
            }

            lines.push(
              theme.fg("dim", " ↑↓ navigate • ←→ change • s save default • r reset • esc close"),
            );

            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "escape")) {
              persistSession();
              done(undefined);
              return;
            }

            if (playError) playError = null;
            if (feedback) feedback = null;

            if (playing) return;

            if (matchesKey(data, "s")) {
              const voice = voices.length > 0 ? voices[voiceIdx] : defaults.voice;
              const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
              defaults = { ...defaults, enabled, voice, speed };
              saveConfig(defaults);
              feedback = "✓ Saved as default";
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "r")) {
              session = {};
              // Write full defaults (including agent_end event) back to disk
              saveConfig({ ...DEFAULT_CONFIG }, true);
              reloadRuntimeConfig();
              persistSession();
              enabled = defaults.enabled;
              voiceIdx = voices.length > 0 ? Math.max(0, voices.indexOf(defaults.voice)) : -1;
              speedIdx = speedToIndex(defaults.speed);
              emitConfig();
              feedback = "✓ Reset to defaults";
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "up")) {
              selectedRow = (selectedRow - 1 + rowDefs.length) % rowDefs.length;
              _tui.requestRender();
              return;
            }
            if (matchesKey(data, "down")) {
              selectedRow = (selectedRow + 1) % rowDefs.length;
              _tui.requestRender();
              return;
            }

            const rowId = rowDefs[selectedRow]?.id;

            if (matchesKey(data, "left") || matchesKey(data, "right")) {
              const dir = matchesKey(data, "right") ? 1 : -1;
              if (rowId === "enabled") {
                enabled = !enabled;
                session.enabled = enabled;
              } else if (rowId === "voice" && voices.length > 0) {
                voiceIdx = (voiceIdx + dir + voices.length) % voices.length;
                session.voice = voices[voiceIdx];
              } else if (rowId === "speed") {
                speedIdx = (speedIdx + dir + SPEED_VALUES.length) % SPEED_VALUES.length;
                const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
                session.speed = speed;
              }
              persistSession();
              emitConfig();
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "enter")) {
              playing = true;
              playError = null;
              _tui.requestRender();
              playSampleTts()
                .then(() => {
                  playing = false;
                  _tui.requestRender();
                })
                .catch((err: unknown) => {
                  playing = false;
                  playError = err instanceof Error ? err.message : String(err);
                  _tui.requestRender();
                });
              return;
            }
          },
        };
      });
    },
  });

  pi.registerCommand("voice-debug", {
    description: "Show pi-voice runtime config and backend status",
    handler: async (_args, ctx) => {
      reloadRuntimeConfig();
      const effective = getEffective();
      const health = await fetchHealth(effective);
      const remote = remoteConfig(effective);
      const stt = sttConfig(effective);
      const player = streamingPcmPlayer();
      const events = effective.events ? Object.keys(effective.events) : [];
      const configExists = existsSync(CONFIG_PATH);
      const configBytes = configExists ? readFileSync(CONFIG_PATH, "utf-8").length : 0;

      await ctx.ui.custom(
        (_tui, theme, _kb, done) => ({
          render() {
            const lines = [
              theme.bold("pi-voice debug"),
              "",
              `runtime config: ${CONFIG_PATH}`,
              `runtime config exists: ${configExists ? "yes" : "no"}${configExists ? ` (${configBytes} bytes)` : ""}`,
              `debug log: ${DEBUG_LOG_PATH}`,
              "template config: config/voice-config.example.json (copy manually or via scripts/install-server-macos.sh)",
              "",
              `enabled: ${effective.enabled}`,
              `backend: ${effective.backend}`,
              `voice: ${effective.voice}`,
              `speed: ${effective.speed}`,
              `local url: http://${effective.host}:${effective.port}`,
              `remote url: ${remote.baseUrl}`,
              `remote auth token: ${remote.authToken.trim() ? "configured" : "not configured"}`,
              `remote speech path: ${remote.speechPath}`,
              `remote stream path: ${remote.streamPath}`,
              `remote stream: ${remote.stream} (${remote.streamFormat})`,
              `remote chunk fallback: ${remote.chunkText} (${remote.chunkMaxChars} chars)`,
              `streaming player: ${player ? player.command : "none; using chunked WAV fallback"}`,
              `stt: ${stt.enabled ? "enabled" : "disabled"} (${sttStatus})`,
              `stt model dir: ${stt.modelDir}`,
              `stt language: ${stt.language ?? "auto"}`,
              `stt audio cues: ${stt.audioCues ? "enabled" : "disabled"}`,
              `events: ${events.length ? events.join(", ") : "none"}`,
              `queue on user input: ${effective.speech?.queue.onUserInput ?? "continue"}`,
              `speech profile: ${effective.speech?.processing.defaultProfile ?? "technical"}`,
              `pronunciation rules: ${pronunciations.rules.length}`,
              `speech jobs: ${speechScheduler.active ? "1 active" : "idle"}, ${speechScheduler.queued.length} queued`,
              `footer status: ${statusLine(effective)}`,
              "",
              `health: ${health ? `${health.status} modelLoaded=${health.modelLoaded} active=${health.activeDtype}` : "offline"}`,
              "",
              theme.fg("dim", "esc/enter closes"),
            ];
            if (effective.backend === "local" && effective.remote) {
              lines.splice(8, 0, theme.fg("warning", "remote block is configured but inactive because backend is local"));
            }
            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "escape") || matchesKey(data, "enter")) done(undefined);
          },
        }),
        { overlay: true },
      );
    },
  });

  pi.registerCommand("voice-reload", {
    description: "Reload pi-voice config and pronunciation rules",
    handler: async (_args, ctx) => {
      reloadRuntimeConfig();
      registerCustomEvents();
      updateStatusBar();
      ctx.ui.notify(
        `Voice config reloaded (${pronunciations.rules.length} pronunciation rules)`,
        "info",
      );
    },
  });

  pi.registerCommand("voice-log", {
    description: "Show recent pi-voice debug log lines",
    handler: async (_args, ctx) => {
      const lines = readDebugLogTail(40);
      await ctx.ui.custom(
        (_tui, theme, _kb, done) => ({
          render() {
            return [
              theme.bold("pi-voice debug log"),
              DEBUG_LOG_PATH,
              "",
              ...(lines.length ? lines : [theme.fg("dim", "No log entries yet.")]),
              "",
              theme.fg("dim", "esc/enter closes"),
            ];
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "escape") || matchesKey(data, "enter")) done(undefined);
          },
        }),
        { overlay: true },
      );
    },
  });

  pi.registerCommand("dictate", {
    description: "Dictate a prompt with local speech-to-text, then paste it into the editor",
    handler: async (_args, ctx) => {
      await runDictation(ctx);
    },
  });

  // ── tts tool ─────────────────────────────────────────────────

  pi.registerTool({
    name: "tts",
    label: "Text to Speech",
    description:
      "Convert text to speech audio using the Kokoro TTS server. Saves a WAV file and plays it.",
    promptSnippet: "Convert text to speech and play audio",
    promptGuidelines: [
      "Use tts when the user wants to hear text spoken aloud or convert text to audio.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Text to convert to speech" }),
      voice: Type.Optional(
        Type.String({ description: "Voice name (defaults to configured voice)" }),
      ),
      speed: Type.Optional(
        Type.Number({
          description: "Speech speed 0.5-3.0 (defaults to configured speed)",
          minimum: 0.5,
          maximum: 3.0,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const effective = getEffective();

      if (!effective.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: "TTS is currently disabled. Use /voice to enable it.",
            },
          ],
          details: {},
        };
      }
      if (waitingForUserMessage) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Speech skipped because newer user input is waiting to be processed.",
            },
          ],
          details: { cancelled: true },
        };
      }

      const ttsParams = params as { text: string; voice?: string; speed?: number };
      const voice = ttsParams.voice ?? effective.voice;
      const speed = ttsParams.speed ?? effective.speed;
      const speechText = prepareSpeechText(ttsParams.text, {
        context: { source: "tool", role: "assistant" },
        profile: resolveConfiguredProfile(effective.speech),
        pronunciations,
      });

      if (!speechText) {
        return {
          content: [{ type: "text" as const, text: "No speakable text was provided." }],
          details: {},
        };
      }

      const generation = activeSpeechGeneration;
      enqueueSpeech("tool", generation, true, async (signal) => {
        const combinedSignal = _signal ? AbortSignal.any([signal, _signal]) : signal;
        await speakPrepared(
          speechText,
          { ...effective, voice, speed },
          "tool",
          combinedSignal,
        );
      });

      const preview = speechText.length > 80 ? `${speechText.slice(0, 80)}…` : speechText;
      return {
        content: [{ type: "text" as const, text: `Speaking: "${preview}"` }],
        details: {},
      };
    },
  });

  // ── Status bar ────────────────────────────────────────────────

  function updateStatusBar() {
    if (!currentCtx) return;
    const effective = getEffective();
    const theme = currentCtx.ui.theme;
    const color = effective.enabled ? "success" : "dim";
    currentCtx.ui.setStatus("pi-voice", theme.fg(color, statusLine(effective)));
  }

  // ── Session lifecycle ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    restoreSession(ctx);
    registerCustomEvents();
    updateStatusBar();
  });

  pi.on("session_tree", async (_event, ctx) => {
    speechScheduler.cancelAll("session-tree");
    await speechScheduler.whenIdle();
    streamBuffer = "";
    waitingForUserMessage = false;
    pendingUserGenerations.length = 0;
    toolCalls.clear();
    currentCtx = ctx;
    restoreSession(ctx);
    registerCustomEvents();
    updateStatusBar();
  });

  pi.on("session_shutdown", async () => {
    speechScheduler.cancelAll("session-shutdown");
    await speechScheduler.whenIdle();
    streamBuffer = "";
    toolCalls.clear();
    for (const unsub of customUnsubs) unsub();
    customUnsubs.length = 0;
  });

  pi.on("input", async (event) => {
    const speech = getEffective().speech ?? DEFAULT_SPEECH_CONFIG;
    if (!speech.queue.inputSources.includes(event.source)) return { action: "continue" as const };
    if (event.streamingBehavior === undefined && pendingUserGenerations.length > 0) {
      pendingUserGenerations.length = 0;
    }
    const generation = ++nextSpeechGeneration;
    pendingUserGenerations.push({ generation, text: event.text.trim() });
    waitingForUserMessage = speech.queue.onUserInput !== "continue";
    streamBuffer = "";
    const cancelled = speechScheduler.cancelBeforeGeneration(
      generation,
      speech.queue.onUserInput,
    );
    debugLog("user_input_speech_policy", {
      source: event.source,
      policy: speech.queue.onUserInput,
      generation,
      cancelled,
    });
    return { action: "continue" as const };
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "user") return;
    const messageText = extractMessageContent(event.message.content, "text").trim();
    const matchingIndex = pendingUserGenerations.findIndex(
      (pending) => pending.text === messageText,
    );
    const consumedIndex = matchingIndex >= 0 ? matchingIndex : 0;
    const consumed = pendingUserGenerations[consumedIndex];
    if (consumed) pendingUserGenerations.splice(0, consumedIndex + 1);
    activeSpeechGeneration = consumed?.generation ?? ++nextSpeechGeneration;
    const speech = getEffective().speech ?? DEFAULT_SPEECH_CONFIG;
    waitingForUserMessage =
      speech.queue.onUserInput !== "continue" && pendingUserGenerations.length > 0;
  });

  pi.on("tool_execution_start", async (event) => {
    toolCalls.set(event.toolCallId, {
      name: event.toolName,
      args: event.args && typeof event.args === "object" ? event.args : {},
    });
  });

  // Update status bar on voice:config events (from TUI, alt+v, etc.)
  pi.events.on("voice:config", () => {
    updateStatusBar();
  });

  // ── Global toggle shortcut (alt+v) ────────────────────────────

  pi.registerShortcut("alt+v", {
    description: "Toggle TTS on/off",
    handler: async (ctx) => {
      const effective = getEffective();
      const next = !effective.enabled;
      session.enabled = next;
      if (!next) {
        speechScheduler.cancelAll("tts-disabled");
        streamBuffer = "";
      }
      persistSession();
      ctx.ui.notify(`TTS ${next ? "enabled" : "disabled"}`, "info");
      pi.events.emit("voice:config", {
        enabled: next,
        voice: effective.voice,
        speed: effective.speed,
      });
    },
  });

  // ── Auto-TTS event handlers ─────────────────────────────────────

  // Built-in pi events that carry message data.
  // Each handler checks at runtime if the event is configured.
  // Note: pi.on() requires literal event names (not variables) for type safety.

  pi.on("agent_end", async (event, ctx) => {
    const effective = getEffective();
    enqueueAutoTTS("agent_end", event, ctx, effective);
  });

  pi.on("turn_end", async (event, ctx) => {
    const effective = getEffective();
    enqueueAutoTTS("turn_end", event, ctx, effective);
  });

  pi.on("message_end", async (event, ctx) => {
    const effective = getEffective();
    enqueueAutoTTS("message_end", event, ctx, effective);
  });

  pi.on("message_update", async (event) => {
    const effective = getEffective();
    handleMessageUpdateTTS(event, effective);
  });

  const builtinEventNames = new Set(["agent_end", "turn_end", "message_end", "message_update"]);

  // Custom events from other extensions (via shared event bus).
  // Any event name in config that isn't a built-in pi event is treated
  // as a custom event. If the event config has a `text` field, it's
  // spoken directly without LLM summarization.

  const customUnsubs: Array<() => void> = [];

  function registerCustomEvents() {
    // Remove previous listeners
    for (const unsub of customUnsubs) unsub();
    customUnsubs.length = 0;

    const events = defaults.events;
    if (!events) return;

    for (const eventName of Object.keys(events)) {
      if (builtinEventNames.has(eventName)) continue;
      const unsub = pi.events.on(eventName, (data: unknown) => {
        if (!currentCtx) return;
        const effective = getEffective();
        enqueueAutoTTS(eventName, data, currentCtx, effective);
      });
      customUnsubs.push(unsub);
    }
  }

  registerCustomEvents();
}
