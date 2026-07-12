import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

export interface SttRuntimeConfig {
  enabled: boolean;
  modelDir: string;
  language?: string;
  audioCues: boolean;
  startCue: string;
  finishCue: string;
}

export interface SttProgress {
  phase: "downloading" | "extracting" | "verifying" | "loading_engine" | "initializing_mic";
  message: string;
  percent?: number;
  bytesReceived?: number;
  totalBytes?: number;
}

export interface LocalSttSession {
  finalTranscript: Promise<string>;
  stop(): void;
  setPaused(paused: boolean): void;
}

export interface LocalSttCallbacks {
  onProgress(progress: SttProgress): void;
  onAudioLevel(level: number): void;
  onPartial(text: string): void;
  onTranscript(text: string): void;
  onError(error: unknown): void;
}

export interface LocalSttOptions {
  startPaused?: boolean;
}

interface ModelPaths {
  encoderPath: string;
  decoderPath: string;
  tokensPath: string;
}

interface SttEngine {
  recognize(samples: Float32Array, sampleRate: number): Promise<string>;
  release(): void;
}

interface DecibriLike extends EventEmitter {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "silence", listener: () => void): this;
  once(event: "end" | "error" | "close", listener: (err?: Error) => void): this;
  stop(): void;
}

interface DecibriDevice {
  index: number;
  name: string;
  maxInputChannels: number;
  defaultSampleRate: number;
  isDefault: boolean;
}

interface DecibriCtor {
  new (opts: Record<string, unknown>): EventEmitter & { stop(): void };
  devices?(): DecibriDevice[];
}

const TARGET_SAMPLE_RATE = 16000;
const WHISPER_FEATURE_DIM = 80;
const DEFAULT_NUM_THREADS = 4;
const DEFAULT_PROVIDER = "cpu";
const DEFAULT_TAIL_PADDINGS = 1000;
const FRAMES_PER_BUFFER = 1600;
const MAX_SEGMENT_MS = 12000;
const MAX_SEGMENT_SAMPLES = (TARGET_SAMPLE_RATE * MAX_SEGMENT_MS) / 1000;
const CAP_CUT_SCAN_MS = 800;
const CAP_CUT_SCAN_SAMPLES = (TARGET_SAMPLE_RATE * CAP_CUT_SCAN_MS) / 1000;
const PARTIAL_DECODE_INTERVAL_MS = 1000;
const MIN_SEGMENT_RMS = 0.005;
const SILERO_THRESHOLD = 0.5;
const VAD_RMS_THRESHOLD = 0.015;
const VAD_HOLDOFF_MS = 500;
const STARTUP_RACE_MS = 1500;
const FALLBACK_CAPTURE_RATES = [48000, 44100, 96000] as const;
const MODEL_ARCHIVE_NAME = "sherpa-onnx-whisper-base.tar.bz2";
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ARCHIVE_NAME}`;
const ENCODER_FILE = "base-encoder.int8.onnx";
const DECODER_FILE = "base-decoder.int8.onnx";
const TOKENS_FILE = "base-tokens.txt";
const SENTINEL_FILE = ".download-complete";
const REQUIRED_FILES = [ENCODER_FILE, DECODER_FILE, TOKENS_FILE] as const;
const FP32_DUPLICATE_FILES = ["base-encoder.onnx", "base-decoder.onnx"] as const;
const DOWNLOAD_PROGRESS_THROTTLE_MS = 200;
const BYTES_PER_INT16 = 2;
const INT16_FULL_SCALE = 0x8000;

export function defaultSttModelDir(): string {
  return join(homedir(), ".pi", "models", "whisper-base");
}

export async function startLocalSttSession(
  config: SttRuntimeConfig,
  callbacks: LocalSttCallbacks,
  options: LocalSttOptions = {},
): Promise<LocalSttSession> {
  await assertSttDependencies();
  callbacks.onProgress({ phase: "downloading", message: "Preparing STT model..." });
  const modelPaths = await ensureModelDownloaded(config.modelDir, callbacks.onProgress);

  callbacks.onProgress({ phase: "loading_engine", message: "Loading STT engine..." });
  const sttEngine = await createSttEngine({ ...modelPaths, language: config.language });

  callbacks.onProgress({ phase: "initializing_mic", message: "Initializing microphone..." });
  let mic: DecibriLike;
  try {
    mic = await createMic();
  } catch (error) {
    sttEngine.release();
    throw error;
  }

  return startDictationPipeline(mic, sttEngine, callbacks, options.startPaused ?? false);
}

async function assertSttDependencies(): Promise<void> {
  try {
    await importSttDependency("sherpa-onnx-node");
  } catch (error) {
    throw new Error(`Missing STT dependency sherpa-onnx-node. Reinstall pi-voice dependencies. ${errorText(error)}`);
  }
  try {
    await importSttDependency("decibri");
  } catch (error) {
    throw new Error(`Missing STT dependency decibri. Reinstall pi-voice dependencies. ${errorText(error)}`);
  }
}

async function importSttDependency(name: string): Promise<Record<string, unknown>> {
  try {
    return (await import(name)) as Record<string, unknown>;
  } catch (firstError) {
    const searchRoots = [process.cwd(), join(homedir(), ".pi", "agent", "npm")];
    for (const root of searchRoots) {
      try {
        const resolved = requireFromHere.resolve(name, { paths: [root] });
        return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
      } catch {
        /* try next root */
      }
    }
    throw firstError;
  }
}

async function ensureModelDownloaded(
  modelDir: string,
  onProgress: (progress: SttProgress) => void,
): Promise<ModelPaths> {
  if (isModelDownloaded(modelDir)) {
    verifyModelFiles(modelDir);
    return getModelPaths(modelDir);
  }

  mkdirSync(modelDir, { recursive: true });
  const archivePath = join(modelDir, MODEL_ARCHIVE_NAME);

  try {
    onProgress({ phase: "downloading", message: "Downloading Whisper STT model..." });
    await downloadArchive(MODEL_URL, archivePath, (stats) => {
      const percent = stats.totalBytes
        ? Math.min(100, Math.floor((stats.bytesReceived / stats.totalBytes) * 100))
        : undefined;
      onProgress({
        phase: "downloading",
        message: "Downloading Whisper STT model...",
        percent,
        bytesReceived: stats.bytesReceived,
        totalBytes: stats.totalBytes,
      });
    });

    onProgress({ phase: "extracting", message: "Extracting STT model..." });
    await execFileAsync("tar", ["-xjf", archivePath, "-C", modelDir, "--strip-components=1"]);
    rmSync(archivePath, { force: true });
    for (const file of FP32_DUPLICATE_FILES) rmSync(join(modelDir, file), { force: true });

    onProgress({ phase: "verifying", message: "Verifying STT model..." });
    verifyModelFiles(modelDir);
    writeFileSync(join(modelDir, SENTINEL_FILE), "", "utf-8");
    return getModelPaths(modelDir);
  } catch (error) {
    rmSync(modelDir, { recursive: true, force: true });
    throw error;
  }
}

function isModelDownloaded(modelDir: string): boolean {
  return existsSync(join(modelDir, SENTINEL_FILE));
}

function getModelPaths(modelDir: string): ModelPaths {
  return {
    encoderPath: join(modelDir, ENCODER_FILE),
    decoderPath: join(modelDir, DECODER_FILE),
    tokensPath: join(modelDir, TOKENS_FILE),
  };
}

function verifyModelFiles(modelDir: string): void {
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(modelDir, file))) throw new Error(`STT model missing ${file}`);
  }
}

async function downloadArchive(
  url: string,
  destPath: string,
  onStats: (stats: { bytesReceived: number; totalBytes?: number }) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`STT model download failed: HTTP ${response.status}`);

  const totalBytes = parsePositiveInt(response.headers.get("content-length"));
  let bytesReceived = 0;
  let lastEmitMs = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesReceived += chunk.length;
      const now = Date.now();
      const isFinal = totalBytes !== undefined && bytesReceived >= totalBytes;
      if (isFinal || now - lastEmitMs >= DOWNLOAD_PROGRESS_THROTTLE_MS) {
        lastEmitMs = now;
        onStats({ bytesReceived, totalBytes });
      }
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body as never), tap, createWriteStream(destPath));
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function createSttEngine(config: ModelPaths & { language?: string }): Promise<SttEngine> {
  const mod = (await importSttDependency("sherpa-onnx-node")) as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const ns = mod.default ?? mod;
  const OfflineRecognizer = ns.OfflineRecognizer as new (config: Record<string, unknown>) => {
    createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
    decode(stream: unknown): void;
    getResult(stream: unknown): { text?: string };
  };
  if (!OfflineRecognizer) throw new Error("sherpa-onnx-node OfflineRecognizer is unavailable");

  const recognizer = new OfflineRecognizer({
    featConfig: {
      sampleRate: TARGET_SAMPLE_RATE,
      featureDim: WHISPER_FEATURE_DIM,
    },
    modelConfig: {
      whisper: {
        encoder: config.encoderPath,
        decoder: config.decoderPath,
        tailPaddings: DEFAULT_TAIL_PADDINGS,
        ...(config.language ? { language: config.language } : {}),
      },
      tokens: config.tokensPath,
      numThreads: DEFAULT_NUM_THREADS,
      provider: DEFAULT_PROVIDER,
    },
  });

  return {
    async recognize(samples: Float32Array, sampleRate: number): Promise<string> {
      if (samples.length === 0) return "";
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate });
      recognizer.decode(stream);
      return (recognizer.getResult(stream).text ?? "").trim();
    },
    release() {
      /* sherpa-onnx-node handles native lifetime through GC. */
    },
  };
}

async function createMic(): Promise<DecibriLike> {
  const mod = (await importSttDependency("decibri")) as unknown as { default?: DecibriCtor } & DecibriCtor;
  const Decibri = mod.default ?? mod;
  if (typeof Decibri !== "function") throw new Error("decibri microphone capture is unavailable");

  try {
    return await openMicAtRate(Decibri, TARGET_SAMPLE_RATE, "silero-passthrough");
  } catch (sileroError) {
    const rates = pickCaptureRates(Decibri).filter((rate) => rate !== TARGET_SAMPLE_RATE);
    let lastError = sileroError;
    for (const rate of rates) {
      try {
        return await openMicAtRate(Decibri, rate, "resample-rms");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

type MicMode = "silero-passthrough" | "resample-rms";

function openMicAtRate(Decibri: DecibriCtor, sourceRate: number, mode: MicMode): Promise<DecibriLike> {
  return new Promise((resolve, reject) => {
    const captureBufferFrames = Math.max(1, Math.round((FRAMES_PER_BUFFER * sourceRate) / TARGET_SAMPLE_RATE));
    const opts: Record<string, unknown> = {
      sampleRate: sourceRate,
      channels: 1,
      framesPerBuffer: captureBufferFrames,
      format: "int16",
    };
    if (mode === "silero-passthrough") {
      opts.vad = true;
      opts.vadMode = "silero";
      opts.vadThreshold = SILERO_THRESHOLD;
      opts.vadHoldoff = VAD_HOLDOFF_MS;
    }

    let raw: EventEmitter & { stop(): void };
    try {
      raw = new Decibri(opts);
    } catch (error) {
      reject(new Error(`microphone open failed at ${sourceRate} Hz: ${errorText(error)}`));
      return;
    }

    const wrapper = mode === "silero-passthrough"
      ? new SileroPassthroughAdapter(raw)
      : new ResamplingRmsAdapter(raw, sourceRate);
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      raw.removeListener("error", onError);
      raw.removeListener("data", onData);
      fn();
    };
    const onError = (error: unknown) =>
      settle(() => {
        try {
          raw.stop();
        } catch {
          /* ignore */
        }
        reject(new Error(`microphone open failed at ${sourceRate} Hz: ${errorText(error)}`));
      });
    const onData = () => settle(() => resolve(wrapper));
    const timer = setTimeout(() => settle(() => resolve(wrapper)), STARTUP_RACE_MS);
    raw.once("error", onError);
    raw.once("data", onData);
  });
}

function pickCaptureRates(Decibri: DecibriCtor): number[] {
  let defaultRate: number | null = null;
  try {
    const devices = typeof Decibri.devices === "function" ? Decibri.devices() : [];
    const def = devices.find((device) => device.isDefault && device.maxInputChannels >= 1);
    if (def && def.defaultSampleRate > 0) defaultRate = def.defaultSampleRate;
  } catch {
    /* device enumeration is best-effort */
  }
  const ordered: number[] = [];
  if (defaultRate !== null) ordered.push(defaultRate);
  for (const rate of FALLBACK_CAPTURE_RATES) if (!ordered.includes(rate)) ordered.push(rate);
  return ordered;
}

function startDictationPipeline(
  mic: DecibriLike,
  sttEngine: SttEngine,
  callbacks: LocalSttCallbacks,
  startPaused: boolean,
): LocalSttSession {
  let speechBuffer: Buffer[] = [];
  let speechBufferSamples = 0;
  let transcript = "";
  let recognizing: Promise<void> = Promise.resolve();
  let paused = startPaused;
  let partialInFlight = false;
  let lastPartialAt = 0;
  let utteranceEpoch = 0;
  let stopped = false;

  const recognizeFinal = async (chunks: Buffer[]): Promise<void> => {
    if (chunks.length === 0) return;
    const samples = bufferToFloat32(Buffer.concat(chunks));
    if (computeRmsFloat32(samples) < MIN_SEGMENT_RMS) {
      callbacks.onPartial("");
      return;
    }
    try {
      const text = await sttEngine.recognize(samples, TARGET_SAMPLE_RATE);
      if (!text || isHallucination(text)) {
        callbacks.onPartial("");
        return;
      }
      transcript = transcript ? `${transcript} ${text}` : text;
      callbacks.onTranscript(text);
      callbacks.onPartial("");
    } catch (error) {
      callbacks.onError(error);
      callbacks.onPartial("");
    }
  };

  const flushBuffer = (): void => {
    if (speechBuffer.length === 0) return;
    const chunks = speechBuffer;
    speechBuffer = [];
    speechBufferSamples = 0;
    utteranceEpoch++;
    recognizing = recognizing.then(() => recognizeFinal(chunks));
  };

  const queueCapFlush = (): void => {
    const cutIdx = findLowestEnergyCutIndex(speechBuffer);
    if (cutIdx <= 0 || cutIdx >= speechBuffer.length) {
      flushBuffer();
      return;
    }
    const head = speechBuffer.slice(0, cutIdx);
    const tail = speechBuffer.slice(cutIdx);
    speechBuffer = tail;
    speechBufferSamples = countSamples(tail);
    utteranceEpoch++;
    recognizing = recognizing.then(() => recognizeFinal(head));
  };

  const tryEmitPartial = (): void => {
    if (partialInFlight || speechBuffer.length === 0) return;
    const now = Date.now();
    if (now - lastPartialAt < PARTIAL_DECODE_INTERVAL_MS) return;
    lastPartialAt = now;
    partialInFlight = true;
    const snapshotEpoch = utteranceEpoch;
    const snapshot = speechBuffer.slice();
    void (async () => {
      try {
        const samples = bufferToFloat32(Buffer.concat(snapshot));
        if (computeRmsFloat32(samples) < MIN_SEGMENT_RMS) return;
        const text = await sttEngine.recognize(samples, TARGET_SAMPLE_RATE);
        if (snapshotEpoch !== utteranceEpoch || isHallucination(text)) return;
        callbacks.onPartial(text);
      } catch (error) {
        callbacks.onError(error);
      } finally {
        partialInFlight = false;
      }
    })();
  };

  mic.on("data", (chunk: Buffer) => {
    callbacks.onAudioLevel(computeRmsInt16(chunk));
    if (paused) return;
    speechBuffer.push(chunk);
    speechBufferSamples += samplesInInt16Chunk(chunk);
    if (speechBufferSamples >= MAX_SEGMENT_SAMPLES) queueCapFlush();
    else tryEmitPartial();
  });
  mic.on("silence", () => {
    if (!paused) flushBuffer();
  });

  const finalTranscript = waitForMicShutdown(mic, async () => {
    flushBuffer();
    await recognizing;
    sttEngine.release();
    return transcript;
  });

  return {
    finalTranscript,
    stop() {
      if (stopped) return;
      stopped = true;
      mic.stop();
    },
    setPaused(value: boolean) {
      paused = value;
    },
  };
}

function waitForMicShutdown(mic: DecibriLike, onFinish: () => Promise<string>): Promise<string> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      resolve(await onFinish());
    };
    mic.once("end", finish);
    mic.once("error", finish);
    mic.once("close", finish);
  });
}

class MicAdapterBase extends EventEmitter implements DecibriLike {
  private readonly pending: Array<{ event: string; args: unknown[] }> = [];
  private drained = false;
  protected readonly raw: EventEmitter & { stop(): void };

  constructor(raw: EventEmitter & { stop(): void }) {
    super();
    this.raw = raw;
    const onNewListener = (event: string) => {
      if (this.drained || event === "newListener") return;
      this.drained = true;
      this.removeListener("newListener", onNewListener);
      queueMicrotask(() => {
        for (const item of this.pending) this.emit(item.event, ...item.args);
        this.pending.length = 0;
      });
    };
    this.on("newListener", onNewListener);
  }

  stop(): void {
    this.raw.stop();
  }

  protected emitOrQueue(event: string, ...args: unknown[]): void {
    if (this.drained) this.emit(event, ...args);
    else this.pending.push({ event, args });
  }
}

class SileroPassthroughAdapter extends MicAdapterBase {
  constructor(raw: EventEmitter & { stop(): void }) {
    super(raw);
    raw.on("data", (chunk: Buffer) => this.emitOrQueue("data", chunk));
    raw.on("silence", () => this.emitOrQueue("silence"));
    raw.once("end", () => this.emitOrQueue("end"));
    raw.once("error", (error: Error) => this.emitOrQueue("error", error));
    raw.once("close", () => this.emitOrQueue("close"));
  }
}

class ResamplingRmsAdapter extends MicAdapterBase {
  private readonly resampler: Int16LinearResampler;
  private inSpeech = false;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(raw: EventEmitter & { stop(): void }, sourceRate: number) {
    super(raw);
    this.resampler = new Int16LinearResampler(sourceRate, TARGET_SAMPLE_RATE);
    raw.on("data", (chunk: Buffer) => this.onRawData(chunk));
    raw.once("end", () => this.emitOrQueue("end"));
    raw.once("error", (error: Error) => this.emitOrQueue("error", error));
    raw.once("close", () => this.emitOrQueue("close"));
  }

  override stop(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    super.stop();
  }

  private onRawData(chunk: Buffer): void {
    const resampled = this.resampler.process(chunk);
    if (resampled.length === 0) return;
    this.emitOrQueue("data", resampled);
    this.runSilenceDetector(resampled);
  }

  private runSilenceDetector(chunk: Buffer): void {
    const rms = computeRmsInt16(chunk);
    if (rms >= VAD_RMS_THRESHOLD) {
      this.inSpeech = true;
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
      return;
    }
    if (this.inSpeech && this.silenceTimer === null) {
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null;
        this.inSpeech = false;
        this.emitOrQueue("silence");
      }, VAD_HOLDOFF_MS);
    }
  }
}

class Int16LinearResampler {
  private readonly step: number;
  private prev = 0;
  private frac = 0;
  private primed = false;

  constructor(sourceRate: number, targetRate: number) {
    if (sourceRate <= 0 || targetRate <= 0) throw new Error("resampler rates must be positive");
    this.step = sourceRate / targetRate;
  }

  process(input: Buffer): Buffer {
    const inSampleCount = Math.floor(input.length / BYTES_PER_INT16);
    if (inSampleCount === 0) return Buffer.alloc(0);
    const maxOut = Math.ceil(inSampleCount / this.step) + 2;
    const out = Buffer.allocUnsafe(maxOut * BYTES_PER_INT16);
    let outIdx = 0;

    for (let i = 0; i < inSampleCount; i++) {
      const cur = input.readInt16LE(i * BYTES_PER_INT16);
      if (!this.primed) {
        this.prev = cur;
        this.primed = true;
        continue;
      }
      while (this.frac < 1) {
        const v = Math.round(this.prev + (cur - this.prev) * this.frac);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), outIdx * BYTES_PER_INT16);
        outIdx++;
        this.frac += this.step;
      }
      this.frac -= 1;
      this.prev = cur;
    }

    return out.subarray(0, outIdx * BYTES_PER_INT16);
  }
}

function bufferToFloat32(buf: Buffer): Float32Array {
  const sampleCount = Math.floor(buf.length / BYTES_PER_INT16);
  const samples = new Float32Array(sampleCount);
  for (let i = 0, j = 0; j < sampleCount; i += BYTES_PER_INT16, j++) {
    samples[j] = buf.readInt16LE(i) / INT16_FULL_SCALE;
  }
  return samples;
}

function computeRmsInt16(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / BYTES_PER_INT16);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(i * BYTES_PER_INT16) / INT16_FULL_SCALE;
    sumSquares += sample * sample;
  }
  return clamp01(Math.sqrt(sumSquares / sampleCount));
}

function computeRmsFloat32(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / samples.length);
}

function samplesInInt16Chunk(chunk: Buffer): number {
  return Math.floor(chunk.length / BYTES_PER_INT16);
}

function countSamples(chunks: Buffer[]): number {
  let total = 0;
  for (const chunk of chunks) total += samplesInInt16Chunk(chunk);
  return total;
}

function findLowestEnergyCutIndex(chunks: Buffer[]): number {
  if (chunks.length < 2) return chunks.length;
  let scanned = 0;
  let lowestRms = Number.POSITIVE_INFINITY;
  let lowestIdx = chunks.length;
  for (let i = chunks.length - 1; i >= 1; i--) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const rms = computeRmsInt16(chunk);
    if (rms < lowestRms) {
      lowestRms = rms;
      lowestIdx = i;
    }
    scanned += samplesInInt16Chunk(chunk);
    if (scanned >= CAP_CUT_SCAN_SAMPLES) break;
  }
  return lowestIdx;
}

function isHallucination(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return true;
  if (HALLUCINATION_PHRASES.has(normalized)) return true;
  return isRepetitionLoop(normalized);
}

const HALLUCINATION_PHRASES = new Set([
  "thanks for watching",
  "thanks for watching everyone",
  "thank you for watching",
  "please subscribe",
  "please like and subscribe",
  "see you in the next video",
  "see you next time",
  "ill see you in the next video",
  "subtitles by the amaraorg community",
  "transcribed by esoteric",
  "music",
  "applause",
  "silence",
  "you",
  "thank you",
  "bye",
]);

function isRepetitionLoop(normalized: string): boolean {
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length < 4) return false;
  for (let groupSize = 1; groupSize <= 3; groupSize++) {
    const minRepeats = groupSize === 1 ? 4 : 3;
    if (tokens.length < groupSize * minRepeats) continue;
    let allMatch = true;
    for (let i = groupSize; i < tokens.length; i++) {
      if (tokens[i] !== tokens[i % groupSize]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
