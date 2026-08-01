import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	extractAssistantSnippets,
	extractMarkdownSnippets,
} from "./snippets.ts";

describe("extractMarkdownSnippets", () => {
	it("extracts fenced and inline backtick snippets in source order", () => {
		const text = [
			"Run `pnpm test`, then use:",
			"",
			"```sh",
			"printf '%s\\n' ok",
			"```",
			"",
			"The path is `packages/pi-snippets`.",
		].join("\n");

		assert.deepEqual(
			extractMarkdownSnippets(text).map(({ kind, content, language }) => ({
				kind,
				content,
				language,
			})),
			[
				{ kind: "inline", content: "pnpm test", language: undefined },
				{ kind: "fenced", content: "printf '%s\\n' ok", language: "sh" },
				{
					kind: "inline",
					content: "packages/pi-snippets",
					language: undefined,
				},
			],
		);
	});

	it("does not extract inline snippets from inside fenced blocks", () => {
		const snippets = extractMarkdownSnippets(
			"```ts\nconst value = `nested`;\n```",
		);
		assert.equal(snippets.length, 1);
		assert.equal(snippets[0]?.kind, "fenced");
		assert.equal(snippets[0]?.content, "const value = `nested`;");
	});

	it("supports longer fences and inline delimiters", () => {
		const text = "````md\n```sh\necho ok\n```\n````\nUse ``a ` b``.";
		const snippets = extractMarkdownSnippets(text);
		assert.equal(snippets[0]?.kind, "fenced");
		assert.equal(snippets[0]?.content, "```sh\necho ok\n```");
		assert.equal(snippets[1]?.content, "a ` b");
	});

	it("can exclude inline snippets", () => {
		const snippets = extractMarkdownSnippets(
			"`inline`\n\n```sh\necho fenced\n```",
			{
				includeInline: false,
			},
		);
		assert.deepEqual(
			snippets.map((snippet) => snippet.content),
			["echo fenced"],
		);
	});

	it("ignores unmatched delimiters", () => {
		assert.deepEqual(extractMarkdownSnippets("An unmatched ` delimiter"), []);
	});
});

describe("extractAssistantSnippets", () => {
	it("reads only assistant text blocks and preserves response metadata", () => {
		const entries = [
			{
				type: "message",
				id: "user0001",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "Ignore `user code`", timestamp: 1 },
			},
			{
				type: "message",
				id: "agent01",
				parentId: "user0001",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Use `first`." }],
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "agent02",
				parentId: "agent01",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Then `second`." }],
					timestamp: 3,
				},
			},
		] as unknown as SessionEntry[];

		const snippets = extractAssistantSnippets(entries);
		assert.deepEqual(
			snippets.map(({ content, responseIndex, responseCount }) => ({
				content,
				responseIndex,
				responseCount,
			})),
			[
				{ content: "first", responseIndex: 1, responseCount: 2 },
				{ content: "second", responseIndex: 2, responseCount: 2 },
			],
		);
	});
});
