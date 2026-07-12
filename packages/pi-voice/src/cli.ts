#!/usr/bin/env -S node --import jiti

/**
 * pi-voice CLI — Manage the Kokoro TTS server and models.
 *
 * Usage:
 *   pi-voice server status              Show server status
 *   pi-voice server start               Start server, load default model
 *   pi-voice server stop                Stop server, unload model
 *   pi-voice server restart             Restart server
 *   pi-voice model list                 List available models
 *   pi-voice model load <name>          Load a model (downloads if needed)
 *   pi-voice model unload               Unload current model
 *   pi-voice model download <name>      Download model without loading
 *   pi-voice model remove <name>        Unload and remove model files
 *   pi-voice say <text>                 Speak text using the active model
 *   pi-voice say --file <path>          Speak the contents of a text file
 *
 * Options:
 *   --host <host>   Override server host (default: 127.0.0.1)
 *   --port <port>   Override server port (default: 8181)
 *
 * Configuration: ~/.pi/voice/config.json
 * PID file:      ~/.pi/voice/voice.pid
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ──────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const SERVER_SCRIPT = resolve(PACKAGE_ROOT, "extensions", "server.ts");
const PI_NPM = process.env.PI_NPM ?? resolve(homedir(), ".pi", "agent", "npm");
const JITI_CLI =
  process.env.JITI_CLI ??
  (existsSync(resolve(PACKAGE_ROOT, "node_modules", "jiti", "lib", "jiti-cli.mjs"))
    ? resolve(PACKAGE_ROOT, "node_modules", "jiti", "lib", "jiti-cli.mjs")
    : existsSync(resolve(PACKAGE_ROOT, "..", "..", "node_modules", "jiti", "lib", "jiti-cli.mjs"))
      ? resolve(PACKAGE_ROOT, "..", "..", "node_modules", "jiti", "lib", "jiti-cli.mjs")
      : resolve(PI_NPM, "node_modules", "jiti", "lib", "jiti-cli.mjs"));
const CONFIG_DIR = resolve(process.env.PI_VOICE_DIR ?? join(homedir(), ".pi", "voice"));
const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
const PID_PATH = resolve(CONFIG_DIR, "voice.pid");

const DTYPES = ["q4", "q4f16", "q8", "fp16", "fp32"] as const;
type DType = (typeof DTYPES)[number];

// ── Config (~/.pi/voice/config.json) ──────────────────────────────

interface VoiceConfig {
  host?: string;
  port?: number;
  defaultModel?: string;
  enabled?: boolean;
  voice?: string;
  speed?: number;
}

const DEFAULT_CONFIG: VoiceConfig = {
  host: "127.0.0.1",
  port: 8181,
  defaultModel: "q4",
};

function loadConfig(): VoiceConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
    }
  } catch {
    /* use defaults */
  }
  return { ...DEFAULT_CONFIG };
}

// ── Argument helpers ───────────────────────────────────────────────

/** Extract --host / --port from args, falling back to config file. */
function resolveHostPort(args: string[]): { host: string; port: number } {
  const config = loadConfig();
  let host = config.host ?? "127.0.0.1";
  let port = config.port ?? 8181;

  const hostValue = optionValue(args, "--host");
  if (hostValue) host = hostValue;

  const portValue = optionValue(args, "--port");
  if (portValue) port = Number.parseInt(portValue, 10);

  return { host, port };
}

/** Split args into positional values and option flags (with their values). */
function splitArgs(args: string[]): { positional: string[]; options: string[] } {
  const positional: string[] = [];
  const options: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      options.push(arg);
      // Include the next token as the option's value
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options.push(next);
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function optionValue(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      const next = args[i + 1];
      return next && !next.startsWith("--") ? next : undefined;
    }
    if (arg?.startsWith(equalsPrefix)) return arg.slice(equalsPrefix.length);
  }
  return undefined;
}

function hasOption(args: string[], name: string): boolean {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function positionalArgs(args: string[], valueOptions: Set<string>): string[] {
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }

    if (valueOptions.has(arg)) {
      i++;
      continue;
    }

    const optionWithEquals = [...valueOptions].some((option) => arg.startsWith(`${option}=`));
    if (optionWithEquals) continue;

    if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }

    positional.push(arg);
  }

  return positional;
}

// ── PID file management ────────────────────────────────────────────

function readPid(): number | null {
  try {
    if (existsSync(PID_PATH)) {
      return Number.parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writePid(pid: number) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PID_PATH, `${pid}\n`);
}

function removePid() {
  try {
    unlinkSync(PID_PATH);
  } catch {
    /* ignore */
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Server HTTP helpers ────────────────────────────────────────────

function baseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

interface HealthResponse {
  status: string;
  activeDtype: string | null;
  modelLoaded: boolean;
  loading: boolean;
}

async function fetchHealth(host: string, port: number): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${baseUrl(host, port)}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

interface ModelsResponse {
  models: Record<string, { downloaded: boolean }>;
}

async function fetchModels(host: string, port: number): Promise<ModelsResponse | null> {
  try {
    const res = await fetch(`${baseUrl(host, port)}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ModelsResponse;
  } catch {
    return null;
  }
}

async function postJson(
  host: string,
  port: number,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`${baseUrl(host, port)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    const data = (await res.json()) as Record<string, unknown>;
    return { status: res.status, data };
  } catch (err) {
    return {
      status: 0,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function postTts(
  host: string,
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; wav?: Buffer; error?: string }> {
  try {
    const res = await fetch(`${baseUrl(host, port)}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (res.ok) {
      return { status: res.status, wav: Buffer.from(await res.arrayBuffer()) };
    }

    const text = await res.text();
    try {
      const data = JSON.parse(text) as { error?: string };
      return { status: res.status, error: data.error ?? `HTTP ${res.status}` };
    } catch {
      return { status: res.status, error: text || `HTTP ${res.status}` };
    }
  } catch (err) {
    return {
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Require the server to be online, or exit with an error. */
async function requireServer(args: string[]): Promise<{ host: string; port: number }> {
  const { host, port } = resolveHostPort(args);
  const health = await fetchHealth(host, port);
  if (!health) {
    console.error("Server is not running. Start it with: pi-voice server start");
    process.exit(1);
  }
  return { host, port };
}

/** Validate dtype argument. */
function requireDtype(value: string | undefined, command: string): DType {
  if (!value) {
    console.error(`Usage: pi-voice model ${command} <model-name>`);
    process.exit(1);
  }
  if (!DTYPES.includes(value as DType)) {
    console.error(`Invalid model "${value}". Must be one of: ${DTYPES.join(", ")}`);
    process.exit(1);
  }
  return value as DType;
}

// ── Commands: server ───────────────────────────────────────────────

async function cmdServerStatus(args: string[]) {
  const { host, port } = resolveHostPort(args);
  const health = await fetchHealth(host, port);

  if (!health) {
    console.log("Server: offline");
    process.exit(1);
  }

  const model = health.activeDtype ? `${health.activeDtype} (loaded)` : "none";
  console.log(`Server: online at http://${host}:${port}`);
  console.log(`Model:  ${model}`);
  console.log(`Loading: ${health.loading ? "yes" : "no"}`);
}

async function cmdServerStart(args: string[]) {
  const { host, port } = resolveHostPort(args);

  // Already running?
  const health = await fetchHealth(host, port);
  if (health) {
    const model = health.activeDtype ? `${health.activeDtype} (loaded)` : "none";
    console.log(`Server already running at http://${host}:${port}`);
    console.log(`Model: ${model}`);
    return;
  }

  // Stale PID?
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    console.error(`Process ${pid} is alive but not responding on http://${host}:${port}.`);
    console.error("Try 'pi-voice server stop' then 'pi-voice server start'.");
    process.exit(1);
  }
  removePid();

  // Spawn detached server process
  console.log(`Starting server on http://${host}:${port} ...`);
  const child = spawn(
    process.execPath,
    [JITI_CLI, SERVER_SCRIPT, "--host", host, "--port", String(port)],
    { cwd: PACKAGE_ROOT, detached: true, stdio: "ignore" },
  );
  child.unref();
  if (child.pid) writePid(child.pid);

  // Wait for /health to respond (up to 15 s)
  for (let i = 0; i < 75; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const h = await fetchHealth(host, port);
    if (h) {
      console.log(`Server started (PID ${child.pid})`);

      // Load default model
      const config = loadConfig();
      const model = config.defaultModel ?? "q4";
      console.log(`Loading default model (${model}) ...`);
      const result = await postJson(host, port, "/models/download", {
        dtype: model,
        activate: true,
      });
      if (result.status === 200) {
        console.log(`Model ${model} loaded.`);
      } else {
        console.error(`Failed to load model: ${result.data.error ?? "unknown error"}`);
      }
      return;
    }
  }

  console.error("Server failed to start within 15 seconds.");
  removePid();
  process.exit(1);
}

async function cmdServerStop(args: string[]) {
  const { host, port } = resolveHostPort(args);

  // Try graceful HTTP shutdown first
  const result = await postJson(host, port, "/shutdown");
  if (result.status === 200) {
    console.log("Server stopped.");
    removePid();
    return;
  }

  // Fallback: kill by PID
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
    console.log(`Server stopped (killed PID ${pid}).`);
    removePid();
    return;
  }

  console.log("Server is not running.");
  removePid();
}

async function cmdServerRestart(args: string[]) {
  await cmdServerStop(args);
  await new Promise((r) => setTimeout(r, 500));
  await cmdServerStart(args);
}

// ── Commands: model ────────────────────────────────────────────────

async function cmdModelList(args: string[]) {
  const { host, port } = resolveHostPort(args);
  const health = await fetchHealth(host, port);
  const models = await fetchModels(host, port);

  if (!models) {
    console.error("Server is not running. Start it with: pi-voice server start");
    process.exit(1);
  }

  console.log("MODEL   STATUS");
  for (const dtype of DTYPES) {
    const downloaded = models.models[dtype]?.downloaded ?? false;
    const active = health?.activeDtype === dtype;

    let status: string;
    if (active) status = "\u2713 active";
    else if (downloaded) status = "\u2713 downloaded";
    else status = "\u2717 not downloaded";

    console.log(`${dtype.padEnd(8)}${status}`);
  }
}

async function cmdModelLoad(args: string[]) {
  const { positional, options } = splitArgs(args);
  const dtype = requireDtype(positional[0], "load");
  const { host, port } = await requireServer(options);

  // If already downloaded, activate (fast). Otherwise download+activate.
  const models = await fetchModels(host, port);
  if (models?.models[dtype]?.downloaded) {
    const result = await postJson(host, port, "/models/activate", { dtype });
    if (result.status === 200) {
      console.log(`Model ${dtype} loaded.`);
    } else {
      console.error(`Failed to load model: ${result.data.error ?? "unknown error"}`);
      process.exit(1);
    }
  } else {
    console.log(`Downloading model ${dtype} ...`);
    const result = await postJson(host, port, "/models/download", {
      dtype,
      activate: true,
    });
    if (result.status === 200) {
      console.log(`Model ${dtype} downloaded and loaded.`);
    } else {
      console.error(`Failed to download model: ${result.data.error ?? "unknown error"}`);
      process.exit(1);
    }
  }
}

async function cmdModelUnload(args: string[]) {
  const { options } = splitArgs(args);
  const { host, port } = await requireServer(options);

  const result = await postJson(host, port, "/models/unload");
  if (result.status === 200) {
    console.log("Model unloaded.");
  } else {
    console.error(`Failed to unload: ${result.data.error ?? "unknown error"}`);
    process.exit(1);
  }
}

async function cmdModelDownload(args: string[]) {
  const { positional, options } = splitArgs(args);
  const dtype = requireDtype(positional[0], "download");
  const { host, port } = await requireServer(options);

  console.log(`Downloading model ${dtype} ...`);
  const result = await postJson(host, port, "/models/download", {
    dtype,
    activate: false,
  });
  if (result.status === 200) {
    console.log(`Model ${dtype} downloaded (not activated).`);
  } else {
    console.error(`Failed to download model: ${result.data.error ?? "unknown error"}`);
    process.exit(1);
  }
}

async function cmdModelRemove(args: string[]) {
  const { positional, options } = splitArgs(args);
  const dtype = requireDtype(positional[0], "remove");
  const { host, port } = await requireServer(options);

  const result = await postJson(host, port, "/models/delete", { dtype });
  if (result.status === 200) {
    console.log(`Model ${dtype} removed.`);
  } else {
    console.error(`Failed to remove model: ${result.data.error ?? "unknown error"}`);
    process.exit(1);
  }
}

// ── Commands: say ─────────────────────────────────────────────────

function printSayUsage() {
  console.log(`Usage:
  pi-voice say <text>
  pi-voice say --file <path>

Options:
  --voice <voice>     Override configured voice
  --speed <speed>     Override configured speed (0.5-3.0)
  --output <path>     Also keep the generated WAV at this path
  --host <host>       Override server host (default: 127.0.0.1)
  --port <port>       Override server port (default: 8181)`);
}

function readSayText(args: string[]): string {
  const file = optionValue(args, "--file");
  const positionals = positionalArgs(
    args,
    new Set(["--file", "--voice", "--speed", "--output", "--host", "--port"]),
  );

  if (file && positionals.length > 0) {
    console.error("Use either text arguments or --file <path>, not both.");
    process.exit(1);
  }

  if (file) {
    try {
      return readFileSync(resolve(file), "utf-8");
    } catch (err) {
      console.error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  const text = positionals.join(" ");
  if (text.trim()) return text;

  if (!process.stdin.isTTY) {
    try {
      return readFileSync(0, "utf-8");
    } catch {
      /* fall through to usage */
    }
  }

  console.error("Missing text. Provide text arguments or --file <path>.");
  printSayUsage();
  process.exit(1);
}

function resolveSaySpeed(args: string[], config: VoiceConfig): number {
  const raw = optionValue(args, "--speed");
  const speed = raw === undefined ? (config.speed ?? 1.0) : Number.parseFloat(raw);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 3.0) {
    console.error("Invalid --speed. Must be a number between 0.5 and 3.0.");
    process.exit(1);
  }
  return speed;
}

async function playWav(path: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "afplay" : "aplay";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [path], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function cmdSay(args: string[]) {
  if (hasOption(args, "--help") || hasOption(args, "-h")) {
    printSayUsage();
    return;
  }

  const config = loadConfig();
  const text = readSayText(args).trim();
  if (!text) {
    console.error("Input text is empty.");
    process.exit(1);
  }

  const { host, port } = await requireServer(args);
  const voice = optionValue(args, "--voice") ?? config.voice ?? "af_heart";
  const speed = resolveSaySpeed(args, config);
  const output = optionValue(args, "--output");

  console.log(`Synthesizing ${text.length} characters (voice=${voice}, speed=${speed}) ...`);
  const result = await postTts(host, port, { text, voice, speed });
  if (result.status !== 200 || !result.wav) {
    console.error(`Failed to synthesize speech: ${result.error ?? "unknown error"}`);
    process.exit(1);
  }

  const outPath = output
    ? resolve(output)
    : resolve(CONFIG_DIR, `voice-cli-${Date.now()}.wav`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.wav);

  try {
    await playWav(outPath);
    if (output) console.log(`WAV saved to ${outPath}`);
  } catch (err) {
    console.error(`Playback failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!output) console.error(`WAV left at ${outPath}`);
    process.exit(1);
  }

  if (!output) {
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────

function printUsage() {
  console.log(`pi-voice \u2014 Kokoro TTS server management

Usage:
  pi-voice server status              Show server status
  pi-voice server start               Start server, load default model
  pi-voice server stop                Stop server, unload model
  pi-voice server restart             Restart server
  pi-voice model list                 List available models
  pi-voice model load <name>          Load a model (downloads if needed)
  pi-voice model unload               Unload current model
  pi-voice model download <name>      Download model without loading
  pi-voice model remove <name>        Unload and remove model files
  pi-voice say <text>                 Speak text using the active model
  pi-voice say --file <path>          Speak the contents of a text file

Options:
  --host <host>   Override server host (default: 127.0.0.1)
  --port <port>   Override server port (default: 8181)

Configuration: ~/.pi/voice/config.json
Models:         q4, q4f16, q8, fp16, fp32`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  const domain = args[0];

  if (domain === "say") {
    return await cmdSay(args.slice(1));
  }

  const command = args[1];
  const rest = args.slice(2);

  if (domain === "server") {
    switch (command) {
      case "status":
        return await cmdServerStatus(rest);
      case "start":
        return await cmdServerStart(rest);
      case "stop":
        return await cmdServerStop(rest);
      case "restart":
        return await cmdServerRestart(rest);
      default:
        console.error(`Unknown command: pi-voice server ${command ?? ""}`);
        console.error("Available: status, start, stop, restart");
        process.exit(1);
    }
  }

  if (domain === "model") {
    switch (command) {
      case "list":
        return await cmdModelList(rest);
      case "load":
        return await cmdModelLoad(rest);
      case "unload":
        return await cmdModelUnload(rest);
      case "download":
        return await cmdModelDownload(rest);
      case "remove":
        return await cmdModelRemove(rest);
      default:
        console.error(`Unknown command: pi-voice model ${command ?? ""}`);
        console.error("Available: list, load, unload, download, remove");
        process.exit(1);
    }
  }

  console.error(`Unknown domain: ${domain}`);
  console.error("Available: server, model, say");
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
