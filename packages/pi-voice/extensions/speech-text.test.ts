import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyPronunciationRules,
	codeSummaryTargets,
	normalizeTechnicalTokens,
	type PronunciationRule,
	prepareSpeechText,
	segmentSpeechText,
	shouldSummarizeToolOutput,
} from "./speech-text.ts";

describe("segmentSpeechText", () => {
	it("preserves prose around inline and fenced code", () => {
		const segments = segmentSpeechText(
			[
				"Before `npm test`.",
				"",
				"```ts",
				"export function add(a: number, b: number) {",
				"  return a + b;",
				"}",
				"```",
				"",
				"After the block.",
			].join("\n"),
		);

		assert.deepEqual(
			segments.map((segment) => segment.kind),
			["prose", "command", "prose", "codeBlock", "prose"],
		);
		assert.equal(segments[0]?.text, "Before ");
		assert.equal(segments[1]?.text, "npm test");
		assert.match(segments[2]?.text ?? "", /\.\n\n$/);
		assert.match(segments[3]?.text ?? "", /return a \+ b/);
		assert.equal(segments[3]?.language, "ts");
		assert.equal(segments[4]?.text, "\nAfter the block.");
	});

	it("supports longer tilde fences without treating inner fences as closers", () => {
		const segments = segmentSpeechText(
			"~~~~md\n```sh\necho ok\n```\n~~~~\nDone.",
		);
		assert.equal(segments[0]?.kind, "codeBlock");
		assert.equal(segments[0]?.language, "md");
		assert.match(segments[0]?.text ?? "", /```sh/);
		assert.equal(segments[1]?.text, "Done.");
	});

	it("classifies inline technical values with specific segment kinds", () => {
		const segments = segmentSpeechText(
			"`identifier` `npm test` `/tmp/a` `https://example.test` `Error: failed` `00000000-0000-0000-0000-000000000000`",
		);
		assert.deepEqual(
			segments
				.filter((segment) => segment.kind !== "prose")
				.map((segment) => segment.kind),
			["inlineCode", "command", "path", "url", "error", "opaque"],
		);
	});

	it("leaves malformed fences as prose and retains unterminated fences as code", () => {
		const malformed = segmentSpeechText(
			"Before\n``ts\nconst value = 1;\nAfter",
		);
		assert.deepEqual(
			malformed.map((segment) => segment.kind),
			["prose"],
		);

		const unterminated = segmentSpeechText(
			"Start\n```bash\nnpm test\nnpm run build",
		);
		assert.deepEqual(
			unterminated.map((segment) => segment.kind),
			["prose", "codeBlock"],
		);
		assert.equal(unterminated[1]?.text, "npm test\nnpm run build");

		const empty = segmentSpeechText("Before\n```\n```\nAfter");
		assert.deepEqual(
			empty.map((segment) => segment.kind),
			["prose", "codeBlock", "prose"],
		);
	});
});

describe("deterministic technical profile", () => {
	it("selects only long code blocks for optional LLM summaries", () => {
		const input = [
			"Before.",
			"```sh",
			"npm test",
			"```",
			"```ts",
			"export function one() {}",
			"export function two() {}",
			"export function three() {}",
			"```",
		].join("\n");
		const profile = {
			code: { longMode: "llm" as const, shortMaxLines: 2, shortMaxChars: 80 },
		};
		const targets = codeSummaryTargets(input, profile);
		assert.deepEqual(targets.map((target) => target.id), [1]);
		const prepared = prepareSpeechText(input, {
			profile,
			codeSummaries: { 1: "Defines three exported functions." },
		});
		assert.match(prepared, /Shell commands: npm test/);
		assert.match(prepared, /TypeScript block: Defines three exported functions/);
	});

	it("selects only oversized tool output for optional LLM summaries", () => {
		const profile = {
			limits: { maxLines: 2, maxChars: 100 },
			toolOutput: { longMode: "llm" as const },
		};
		assert.equal(shouldSummarizeToolOutput("one\ntwo\nthree", profile), true);
		assert.equal(shouldSummarizeToolOutput("one\ntwo", profile), false);
	});

	it("preserves mixed prose and describes source declarations instead of line counts", () => {
		const prepared = prepareSpeechText(
			[
				"This is the proposed fix.",
				"",
				"```ts",
				"interface Options { enabled: boolean }",
				"export function configure(options: Options) {",
				"  return options.enabled;",
				"}",
				"```",
				"",
				"Apply it before release.",
			].join("\n"),
		);

		assert.match(prepared, /^This is the proposed fix\./);
		assert.match(prepared, /TypeScript block defines/);
		assert.match(prepared, /interface Options/);
		assert.match(prepared, /function configure/);
		assert.match(prepared, /Apply it before release\.$/);
		assert.doesNotMatch(prepared, /\b\d+ (?:non empty )?lines?\b/i);
		assert.doesNotMatch(prepared, /return options\.enabled/);
	});

	it("speaks bounded short shell commands and outlines long shell blocks", () => {
		const short = prepareSpeechText("```sh\nnpm test\npnpm build\n```");
		assert.match(short, /^Shell commands:/);
		assert.match(short, /npm test/);
		assert.match(short, /pnpm build/);

		const long = prepareSpeechText(
			"```bash\ngit status\nnpm test\npnpm build\ndocker compose up\n```",
			{
				profile: { code: { shortMaxLines: 2, shortMaxChars: 80 } },
			},
		);
		assert.match(long, /^Shell block runs/);
		assert.match(long, /git status/);
		assert.match(long, /npm test/);
		assert.match(long, /2 more commands omitted/);
		assert.doesNotMatch(long, /docker compose up/);
	});

	it("announces JSON top-level keys without leaking nested values", () => {
		const prepared = prepareSpeechText(
			'```json\n{"name":"voice","scripts":{"test":"node test"},"private":true}\n```',
		);
		assert.match(prepared, /JSON object with top-level keys/);
		assert.match(prepared, /name/);
		assert.match(prepared, /scripts/);
		assert.match(prepared, /private/);
		assert.doesNotMatch(prepared, /node test/);
	});

	it("announces diff files and addition and removal counts", () => {
		const prepared = prepareSpeechText(
			[
				"```diff",
				"diff --git a/src/old.ts b/src/new.ts",
				"--- a/src/old.ts",
				"+++ b/src/new.ts",
				"-const oldName = true;",
				"+const newName = true;",
				"+export { newName };",
				"```",
			].join("\n"),
		);
		assert.match(prepared, /Diff changes 1 file/);
		assert.match(prepared, /src\/new\.ts/);
		assert.match(prepared, /2 additions and 1 removal/);
	});

	it("uses useful bounded excerpts for unknown blocks", () => {
		const prepared = prepareSpeechText(
			"```sql\nSELECT id, name\nFROM users\nWHERE active = true\nORDER BY name\n```",
			{ profile: { limits: { maxLines: 2, maxChars: 200 } } },
		);
		assert.match(prepared, /SQL block starts with/);
		assert.match(prepared, /SELECT id, name/);
		assert.match(prepared, /FROM users/);
		assert.match(prepared, /2 more lines omitted/);
		assert.doesNotMatch(prepared, /code block with \d+/i);
	});
});

describe("tool output profiles", () => {
	it("keeps a bounded bash tail for success and more context for errors", () => {
		const output = Array.from(
			{ length: 8 },
			(_, index) => `output ${index + 1}`,
		).join("\n");
		const context = {
			source: "auto" as const,
			role: "toolResult" as const,
			tool: "bash",
		};
		const profile = { toolOutput: { headLines: 2, tailLines: 2 } };

		const success = prepareSpeechText(output, {
			context,
			profile,
			toolArgs: { command: "npm test" },
		});
		assert.match(success, /Bash command npm test succeeded/);
		assert.match(success, /output 7; output 8/);
		assert.match(success, /6 lines omitted/);
		assert.doesNotMatch(success, /output 1/);

		const failure = prepareSpeechText(output, {
			context,
			profile,
			toolArgs: { command: "npm test" },
			isError: true,
		});
		assert.match(failure, /failed/);
		assert.match(failure, /Error output/);
		assert.match(failure, /output 1; output 2; output 7; output 8/);
		assert.match(failure, /4 lines omitted/);
	});

	it("outlines read output using its path, range, and declarations", () => {
		const prepared = prepareSpeechText(
			"10: export function loadConfig() {\n11:   return {};\n12: }",
			{
				context: { source: "auto", role: "toolResult", tool: "read" },
				toolArgs: { filePath: "src/config.ts", offset: 10, limit: 3 },
			},
		);
		assert.match(prepared, /Read src\/config\.ts, lines 10 through 12/);
		assert.match(prepared, /TypeScript block defines function loadConfig/);
		assert.doesNotMatch(prepared, /return \{\}/);
	});

	it("summarizes grep matches and representative files", () => {
		const prepared = prepareSpeechText(
			"src/a.ts:10:prepareSpeechText(input)\nsrc/a.ts:20:prepareSpeechText(output)\nsrc/b.ts:4:prepareSpeechText(value)",
			{
				context: { source: "auto", role: "toolResult", tool: "grep" },
				toolArgs: { pattern: "prepareSpeechText" },
			},
		);
		assert.match(prepared, /Grep found 3 matches in 2 files/);
		assert.match(prepared, /src\/a\.ts line 10/);
		assert.match(prepared, /src\/b\.ts line 4/);
	});

	it("counts find and ls results with bounded sample paths", () => {
		for (const tool of ["find", "ls"] as const) {
			const prepared = prepareSpeechText(
				"src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.ts",
				{
					context: { source: "auto", role: "toolResult", tool },
					profile: { toolOutput: { headLines: 2 } },
				},
			);
			assert.match(prepared, new RegExp(`${tool} returned 4 results`));
			assert.match(prepared, /src\/a\.ts/);
			assert.match(prepared, /src\/b\.ts/);
			assert.match(prepared, /2 more results omitted/);
			assert.doesNotMatch(prepared, /src\/d\.ts/);
		}
	});

	it("uses bounded head and tail output for unknown tools", () => {
		const output = Array.from(
			{ length: 8 },
			(_, index) => `line ${index + 1}`,
		).join("\n");
		const prepared = prepareSpeechText(output, {
			context: { source: "auto", role: "toolResult", tool: "custom" },
			profile: { toolOutput: { headLines: 2, tailLines: 1 } },
		});
		assert.match(prepared, /Tool custom returned/);
		assert.match(prepared, /line 1; line 2; line 8/);
		assert.match(prepared, /5 lines omitted/);
		assert.doesNotMatch(prepared, /line 4/);
	});
});

describe("technical token cleanup", () => {
	it("converts byte counts to spoken units", () => {
		assert.equal(
			normalizeTechnicalTokens(
				"512 bytes, 1536 bytes, 1048576 bytes, and 2 MB",
			),
			"512 bytes, 1.5 kilobytes, 1 megabyte, and 2 megabytes",
		);
	});

	it("shortens UUID, long hex, and base64 values with distinguishing previews", () => {
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		const hex = "0123456789abcdef0123456789abcdef";
		const base64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
		const prepared = prepareSpeechText(`IDs: ${uuid}, ${hex}, ${base64}.`);

		assert.match(prepared, /UUID 550e8400\.\.\.0000/);
		assert.match(prepared, /hex value 012345\.\.\.cdef/);
		assert.match(prepared, /base64 value QWxhZG\.\.\.ZQ==/);
		assert.doesNotMatch(prepared, new RegExp(uuid));
		assert.doesNotMatch(prepared, new RegExp(hex));
		assert.doesNotMatch(prepared, /QWxhZGRpbjpvcGVuIHNlc2FtZQ==/);
	});
});

describe("pronunciation rules", () => {
	it("honors path segment and suffix kind scopes", () => {
		const rules: PronunciationRule[] = [
			{
				match: "etc",
				replace: "etsy",
				mode: "pathSegment",
				scope: { kinds: ["path"] },
			},
			{
				match: "ctl",
				replace: " control",
				mode: "suffix",
				scope: { kinds: ["inlineCode"] },
			},
		];
		const prepared = prepareSpeechText(
			"Read `/etc/nginx`, use `kubectl`, and leave etc or kubectl alone.",
			{
				pronunciations: { version: 1, rules },
			},
		);
		assert.equal(
			prepared,
			"Read /etsy/nginx, use kube control, and leave etc or kubectl alone.",
		);
	});

	it("honors word and prefix token boundaries", () => {
		assert.equal(
			applyPronunciationRules("api apical xapi", [
				{ match: "api", replace: "A P I", mode: "word" },
			]),
			"A P I apical xapi",
		);
		assert.equal(
			applyPronunciationRules("kubectl akube", [
				{ match: "kube", replace: "cube", mode: "prefix" },
			]),
			"cubectl akube",
		);
	});

	it("combines scope fields with AND and values within arrays with OR", () => {
		const rule: PronunciationRule = {
			match: "api",
			replace: "A P I",
			scope: {
				source: ["auto", "sample"],
				event: ["message_end", "agent_end"],
				roles: ["assistant"],
				kinds: ["inlineCode", "command"],
				tools: ["read", "grep"],
				languages: ["ts", "tsx"],
			},
		};
		const matchingContext = {
			source: "auto" as const,
			event: "message_end",
			role: "assistant" as const,
			tool: "grep",
		};
		assert.equal(
			applyPronunciationRules("api", [rule], matchingContext, {
				kind: "inlineCode",
				language: "ts",
			}),
			"A P I",
		);
		assert.equal(
			applyPronunciationRules(
				"api",
				[rule],
				{ ...matchingContext, role: "user" },
				{
					kind: "inlineCode",
					language: "ts",
				},
			),
			"api",
		);
	});

	it("uses the longest overlapping match and file order for ties", () => {
		assert.equal(
			applyPronunciationRules("abcd", [
				{ match: "abc", replace: "short", mode: "literal" },
				{ match: "abcd", replace: "long", mode: "literal" },
			]),
			"long",
		);
		assert.equal(
			applyPronunciationRules("abcde", [
				{ match: "abc", replace: "short", mode: "literal" },
				{ match: "bcde", replace: "LONG", mode: "literal" },
			]),
			"aLONG",
		);
		assert.equal(
			applyPronunciationRules("api", [
				{ match: "api", replace: "first", mode: "literal" },
				{ match: "api", replace: "second", mode: "literal" },
			]),
			"first",
		);
	});

	it("applies rules once without cascading replacement text", () => {
		assert.equal(
			applyPronunciationRules("a b", [
				{ match: "a", replace: "b", mode: "literal" },
				{ match: "b", replace: "c", mode: "literal" },
			]),
			"b c",
		);
	});

	it("treats literal metacharacters as text rather than regular expressions", () => {
		assert.equal(
			applyPronunciationRules("a.b a-b", [
				{ match: ".", replace: " dot ", mode: "literal" },
			]),
			"a dot b a-b",
		);
	});
});

describe("malformed input preparation", () => {
	it("does not throw for malformed or unterminated fences", () => {
		assert.doesNotThrow(() =>
			prepareSpeechText("Before\n``ts\nconst x = 1;\nAfter"),
		);
		const unterminated = prepareSpeechText(
			"Start\n```bash\nnpm test\nnpm run build",
		);
		assert.match(unterminated, /^Start\nShell commands:/);
		assert.match(unterminated, /npm test/);
		assert.match(unterminated, /npm run build/);
		assert.doesNotMatch(unterminated, /```/);
	});
});
