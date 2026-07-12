#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const args = {
    endpoint: "http://127.0.0.1:8181/tts",
    inputDir: resolve(import.meta.dirname, "texts"),
    outDir: resolve(import.meta.dirname, "results"),
    repeats: 5,
    warmups: 1,
    voice: "af_heart",
    speed: 1.0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--endpoint" && next) args.endpoint = next;
    else if (arg === "--input-dir" && next) args.inputDir = resolve(next);
    else if (arg === "--out-dir" && next) args.outDir = resolve(next);
    else if (arg === "--repeats" && next) args.repeats = Number.parseInt(next, 10);
    else if (arg === "--warmups" && next) args.warmups = Number.parseInt(next, 10);
    else if (arg === "--voice" && next) args.voice = next;
    else if (arg === "--speed" && next) args.speed = Number.parseFloat(next);
    else if (arg === "--help") usage(0);
    if (arg?.startsWith("--") && next) i++;
  }

  return args;
}

function usage(code) {
  console.log(`Usage: node .ai/tts-bench/bench-tts.mjs [options]

Options:
  --endpoint <url>    TTS endpoint, default http://127.0.0.1:8181/tts
  --input-dir <path>  Directory of .txt/.md benchmark inputs
  --out-dir <path>    Directory for JSONL results
  --repeats <n>       Measured repeats per file, default 5
  --warmups <n>       Warmup repeats per file, default 1
  --voice <name>      Voice name, default af_heart
  --speed <n>         Speech speed, default 1.0
`);
  process.exit(code);
}

function wavDurationMs(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  const byteRate = buffer.readUInt32LE(28);
  const dataSize = buffer.readUInt32LE(40);
  if (!byteRate || !dataSize) return null;
  return (dataSize / byteRate) * 1000;
}

function postTts(endpoint, body) {
  const url = new URL(endpoint);
  const payload = Buffer.from(JSON.stringify(body));
  const client = url.protocol === "https:" ? httpsRequest : request;

  return new Promise((resolve, reject) => {
    const start = performance.now();
    let responseHeadersAt = null;
    let firstByteAt = null;
    const chunks = [];

    const req = client(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        },
      },
      (res) => {
        responseHeadersAt = performance.now();
        res.on("data", (chunk) => {
          if (firstByteAt === null) firstByteAt = performance.now();
          chunks.push(chunk);
        });
        res.on("end", () => {
          const end = performance.now();
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            contentType: res.headers["content-type"] ?? null,
            bytes: buffer.length,
            ttfhMs: responseHeadersAt === null ? null : responseHeadersAt - start,
            ttfbMs: firstByteAt === null ? null : firstByteAt - start,
            totalMs: end - start,
            wavDurationMs: wavDurationMs(buffer),
            errorBody: res.statusCode && res.statusCode >= 400 ? buffer.toString("utf-8") : null,
          });
        });
      },
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function summarize(rows) {
  const groups = new Map();
  for (const row of rows.filter((r) => !r.warmup && r.status === 200)) {
    const existing = groups.get(row.file) ?? [];
    existing.push(row);
    groups.set(row.file, existing);
  }

  const summaries = [];
  for (const [file, group] of groups) {
    const totals = group.map((r) => r.totalMs);
    const firstBytes = group.map((r) => r.ttfbMs).filter((v) => v !== null);
    const rtfs = group.map((r) => r.rtf).filter((v) => v !== null);
    summaries.push({
      file,
      count: group.length,
      chars: group[0].chars,
      p50TotalMs: percentile(totals, 50),
      p90TotalMs: percentile(totals, 90),
      p50TtfbMs: percentile(firstBytes, 50),
      p90TtfbMs: percentile(firstBytes, 90),
      p50Rtf: percentile(rtfs, 50),
      p90Rtf: percentile(rtfs, 90),
    });
  }
  return summaries.sort((a, b) => a.file.localeCompare(b.file));
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.inputDir)) {
  console.error(`Input directory does not exist: ${args.inputDir}`);
  process.exit(1);
}
mkdirSync(args.outDir, { recursive: true });

const files = readdirSync(args.inputDir)
  .filter((name) => [".txt", ".md"].includes(extname(name)))
  .sort();

if (files.length === 0) {
  console.error(`No .txt/.md files found in ${args.inputDir}`);
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const resultPath = join(args.outDir, `tts-bench-${runId}.jsonl`);
const out = createWriteStream(resultPath, { flags: "wx" });
const rows = [];

console.log(`Benchmarking ${files.length} files against ${args.endpoint}`);
console.log(`Results: ${resultPath}`);

for (const fileName of files) {
  const filePath = join(args.inputDir, fileName);
  const text = readFileSync(filePath, "utf-8");
  const totalRuns = args.warmups + args.repeats;
  for (let i = 0; i < totalRuns; i++) {
    const warmup = i < args.warmups;
    const result = await postTts(args.endpoint, {
      text,
      voice: args.voice,
      speed: args.speed,
    });
    const rtf = result.wavDurationMs ? result.totalMs / result.wavDurationMs : null;
    const row = {
      runId,
      endpoint: args.endpoint,
      file: basename(fileName),
      iteration: i + 1,
      warmup,
      voice: args.voice,
      speed: args.speed,
      chars: text.length,
      ...result,
      rtf,
      timestamp: new Date().toISOString(),
    };
    rows.push(row);
    out.write(`${JSON.stringify(row)}\n`);
    const label = warmup ? "warmup" : "run";
    console.log(
      `${fileName} ${label} ${i + 1}/${totalRuns}: status=${row.status} total=${row.totalMs.toFixed(1)}ms ttfb=${row.ttfbMs?.toFixed(1) ?? "n/a"}ms rtf=${row.rtf?.toFixed(3) ?? "n/a"}`,
    );
    if (row.status !== 200) {
      console.error(row.errorBody);
      process.exitCode = 1;
    }
  }
}

out.end();
console.log("\nSummary:");
for (const s of summarize(rows)) {
  console.log(
    `${s.file}: n=${s.count} chars=${s.chars} p50_total=${s.p50TotalMs?.toFixed(1)}ms p90_total=${s.p90TotalMs?.toFixed(1)}ms p50_ttfb=${s.p50TtfbMs?.toFixed(1)}ms p50_rtf=${s.p50Rtf?.toFixed(3)}`,
  );
}
