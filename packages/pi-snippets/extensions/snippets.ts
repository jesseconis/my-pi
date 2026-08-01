import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type SnippetKind = "fenced" | "inline";

export interface SnippetExtractionOptions {
	includeFenced?: boolean;
	includeInline?: boolean;
}

export interface ParsedSnippet {
	kind: SnippetKind;
	content: string;
	language?: string;
	start: number;
	end: number;
	context?: string;
}

export interface AssistantSnippet extends ParsedSnippet {
	id: string;
	entryId: string;
	responseIndex: number;
	responseCount: number;
	textPartIndex: number;
	timestamp: number;
}

interface SourceLine {
	start: number;
	end: number;
	next: number;
	text: string;
}

interface SourceRange {
	start: number;
	end: number;
}

function sourceLines(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;

	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const next = newline === -1 ? text.length : newline + 1;
		const raw = text.slice(start, end);
		lines.push({
			start,
			end,
			next,
			text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
		});
		start = next;
	}

	return lines;
}

function removeClosingLineBreak(content: string): string {
	if (content.endsWith("\r\n")) return content.slice(0, -2);
	if (content.endsWith("\n")) return content.slice(0, -1);
	return content;
}

function cleanContext(value: string): string | undefined {
	const cleaned = value
		.replace(/```+/g, "")
		.replace(/^[\s>*#\-+\d.)]+/, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || undefined;
}

function precedingContext(text: string, start: number): string | undefined {
	const lines = text.slice(0, start).trimEnd().split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const context = cleanContext(lines[index] ?? "");
		if (context) return context;
	}
	return undefined;
}

function inlineContext(
	text: string,
	start: number,
	end: number,
): string | undefined {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const nextNewline = text.indexOf("\n", end);
	const lineEnd = nextNewline === -1 ? text.length : nextNewline;
	const line = `${text.slice(lineStart, start)}…${text.slice(end, lineEnd)}`;
	return cleanContext(line);
}

function extractFencedSnippets(text: string): {
	snippets: ParsedSnippet[];
	ranges: SourceRange[];
} {
	const lines = sourceLines(text);
	const snippets: ParsedSnippet[] = [];
	const ranges: SourceRange[] = [];

	for (let index = 0; index < lines.length; index++) {
		const openingLine = lines[index];
		if (!openingLine) continue;
		const opening = openingLine.text.match(/^ {0,3}(`{3,})([^`]*)$/);
		const openingFence = opening?.[1];
		if (!opening || !openingFence) continue;

		const fenceLength = openingFence.length;
		let closingIndex = -1;
		for (let candidate = index + 1; candidate < lines.length; candidate++) {
			const candidateLine = lines[candidate];
			if (!candidateLine) continue;
			const closing = candidateLine.text.match(/^ {0,3}(`{3,})[\t ]*$/);
			const closingFence = closing?.[1];
			if (closingFence && closingFence.length >= fenceLength) {
				closingIndex = candidate;
				break;
			}
		}
		if (closingIndex === -1) continue;

		const closingLine = lines[closingIndex];
		if (!closingLine) continue;
		const language = (opening[2] ?? "").trim().split(/\s+/, 1)[0] || undefined;
		const content = removeClosingLineBreak(
			text.slice(openingLine.next, closingLine.start),
		);
		const range = { start: openingLine.start, end: closingLine.next };
		ranges.push(range);
		snippets.push({
			kind: "fenced",
			content,
			language,
			start: range.start,
			end: range.end,
			context: precedingContext(text, range.start),
		});
		index = closingIndex;
	}

	return { snippets, ranges };
}

function rangeContaining(
	ranges: readonly SourceRange[],
	offset: number,
): SourceRange | undefined {
	return ranges.find((range) => offset >= range.start && offset < range.end);
}

function backtickRunLength(text: string, start: number): number {
	let end = start;
	while (text[end] === "`") end++;
	return end - start;
}

function normalizeInlineCode(content: string): string {
	let normalized = content.replace(/\r?\n/g, " ");
	if (
		normalized.startsWith(" ") &&
		normalized.endsWith(" ") &&
		!/^ +$/.test(normalized)
	) {
		normalized = normalized.slice(1, -1);
	}
	return normalized;
}

function extractInlineSnippets(
	text: string,
	fencedRanges: readonly SourceRange[],
): ParsedSnippet[] {
	const snippets: ParsedSnippet[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const fencedRange = rangeContaining(fencedRanges, cursor);
		if (fencedRange) {
			cursor = fencedRange.end;
			continue;
		}
		if (text[cursor] !== "`") {
			cursor++;
			continue;
		}

		const delimiterLength = backtickRunLength(text, cursor);
		let candidate = cursor + delimiterLength;
		let closingStart = -1;

		while (candidate < text.length) {
			const skippedRange = rangeContaining(fencedRanges, candidate);
			if (skippedRange) {
				candidate = skippedRange.end;
				continue;
			}
			if (text[candidate] !== "`") {
				candidate++;
				continue;
			}
			const candidateLength = backtickRunLength(text, candidate);
			if (candidateLength === delimiterLength) {
				closingStart = candidate;
				break;
			}
			candidate += candidateLength;
		}

		if (closingStart === -1) {
			cursor += delimiterLength;
			continue;
		}

		const end = closingStart + delimiterLength;
		const content = normalizeInlineCode(
			text.slice(cursor + delimiterLength, closingStart),
		);
		if (content) {
			snippets.push({
				kind: "inline",
				content,
				start: cursor,
				end,
				context: inlineContext(text, cursor, end),
			});
		}
		cursor = end;
	}

	return snippets;
}

export function extractMarkdownSnippets(
	text: string,
	options: SnippetExtractionOptions = {},
): ParsedSnippet[] {
	const includeFenced = options.includeFenced ?? true;
	const includeInline = options.includeInline ?? true;
	const fenced = extractFencedSnippets(text);
	return [
		...(includeFenced ? fenced.snippets : []),
		...(includeInline ? extractInlineSnippets(text, fenced.ranges) : []),
	].sort((left, right) => left.start - right.start);
}

export function extractAssistantSnippets(
	entries: readonly SessionEntry[],
	options: SnippetExtractionOptions = {},
): AssistantSnippet[] {
	const responseCount = entries.filter(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	).length;
	const snippets: AssistantSnippet[] = [];
	let responseIndex = 0;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant")
			continue;
		responseIndex++;

		for (
			let textPartIndex = 0;
			textPartIndex < entry.message.content.length;
			textPartIndex++
		) {
			const part = entry.message.content[textPartIndex];
			if (part?.type !== "text") continue;
			const parsed = extractMarkdownSnippets(part.text, options);
			for (const snippet of parsed) {
				snippets.push({
					...snippet,
					id: `${entry.id}:${textPartIndex}:${snippet.kind}:${snippet.start}`,
					entryId: entry.id,
					responseIndex,
					responseCount,
					textPartIndex,
					timestamp: entry.message.timestamp,
				});
			}
		}
	}

	return snippets;
}
