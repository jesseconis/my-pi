import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	loadPronunciations,
	normalizeSpeechConfig,
	resolveConfiguredProfile,
} from "./config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-voice-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("speech config", () => {
	it("preserves FIFO defaults and normalizes interruption settings", () => {
		const defaults = normalizeSpeechConfig(undefined);
		assert.equal(defaults.queue.onUserInput, "continue");
		assert.deepEqual(defaults.queue.inputSources, ["interactive", "rpc"]);

		const configured = normalizeSpeechConfig({
			queue: { onUserInput: "interrupt", inputSources: ["interactive", "extension"] },
		});
		assert.equal(configured.queue.onUserInput, "interrupt");
		assert.deepEqual(configured.queue.inputSources, ["interactive", "extension"]);
		assert.deepEqual(
			normalizeSpeechConfig({ queue: { inputSources: [] } }).queue.inputSources,
			[],
		);
	});

	it("resolves named profiles with a technical fallback", () => {
		const config = normalizeSpeechConfig({
			processing: {
				defaultProfile: "monitor",
				profiles: {
					monitor: { limits: { maxLines: 5 }, code: { longMode: "llm" } },
				},
			},
		});
		assert.equal(resolveConfiguredProfile(config).limits?.maxLines, 5);
		assert.equal(resolveConfiguredProfile(config).code?.longMode, "llm");
		assert.equal(resolveConfiguredProfile(config, "missing").base, "technical");
	});
});

describe("pronunciation loading", () => {
	it("loads and validates scoped rules relative to PI_VOICE_DIR", () => {
		const directory = temporaryDirectory();
		writeFileSync(
			join(directory, "pronunciations.json"),
			JSON.stringify({
				version: 1,
				rules: [
					{
						match: "ctl",
						replace: " control",
						mode: "suffix",
						scope: { kinds: ["command"], tools: ["bash"] },
					},
				],
			}),
		);
		const config = normalizeSpeechConfig({
			processing: { pronunciationFile: "pronunciations.json" },
		});
		const result = loadPronunciations(directory, config);
		assert.equal(result.error, undefined);
		assert.equal(result.file.rules.length, 1);
		assert.deepEqual(result.file.rules[0]?.scope?.kinds, ["command"]);
	});

	it("keeps the last valid snapshot when reload fails", () => {
		const directory = temporaryDirectory();
		writeFileSync(join(directory, "bad.json"), "{ invalid");
		const previous = {
			version: 1 as const,
			rules: [{ match: "etc", replace: "etsy", mode: "word" as const }],
		};
		const config = normalizeSpeechConfig({
			processing: { pronunciationFile: "bad.json" },
		});
		const result = loadPronunciations(directory, config, previous);
		assert.ok(result.error);
		assert.deepEqual(result.file, previous);
	});

	it("rejects invalid modes and scopes instead of broadening them", () => {
		const directory = temporaryDirectory();
		for (const [name, rule] of [
			["mode", { match: "ctl", replace: "control", mode: "regex" }],
			[
				"unknown-scope",
				{ match: "etc", replace: "etsy", scope: { role: ["assistant"] } },
			],
			[
				"scope",
				{
					match: "etc",
					replace: "etsy",
					scope: { kinds: ["not-a-kind"] },
				},
			],
		] as const) {
			writeFileSync(
				join(directory, `${name}.json`),
				JSON.stringify({ version: 1, rules: [rule] }),
			);
			const config = normalizeSpeechConfig({
				processing: { pronunciationFile: `${name}.json` },
			});
			const previous = {
				version: 1 as const,
				rules: [{ match: "safe", replace: "safe" }],
			};
			const result = loadPronunciations(directory, config, previous);
			assert.ok(result.error);
			assert.deepEqual(result.file, previous);
		}
	});
});
