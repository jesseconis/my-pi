#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultResultsDir = join(scriptDir, "results");

function usage(code = 0) {
  console.log(`Usage: node tts-bench/report-tts.mjs [result.jsonl] [options]

Creates a self-contained HTML report for tts-bench JSONL output.
If no result file is provided, the newest tts-bench/results/*.jsonl file is used.

Options:
  --out <path>            HTML report path, default <result>.report.html
  --summary-json <path>   Optional machine-readable summary JSON path
  --include-warmups       Include warmup rows in charts and aggregate stats
  --help                  Show this help
`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    input: null,
    out: null,
    summaryJson: null,
    includeWarmups: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help") usage(0);
    else if (arg === "--out" && next) {
      args.out = resolve(next);
      i++;
    } else if (arg === "--summary-json" && next) {
      args.summaryJson = resolve(next);
      i++;
    } else if (arg === "--include-warmups") {
      args.includeWarmups = true;
    } else if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      usage(1);
    } else if (!args.input) {
      args.input = resolve(arg);
    } else {
      console.error(`Unexpected argument: ${arg}`);
      usage(1);
    }
  }

  if (!args.input) args.input = newestResultFile();
  if (!args.out) args.out = args.input.replace(/\.jsonl$/i, "") + ".report.html";
  return args;
}

function newestResultFile() {
  if (!existsSync(defaultResultsDir)) {
    console.error(`Results directory does not exist: ${defaultResultsDir}`);
    process.exit(1);
  }
  const candidates = readdirSync(defaultResultsDir)
    .filter((name) => extname(name) === ".jsonl" && name.startsWith("tts-bench-"))
    .map((name) => join(defaultResultsDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (candidates.length === 0) {
    console.error(`No tts-bench JSONL files found in ${defaultResultsDir}`);
    process.exit(1);
  }
  return candidates[0];
}

function parseJsonl(path) {
  const text = readFileSync(path, "utf-8");
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Could not parse ${path}:${index}: ${error.message}`);
      }
    });
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function percentile(values, p) {
  const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values) {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function stats(values) {
  const finite = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (finite.length === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p90: null, p95: null, stdev: null, cv: null };
  }
  const avg = mean(finite);
  const variance = finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / finite.length;
  const stdev = Math.sqrt(variance);
  return {
    count: finite.length,
    min: finite[0],
    max: finite[finite.length - 1],
    mean: avg,
    p50: percentile(finite, 50),
    p90: percentile(finite, 90),
    p95: percentile(finite, 95),
    stdev,
    cv: avg === 0 ? null : stdev / avg,
  };
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function pearson(items, xFn, yFn) {
  const pairs = items
    .map((item) => [xFn(item), yFn(item)])
    .filter(([x, y]) => isFiniteNumber(x) && isFiniteNumber(y));
  if (pairs.length < 2) return null;
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const mx = mean(xs);
  const my = mean(ys);
  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx;
    const dy = y - my;
    numerator += dx * dy;
    dx2 += dx ** 2;
    dy2 += dy ** 2;
  }
  const denominator = Math.sqrt(dx2 * dy2);
  return denominator === 0 ? null : numerator / denominator;
}

function linearRegression(items, xFn, yFn) {
  const pairs = items
    .map((item) => [xFn(item), yFn(item)])
    .filter(([x, y]) => isFiniteNumber(x) && isFiniteNumber(y));
  if (pairs.length < 2) return null;
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const mx = mean(xs);
  const my = mean(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  if (denominator === 0) return null;
  const slope = pairs.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / denominator;
  return { slope, intercept: my - slope * mx };
}

function summarize(rows, includeWarmups) {
  const successful = rows.filter((row) => row.status === 200);
  const selected = successful.filter((row) => includeWarmups || !row.warmup);
  const failures = rows.filter((row) => row.status !== 200);
  const byFile = groupBy(selected, (row) => row.file ?? "unknown");

  const files = [...byFile.entries()]
    .map(([file, group]) => {
      const totals = group.map((row) => row.totalMs);
      const ttfbs = group.map((row) => row.ttfbMs);
      const ttfhs = group.map((row) => row.ttfhMs);
      const rtfs = group.map((row) => row.rtf);
      const durations = group.map((row) => row.wavDurationMs);
      const ttfbToTotal = group.map((row) =>
        isFiniteNumber(row.totalMs) && isFiniteNumber(row.ttfbMs) ? row.totalMs - row.ttfbMs : null,
      );
      const headerToByte = group.map((row) =>
        isFiniteNumber(row.ttfbMs) && isFiniteNumber(row.ttfhMs) ? row.ttfbMs - row.ttfhMs : null,
      );
      const chars = group.find((row) => isFiniteNumber(row.chars))?.chars ?? null;
      const totalStats = stats(totals);
      const durationStats = stats(durations);
      const rtfStats = stats(rtfs);
      return {
        file,
        count: group.length,
        chars,
        totalMs: totalStats,
        ttfbMs: stats(ttfbs),
        ttfhMs: stats(ttfhs),
        rtf: rtfStats,
        wavDurationMs: durationStats,
        ttfbToTotalMs: stats(ttfbToTotal),
        headerToByteMs: stats(headerToByte),
        charsPerSecond: chars && totalStats.p50 ? chars / (totalStats.p50 / 1000) : null,
        audioSecondsPerChar: chars && durationStats.p50 ? durationStats.p50 / 1000 / chars : null,
        realtimeSpeedup: rtfStats.p50 ? 1 / rtfStats.p50 : null,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  const timestamps = rows.map((row) => Date.parse(row.timestamp)).filter((value) => Number.isFinite(value));
  const startedAt = timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null;
  const endedAt = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;

  const global = {
    sourceRows: rows.length,
    selectedRows: selected.length,
    warmupRows: rows.filter((row) => row.warmup).length,
    failureRows: failures.length,
    runIds: [...new Set(rows.map((row) => row.runId).filter(Boolean))],
    endpoints: [...new Set(rows.map((row) => row.endpoint).filter(Boolean))],
    voices: [...new Set(rows.map((row) => row.voice).filter(Boolean))],
    speeds: [...new Set(rows.map((row) => row.speed).filter((speed) => speed !== undefined))],
    startedAt,
    endedAt,
    totalMs: stats(selected.map((row) => row.totalMs)),
    ttfbMs: stats(selected.map((row) => row.ttfbMs)),
    ttfhMs: stats(selected.map((row) => row.ttfhMs)),
    rtf: stats(selected.map((row) => row.rtf)),
    wavDurationMs: stats(selected.map((row) => row.wavDurationMs)),
    ttfbToTotalMs: stats(
      selected.map((row) => (isFiniteNumber(row.totalMs) && isFiniteNumber(row.ttfbMs) ? row.totalMs - row.ttfbMs : null)),
    ),
  };

  const correlations = {
    p50TotalVsChars: pearson(files, (file) => file.chars, (file) => file.totalMs.p50),
    p50TotalVsAudioDuration: pearson(files, (file) => file.wavDurationMs.p50, (file) => file.totalMs.p50),
    p50AudioDurationVsChars: pearson(files, (file) => file.chars, (file) => file.wavDurationMs.p50),
  };

  const warmups = successful.filter((row) => row.warmup);
  const nonWarmups = successful.filter((row) => !row.warmup);
  const warmupComparison = {
    warmupTotalMeanMs: mean(warmups.map((row) => row.totalMs)),
    measuredTotalMeanMs: mean(nonWarmups.map((row) => row.totalMs)),
    warmupRtfMean: mean(warmups.map((row) => row.rtf)),
    measuredRtfMean: mean(nonWarmups.map((row) => row.rtf)),
  };
  warmupComparison.totalDeltaPct =
    warmupComparison.warmupTotalMeanMs && warmupComparison.measuredTotalMeanMs
      ? ((warmupComparison.warmupTotalMeanMs - warmupComparison.measuredTotalMeanMs) / warmupComparison.measuredTotalMeanMs) * 100
      : null;

  return { global, files, correlations, warmupComparison, failures, selectedRows: selected };
}

function buildInterpretation(summary, includeWarmups) {
  const notes = [];
  const { global, files, correlations, warmupComparison } = summary;
  notes.push(
    `${includeWarmups ? "Including" : "Excluding"} warmups, ${global.selectedRows} successful measurement rows across ${files.length} benchmark inputs were analyzed.`,
  );

  if (isFiniteNumber(global.rtf.p50)) {
    const speedup = 1 / global.rtf.p50;
    notes.push(`Median real-time factor is ${formatRtf(global.rtf.p50)}, so synthesis is about ${speedup.toFixed(1)}× faster than audio playback.`);
  }

  if (isFiniteNumber(global.ttfbToTotalMs.p50)) {
    if (global.ttfbToTotalMs.p50 < 100) {
      notes.push(
        `Median total-minus-TTFB is only ${formatMs(global.ttfbToTotalMs.p50)}: first audio bytes arrive essentially when the whole WAV is complete, so the endpoint behaves as batch/non-streaming from a listener's perspective.`,
      );
    } else {
      notes.push(
        `Median total-minus-TTFB is ${formatMs(global.ttfbToTotalMs.p50)}, indicating there is some body transfer time after the first byte arrives.`,
      );
    }
  }

  if (isFiniteNumber(correlations.p50TotalVsAudioDuration) && isFiniteNumber(correlations.p50TotalVsChars)) {
    if (correlations.p50TotalVsAudioDuration > correlations.p50TotalVsChars + 0.1) {
      notes.push(
        `Latency tracks generated audio duration more strongly than raw input size (r=${correlations.p50TotalVsAudioDuration.toFixed(2)} vs chars r=${correlations.p50TotalVsChars.toFixed(2)}). Interpret long inputs through spoken output length, not source character count alone.`,
      );
    } else {
      notes.push(
        `Latency correlation with generated audio duration is r=${correlations.p50TotalVsAudioDuration.toFixed(2)} and with raw chars is r=${correlations.p50TotalVsChars.toFixed(2)}.`,
      );
    }
  }

  const charLeader = files.toSorted((a, b) => (b.chars ?? 0) - (a.chars ?? 0))[0];
  const durationLeader = files.toSorted((a, b) => (b.wavDurationMs.p50 ?? 0) - (a.wavDurationMs.p50 ?? 0))[0];
  if (
    charLeader &&
    durationLeader &&
    charLeader.file !== durationLeader.file &&
    charLeader.chars > (durationLeader.chars ?? 0) * 1.4 &&
    (charLeader.wavDurationMs.p50 ?? Infinity) <= (durationLeader.wavDurationMs.p50 ?? 0) * 1.1
  ) {
    notes.push(
      `${charLeader.file} has the most raw characters, but it is not the longest generated audio. Markdown/code cleanup is likely removing non-spoken content, so chars can overstate perceived workload for code-heavy prompts.`,
    );
  }

  const mostVariable = files.toSorted((a, b) => (b.totalMs.cv ?? 0) - (a.totalMs.cv ?? 0))[0];
  if (mostVariable?.totalMs.cv !== null && mostVariable.totalMs.cv < 0.08) {
    notes.push(`Run-to-run variance is low; the noisiest file is ${mostVariable.file} with total-latency CV ${(mostVariable.totalMs.cv * 100).toFixed(1)}%.`);
  } else if (mostVariable?.totalMs.cv !== null) {
    notes.push(`The noisiest file is ${mostVariable.file} with total-latency CV ${(mostVariable.totalMs.cv * 100).toFixed(1)}%; inspect the per-iteration chart for outliers.`);
  }

  if (isFiniteNumber(warmupComparison.totalDeltaPct)) {
    const delta = warmupComparison.totalDeltaPct;
    if (Math.abs(delta) < 5) {
      notes.push(`Warmup runs are close to measured runs (${delta.toFixed(1)}% total-latency delta), suggesting the model/server was already hot.`);
    } else if (delta > 0) {
      notes.push(`Warmups are ${delta.toFixed(1)}% slower than measured runs on average; keep excluding them for steady-state comparisons.`);
    } else {
      notes.push(`Warmups are ${Math.abs(delta).toFixed(1)}% faster than measured runs on average in this file; no cold-start penalty is visible here.`);
    }
  }

  if (global.failureRows > 0) notes.push(`${global.failureRows} failure rows were present; tables and charts use successful rows only.`);
  return notes;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMs(value) {
  if (!isFiniteNumber(value)) return "—";
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${value.toFixed(0)}ms`;
}

function formatShortMs(value) {
  if (!isFiniteNumber(value)) return "—";
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value.toFixed(0)}ms`;
}

function formatRtf(value) {
  if (!isFiniteNumber(value)) return "—";
  return value.toFixed(3);
}

function formatNumber(value, digits = 1) {
  if (!isFiniteNumber(value)) return "—";
  return value.toFixed(digits);
}

function axisTicks(max, count = 5) {
  if (!isFiniteNumber(max) || max <= 0) return [0];
  return Array.from({ length: count + 1 }, (_, index) => (max * index) / count);
}

function barChartHorizontal(items, series, { title, subtitle, valueFormat = formatShortMs, width = 980 } = {}) {
  const rowHeight = 52;
  const margin = { top: 52, right: 110, bottom: 34, left: 230 };
  const height = margin.top + margin.bottom + items.length * rowHeight;
  const plotWidth = width - margin.left - margin.right;
  const max = Math.max(1, ...items.flatMap((item) => series.map((s) => item[s.key] ?? 0))) * 1.08;
  const ticks = axisTicks(max);
  const barHeight = 14;
  const palette = ["#2563eb", "#f97316", "#16a34a", "#9333ea"];

  const grid = ticks
    .map((tick) => {
      const x = margin.left + (tick / max) * plotWidth;
      return `<line x1="${x}" y1="${margin.top - 10}" x2="${x}" y2="${height - margin.bottom}" class="grid"/><text x="${x}" y="${height - 10}" text-anchor="middle" class="axis-label">${escapeHtml(valueFormat(tick))}</text>`;
    })
    .join("");

  const rows = items
    .map((item, itemIndex) => {
      const y = margin.top + itemIndex * rowHeight;
      const bars = series
        .map((s, seriesIndex) => {
          const value = item[s.key];
          if (!isFiniteNumber(value)) return "";
          const barWidth = (value / max) * plotWidth;
          const barY = y + 8 + seriesIndex * (barHeight + 3);
          const color = s.color ?? palette[seriesIndex % palette.length];
          return `<rect x="${margin.left}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="${color}"><title>${escapeHtml(item.file)} ${escapeHtml(s.label)} ${escapeHtml(valueFormat(value))}</title></rect><text x="${margin.left + barWidth + 6}" y="${barY + 11}" class="bar-value">${escapeHtml(valueFormat(value))}</text>`;
        })
        .join("");
      return `<text x="${margin.left - 12}" y="${y + 23}" text-anchor="end" class="file-label">${escapeHtml(item.file)}</text>${bars}`;
    })
    .join("");

  const legend = series
    .map((s, index) => {
      const x = margin.left + index * 120;
      const color = s.color ?? palette[index % palette.length];
      return `<rect x="${x}" y="22" width="12" height="12" rx="2" fill="${color}"/><text x="${x + 18}" y="32" class="legend">${escapeHtml(s.label)}</text>`;
    })
    .join("");

  return `<figure><figcaption><strong>${escapeHtml(title)}</strong>${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ""}</figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">${grid}<text x="18" y="31" class="chart-title">${escapeHtml(title)}</text>${legend}${rows}</svg></figure>`;
}

function scatterChart(items, { xKey, yKey, xLabel, yLabel, title, width = 760, height = 430, xFormat = formatNumber, yFormat = formatShortMs }) {
  const margin = { top: 42, right: 38, bottom: 74, left: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = items
    .map((item) => ({ item, x: item[xKey], y: item[yKey] }))
    .filter(({ x, y }) => isFiniteNumber(x) && isFiniteNumber(y));
  if (values.length === 0) return "";
  const xMin = Math.min(...values.map(({ x }) => x));
  const xMax = Math.max(...values.map(({ x }) => x));
  const yMin = Math.min(...values.map(({ y }) => y));
  const yMax = Math.max(...values.map(({ y }) => y));
  const xPad = Math.max(1, (xMax - xMin) * 0.08);
  const yPad = Math.max(1, (yMax - yMin) * 0.08);
  const xDomain = [Math.max(0, xMin - xPad), xMax + xPad];
  const yDomain = [Math.max(0, yMin - yPad), yMax + yPad];
  const xScale = (x) => margin.left + ((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * plotWidth;
  const yScale = (y) => margin.top + plotHeight - ((y - yDomain[0]) / (yDomain[1] - yDomain[0])) * plotHeight;
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#f97316", "#0891b2"];
  const corr = pearson(values, ({ x }) => x, ({ y }) => y);
  const regression = linearRegression(values, ({ x }) => x, ({ y }) => y);

  const xTicks = axisTicks(xDomain[1], 5);
  const yTicks = axisTicks(yDomain[1], 5);
  const grid = [
    ...xTicks.map((tick) => {
      const x = xScale(tick);
      return `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotHeight}" class="grid"/><text x="${x}" y="${height - 42}" text-anchor="middle" class="axis-label">${escapeHtml(xFormat(tick))}</text>`;
    }),
    ...yTicks.map((tick) => {
      const y = yScale(tick);
      return `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotWidth}" y2="${y}" class="grid"/><text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" class="axis-label">${escapeHtml(yFormat(tick))}</text>`;
    }),
  ].join("");

  const trend = regression
    ? `<line x1="${xScale(xDomain[0])}" y1="${yScale(regression.intercept + regression.slope * xDomain[0])}" x2="${xScale(xDomain[1])}" y2="${yScale(regression.intercept + regression.slope * xDomain[1])}" class="trend"/>`
    : "";

  const points = values
    .map(({ item, x, y }, index) => {
      const color = colors[index % colors.length];
      const cx = xScale(x);
      const cy = yScale(y);
      return `<circle cx="${cx}" cy="${cy}" r="6" fill="${color}"><title>${escapeHtml(item.file)}: ${escapeHtml(xLabel)} ${escapeHtml(xFormat(x))}, ${escapeHtml(yLabel)} ${escapeHtml(yFormat(y))}</title></circle><text x="${cx + 9}" y="${cy - 7}" class="point-label">${index + 1}</text>`;
    })
    .join("");

  const legend = values
    .map(({ item }, index) => `<span><b style="color:${colors[index % colors.length]}">${index + 1}</b> ${escapeHtml(item.file)}</span>`)
    .join("");

  return `<figure class="scatter"><figcaption><strong>${escapeHtml(title)}</strong><span>${corr === null ? "" : `r=${corr.toFixed(2)}`}</span></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><text x="18" y="28" class="chart-title">${escapeHtml(title)}</text>${grid}<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" class="axis"/><line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" class="axis"/>${trend}${points}<text x="${margin.left + plotWidth / 2}" y="${height - 12}" text-anchor="middle" class="axis-title">${escapeHtml(xLabel)}</text><text x="18" y="${margin.top + plotHeight / 2}" transform="rotate(-90 18 ${margin.top + plotHeight / 2})" text-anchor="middle" class="axis-title">${escapeHtml(yLabel)}</text></svg><div class="inline-legend">${legend}</div></figure>`;
}

function lineChart(rows, { title, width = 980, height = 430 } = {}) {
  const groups = [...groupBy(rows, (row) => row.file ?? "unknown").entries()].sort(([a], [b]) => a.localeCompare(b));
  if (groups.length === 0) return "";
  const margin = { top: 44, right: 170, bottom: 58, left: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const all = groups.flatMap(([, group]) => group);
  const xs = all.map((row) => row.iteration).filter(isFiniteNumber);
  const ys = all.map((row) => row.totalMs).filter(isFiniteNumber);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys) * 1.08;
  const xScale = (x) => margin.left + ((x - xMin) / Math.max(1, xMax - xMin)) * plotWidth;
  const yScale = (y) => margin.top + plotHeight - (y / yMax) * plotHeight;
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#f97316", "#0891b2"];

  const xTicks = Array.from(new Set(xs)).sort((a, b) => a - b);
  const yTicks = axisTicks(yMax, 5);
  const grid = [
    ...xTicks.map((tick) => {
      const x = xScale(tick);
      return `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotHeight}" class="grid light"/><text x="${x}" y="${height - 31}" text-anchor="middle" class="axis-label">${tick}</text>`;
    }),
    ...yTicks.map((tick) => {
      const y = yScale(tick);
      return `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotWidth}" y2="${y}" class="grid"/><text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" class="axis-label">${escapeHtml(formatShortMs(tick))}</text>`;
    }),
  ].join("");

  const lines = groups
    .map(([file, group], groupIndex) => {
      const color = colors[groupIndex % colors.length];
      const sorted = group.filter((row) => isFiniteNumber(row.iteration) && isFiniteNumber(row.totalMs)).sort((a, b) => a.iteration - b.iteration);
      const path = sorted.map((row, index) => `${index === 0 ? "M" : "L"}${xScale(row.iteration)},${yScale(row.totalMs)}`).join(" ");
      const points = sorted
        .map(
          (row) =>
            `<circle cx="${xScale(row.iteration)}" cy="${yScale(row.totalMs)}" r="3.5" fill="${color}"><title>${escapeHtml(file)} iteration ${row.iteration}: ${escapeHtml(formatMs(row.totalMs))}</title></circle>`,
        )
        .join("");
      const last = sorted.at(-1);
      const label = last
        ? `<text x="${margin.left + plotWidth + 12}" y="${yScale(last.totalMs) + 4}" class="line-label" fill="${color}">${escapeHtml(file)}</text>`
        : "";
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"/>${points}${label}`;
    })
    .join("");

  return `<figure><figcaption><strong>${escapeHtml(title)}</strong><span>each point is one request</span></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><text x="18" y="28" class="chart-title">${escapeHtml(title)}</text>${grid}<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" class="axis"/><line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" class="axis"/>${lines}<text x="${margin.left + plotWidth / 2}" y="${height - 10}" text-anchor="middle" class="axis-title">iteration</text><text x="18" y="${margin.top + plotHeight / 2}" transform="rotate(-90 18 ${margin.top + plotHeight / 2})" text-anchor="middle" class="axis-title">total latency</text></svg></figure>`;
}

function summaryTable(files) {
  const rows = files
    .map(
      (file) => `<tr>
<td>${escapeHtml(file.file)}</td>
<td class="num">${file.count}</td>
<td class="num">${escapeHtml(file.chars ?? "—")}</td>
<td class="num">${formatMs(file.wavDurationMs.p50)}</td>
<td class="num">${formatMs(file.totalMs.p50)}</td>
<td class="num">${formatMs(file.totalMs.p90)}</td>
<td class="num">${formatMs(file.ttfbMs.p50)}</td>
<td class="num">${formatMs(file.ttfbToTotalMs.p50)}</td>
<td class="num">${formatRtf(file.rtf.p50)}</td>
<td class="num">${formatRtf(file.rtf.p90)}</td>
<td class="num">${file.realtimeSpeedup ? `${file.realtimeSpeedup.toFixed(1)}×` : "—"}</td>
<td class="num">${file.totalMs.cv === null ? "—" : `${(file.totalMs.cv * 100).toFixed(1)}%`}</td>
</tr>`,
    )
    .join("\n");
  return `<table><thead><tr><th>file</th><th>n</th><th>chars</th><th>p50 audio</th><th>p50 total</th><th>p90 total</th><th>p50 TTFB</th><th>p50 total−TTFB</th><th>p50 RTF</th><th>p90 RTF</th><th>speedup</th><th>CV</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rawTable(rows) {
  const rendered = rows
    .map(
      (row) => `<tr class="${row.warmup ? "warmup" : ""} ${row.status === 200 ? "" : "failure"}">
<td>${escapeHtml(row.file)}</td>
<td class="num">${escapeHtml(row.iteration)}</td>
<td>${row.warmup ? "yes" : "no"}</td>
<td class="num">${escapeHtml(row.status)}</td>
<td class="num">${formatMs(row.wavDurationMs)}</td>
<td class="num">${formatMs(row.ttfhMs)}</td>
<td class="num">${formatMs(row.ttfbMs)}</td>
<td class="num">${formatMs(row.totalMs)}</td>
<td class="num">${formatRtf(row.rtf)}</td>
<td>${escapeHtml(row.timestamp)}</td>
</tr>`,
    )
    .join("\n");
  return `<details><summary>Raw measurements (${rows.length} rows)</summary><table><thead><tr><th>file</th><th>iteration</th><th>warmup</th><th>status</th><th>audio</th><th>TTFH</th><th>TTFB</th><th>total</th><th>RTF</th><th>timestamp</th></tr></thead><tbody>${rendered}</tbody></table></details>`;
}

function renderHtml({ rows, summary, inputPath, includeWarmups }) {
  const { global, files, correlations, warmupComparison } = summary;
  const interpretations = buildInterpretation(summary, includeWarmups);
  const chartItems = files.map((file) => ({
    file: file.file,
    chars: file.chars,
    p50TotalMs: file.totalMs.p50,
    p90TotalMs: file.totalMs.p90,
    p50Rtf: file.rtf.p50,
    p90Rtf: file.rtf.p90,
    p50WavDurationMs: file.wavDurationMs.p50,
  }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TTS benchmark report — ${escapeHtml(basename(inputPath))}</title>
<style>
:root { color-scheme: light dark; --bg: #f8fafc; --panel: #ffffff; --text: #0f172a; --muted: #64748b; --border: #e2e8f0; --grid: #e5e7eb; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #020617; --panel: #0f172a; --text: #e2e8f0; --muted: #94a3b8; --border: #1e293b; --grid: #334155; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 48px; }
header { margin-bottom: 20px; }
h1 { font-size: clamp(26px, 4vw, 42px); line-height: 1.05; margin: 0 0 8px; }
h2 { margin-top: 32px; font-size: 22px; }
p { margin: 0.4rem 0; }
code { background: color-mix(in srgb, var(--muted) 12%, transparent); padding: 0.1rem 0.3rem; border-radius: 4px; }
.meta { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 16px; box-shadow: 0 1px 2px rgb(15 23 42 / 0.06); }
.card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
.card .value { font-size: 28px; font-weight: 750; margin-top: 4px; }
.card .sub { color: var(--muted); font-size: 12px; }
.panel, figure, details { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin: 16px 0; box-shadow: 0 1px 2px rgb(15 23 42 / 0.06); }
.interpretation { padding-left: 1.2rem; }
.interpretation li { margin: 0.45rem 0; }
figure { overflow-x: auto; }
figcaption { display: flex; gap: 12px; align-items: baseline; margin-bottom: 8px; color: var(--muted); }
figcaption strong { color: var(--text); font-size: 16px; }
svg { width: 100%; height: auto; min-width: 720px; }
.grid { stroke: var(--grid); stroke-width: 1; }
.grid.light { opacity: 0.55; }
.axis { stroke: var(--muted); stroke-width: 1.2; }
.trend { stroke: var(--muted); stroke-width: 2; stroke-dasharray: 6 5; opacity: 0.8; }
.chart-title { fill: var(--text); font-size: 16px; font-weight: 700; }
.axis-label, .axis-title, .legend, .bar-value, .file-label, .point-label, .line-label { fill: var(--muted); font-size: 12px; }
.file-label { fill: var(--text); }
.bar-value { fill: var(--text); }
.line-label { font-size: 11px; font-weight: 650; }
.inline-legend { display: flex; flex-wrap: wrap; gap: 8px 14px; color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid var(--border); padding: 8px 9px; vertical-align: top; }
th { text-align: left; color: var(--muted); font-weight: 650; position: sticky; top: 0; background: var(--panel); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.warmup td { color: var(--muted); }
tr.failure td { color: #dc2626; }
.table-wrap { overflow-x: auto; }
.kv { display: grid; grid-template-columns: 170px 1fr; gap: 6px 14px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
@media (max-width: 850px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kv { grid-template-columns: 1fr; } }
@media (max-width: 540px) { .cards { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<header>
<h1>TTS benchmark report</h1>
<p class="meta">Source <code>${escapeHtml(inputPath)}</code> · generated ${escapeHtml(new Date().toISOString())}</p>
<p class="meta">Run ${escapeHtml(global.runIds.join(", ") || "unknown")} · endpoint ${escapeHtml(global.endpoints.join(", ") || "unknown")} · voice ${escapeHtml(global.voices.join(", ") || "unknown")} · speed ${escapeHtml(global.speeds.join(", ") || "unknown")}</p>
</header>

<section class="cards" aria-label="summary cards">
<div class="card"><div class="label">p50 total</div><div class="value">${formatMs(global.totalMs.p50)}</div><div class="sub">p90 ${formatMs(global.totalMs.p90)}</div></div>
<div class="card"><div class="label">p50 RTF</div><div class="value">${formatRtf(global.rtf.p50)}</div><div class="sub">≈${global.rtf.p50 ? (1 / global.rtf.p50).toFixed(1) : "—"}× realtime</div></div>
<div class="card"><div class="label">p50 TTFB</div><div class="value">${formatMs(global.ttfbMs.p50)}</div><div class="sub">total−TTFB ${formatMs(global.ttfbToTotalMs.p50)}</div></div>
<div class="card"><div class="label">Rows</div><div class="value">${global.selectedRows}</div><div class="sub">${includeWarmups ? "warmups included" : `${global.warmupRows} warmups excluded`}</div></div>
</section>

<section class="panel">
<h2 style="margin-top:0">Interpretation</h2>
<ul class="interpretation">${interpretations.map((note) => `<li>${escapeHtml(note)}</li>`).join("\n")}</ul>
</section>

<section class="panel">
<h2 style="margin-top:0">Run metadata</h2>
<dl class="kv">
<dt>Started</dt><dd>${escapeHtml(global.startedAt ?? "—")}</dd>
<dt>Ended</dt><dd>${escapeHtml(global.endedAt ?? "—")}</dd>
<dt>Failures</dt><dd>${global.failureRows}</dd>
<dt>Warmup mean total</dt><dd>${formatMs(warmupComparison.warmupTotalMeanMs)} (${isFiniteNumber(warmupComparison.totalDeltaPct) ? `${warmupComparison.totalDeltaPct.toFixed(1)}% vs measured` : "—"})</dd>
<dt>Corr: p50 total vs chars</dt><dd>${formatNumber(correlations.p50TotalVsChars, 2)}</dd>
<dt>Corr: p50 total vs audio duration</dt><dd>${formatNumber(correlations.p50TotalVsAudioDuration, 2)}</dd>
</dl>
</section>

<h2>Per-file summary</h2>
<div class="table-wrap panel" style="padding:0">${summaryTable(files)}</div>

<h2>Charts</h2>
${barChartHorizontal(chartItems, [
  { key: "p50TotalMs", label: "p50", color: "#2563eb" },
  { key: "p90TotalMs", label: "p90", color: "#f97316" },
], { title: "Total latency by input", subtitle: "lower is better" })}
${barChartHorizontal(chartItems, [
  { key: "p50Rtf", label: "p50", color: "#16a34a" },
  { key: "p90Rtf", label: "p90", color: "#9333ea" },
], { title: "Real-time factor by input", subtitle: "<1 means faster than playback", valueFormat: formatRtf })}
${scatterChart(chartItems, { xKey: "p50WavDurationMs", yKey: "p50TotalMs", xLabel: "p50 generated audio duration", yLabel: "p50 total latency", title: "Latency vs generated audio duration", xFormat: formatShortMs })}
${scatterChart(chartItems, { xKey: "chars", yKey: "p50TotalMs", xLabel: "raw input characters", yLabel: "p50 total latency", title: "Latency vs raw input size", xFormat: (value) => String(Math.round(value)) })}
${lineChart(summary.selectedRows, { title: "Per-iteration total latency" })}

<h2>Raw data</h2>
${rawTable(rows)}

<footer>Generated by <code>tts-bench/report-tts.mjs</code>. Aggregates use successful rows; warmups are ${includeWarmups ? "included" : "excluded by default"} in summary charts.</footer>
</main>
</body>
</html>`;
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.input)) {
  console.error(`Input file does not exist: ${args.input}`);
  process.exit(1);
}

const rows = parseJsonl(args.input);
const summary = summarize(rows, args.includeWarmups);
const html = renderHtml({ rows, summary, inputPath: args.input, includeWarmups: args.includeWarmups });
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, html);

if (args.summaryJson) {
  mkdirSync(dirname(args.summaryJson), { recursive: true });
  writeFileSync(
    args.summaryJson,
    `${JSON.stringify(
      {
        input: args.input,
        generatedAt: new Date().toISOString(),
        includeWarmups: args.includeWarmups,
        global: summary.global,
        files: summary.files,
        correlations: summary.correlations,
        warmupComparison: summary.warmupComparison,
        failures: summary.failures,
      },
      null,
      2,
    )}\n`,
  );
}

console.log(`Wrote ${args.out}`);
if (args.summaryJson) console.log(`Wrote ${args.summaryJson}`);
console.log(`Analyzed ${summary.global.selectedRows} successful ${args.includeWarmups ? "rows" : "non-warmup rows"} across ${summary.files.length} files.`);
