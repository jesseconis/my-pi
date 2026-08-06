export type SpeechSource = "auto" | "tool" | "sample";

export type SpeechRole = "assistant" | "user" | "toolResult";

export type SpeechSegmentKind =
	| "prose"
	| "inlineCode"
	| "codeBlock"
	| "command"
	| "path"
	| "url"
	| "error"
	| "opaque";

export interface SpeechContext {
	source: SpeechSource;
	event?: string;
	role?: SpeechRole;
	tool?: string;
	language?: string;
}

export interface SpeechSegment {
	kind: SpeechSegmentKind;
	text: string;
	language?: string;
	info?: string;
}

export interface SpeechProfileConfig {
	base?: "technical";
	limits?: {
		maxLines?: number;
		maxChars?: number;
	};
	code?: {
		shortMaxLines?: number;
		shortMaxChars?: number;
		longMode?: "outline" | "llm";
		fallback?: "outline";
	};
	toolOutput?: {
		headLines?: number;
		tailLines?: number;
		longMode?: "bounded" | "llm";
		fallback?: "bounded";
	};
}

export type PronunciationMode =
	| "word"
	| "prefix"
	| "suffix"
	| "pathSegment"
	| "literal";

type ScopeValue<T extends string> = T | readonly T[];

export interface PronunciationScope {
	source?: ScopeValue<SpeechSource>;
	event?: ScopeValue<string>;
	roles?: readonly SpeechRole[];
	kinds?: readonly SpeechSegmentKind[];
	tools?: readonly string[];
	languages?: readonly string[];
}

export interface PronunciationRule {
	match: string;
	replace: string;
	mode?: PronunciationMode;
	scope?: PronunciationScope;
}

export interface PronunciationFile {
	version: 1;
	rules: PronunciationRule[];
}

export interface PrepareSpeechTextOptions {
	context?: SpeechContext;
	profile?: SpeechProfileConfig;
	pronunciations?: PronunciationFile | readonly PronunciationRule[];
	toolArgs?: Record<string, unknown>;
	isError?: boolean;
	codeSummaries?: Readonly<Record<number, string>>;
	toolSummary?: string;
}

export interface CodeSummaryTarget {
	id: number;
	language?: string;
	text: string;
}

interface ResolvedSpeechProfile {
	limits: {
		maxLines: number;
		maxChars: number;
	};
	code: {
		shortMaxLines: number;
		shortMaxChars: number;
		longMode: "outline" | "llm";
		fallback: "outline";
	};
	toolOutput: {
		headLines: number;
		tailLines: number;
		longMode: "bounded" | "llm";
		fallback: "bounded";
	};
}

export const DEFAULT_SPEECH_PROFILE: Readonly<ResolvedSpeechProfile> = {
	limits: {
		maxLines: 12,
		maxChars: 1200,
	},
	code: {
		shortMaxLines: 3,
		shortMaxChars: 240,
		longMode: "outline",
		fallback: "outline",
	},
	toolOutput: {
		headLines: 6,
		tailLines: 4,
		longMode: "bounded",
		fallback: "bounded",
	},
};

const DEFAULT_CONTEXT: SpeechContext = { source: "auto" };
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI terminal escapes
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripControlCharacters(text: string): string {
	return [...text]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return (
				code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
			);
		})
		.join("");
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && (value ?? 0) > 0
		? Math.floor(value as number)
		: fallback;
}

export function resolveSpeechProfile(
	profile: SpeechProfileConfig = {},
): ResolvedSpeechProfile {
	return {
		limits: {
			maxLines: positiveInteger(
				profile.limits?.maxLines,
				DEFAULT_SPEECH_PROFILE.limits.maxLines,
			),
			maxChars: positiveInteger(
				profile.limits?.maxChars,
				DEFAULT_SPEECH_PROFILE.limits.maxChars,
			),
		},
		code: {
			shortMaxLines: positiveInteger(
				profile.code?.shortMaxLines,
				DEFAULT_SPEECH_PROFILE.code.shortMaxLines,
			),
			shortMaxChars: positiveInteger(
				profile.code?.shortMaxChars,
				DEFAULT_SPEECH_PROFILE.code.shortMaxChars,
			),
			longMode: profile.code?.longMode ?? DEFAULT_SPEECH_PROFILE.code.longMode,
			fallback: profile.code?.fallback ?? DEFAULT_SPEECH_PROFILE.code.fallback,
		},
		toolOutput: {
			headLines: positiveInteger(
				profile.toolOutput?.headLines,
				DEFAULT_SPEECH_PROFILE.toolOutput.headLines,
			),
			tailLines: positiveInteger(
				profile.toolOutput?.tailLines,
				DEFAULT_SPEECH_PROFILE.toolOutput.tailLines,
			),
			longMode:
				profile.toolOutput?.longMode ?? DEFAULT_SPEECH_PROFILE.toolOutput.longMode,
			fallback: profile.toolOutput?.fallback ?? DEFAULT_SPEECH_PROFILE.toolOutput.fallback,
		},
	};
}

function pushSegment(segments: SpeechSegment[], segment: SpeechSegment): void {
	if (!segment.text && segment.kind !== "codeBlock") return;
	const previous = segments.at(-1);
	if (
		previous?.kind === "prose" &&
		segment.kind === "prose" &&
		previous.language === segment.language &&
		previous.info === segment.info
	) {
		previous.text += segment.text;
		return;
	}
	segments.push(segment);
}

function inlineKind(text: string): SpeechSegmentKind {
	const value = text.trim();
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return "url";
	if (
		/^(?:~|\.{1,2}|\/)(?:[/\\]|[^\s])*$/i.test(value) ||
		/^[A-Za-z]:\\[^\s]+$/.test(value) ||
		/^[^\s]+[/\\][^\s]+$/.test(value)
	) {
		return "path";
	}
	if (/^(?:error|exception|fatal|failed|failure)\b/i.test(value))
		return "error";
	if (isOpaqueValue(value)) return "opaque";
	if (looksLikeCommand(value)) return "command";
	return "inlineCode";
}

function looksLikeCommand(value: string): boolean {
	if (!/\s/.test(value)) return false;
	const command =
		value
			.replace(/^\$\s*/, "")
			.split(/\s+/, 1)[0]
			?.toLowerCase() ?? "";
	return new Set([
		"bun",
		"cargo",
		"cd",
		"chmod",
		"cp",
		"curl",
		"docker",
		"find",
		"git",
		"go",
		"ls",
		"make",
		"mkdir",
		"mv",
		"node",
		"npm",
		"npx",
		"pip",
		"pnpm",
		"python",
		"rm",
		"rsync",
		"sudo",
		"yarn",
	]).has(command);
}

function splitInlineCode(text: string): SpeechSegment[] {
	const segments: SpeechSegment[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const opening = text.indexOf("`", cursor);
		if (opening < 0) {
			pushSegment(segments, { kind: "prose", text: text.slice(cursor) });
			break;
		}

		let runLength = 1;
		while (text[opening + runLength] === "`") runLength++;
		const delimiter = "`".repeat(runLength);
		let closing = text.indexOf(delimiter, opening + runLength);
		while (
			closing >= 0 &&
			(text[closing - 1] === "`" || text[closing + runLength] === "`")
		) {
			closing = text.indexOf(delimiter, closing + runLength);
		}

		if (closing < 0) {
			pushSegment(segments, { kind: "prose", text: text.slice(cursor) });
			break;
		}

		pushSegment(segments, { kind: "prose", text: text.slice(cursor, opening) });
		const content = text
			.slice(opening + runLength, closing)
			.replace(/^ | $/g, "")
			.replace(/\s+/g, " ");
		pushSegment(segments, { kind: inlineKind(content), text: content });
		cursor = closing + runLength;
	}

	return segments;
}

function fenceLanguage(info: string): string | undefined {
	let token = info.trim().split(/\s+/, 1)[0] ?? "";
	const braceLanguage = token.match(/^\{?\.([A-Za-z\d_+-]+)\}?$/);
	if (braceLanguage?.[1]) token = braceLanguage[1];
	token = token.replace(/^language-/, "").toLowerCase();
	return token || undefined;
}

/**
 * Splits fenced Markdown and inline code without requiring a Markdown parser.
 * Unterminated fences are intentionally retained as code blocks through EOF.
 */
export function segmentSpeechText(input: string): SpeechSegment[] {
	const text = String(input ?? "").replace(/\r\n?/g, "\n");
	const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
	if (lines.at(-1) === "") lines.pop();

	const fencedSegments: SpeechSegment[] = [];
	let prose = "";
	let code = "";
	let fenceCharacter = "";
	let fenceLength = 0;
	let info = "";

	const flushProse = () => {
		if (!prose) return;
		for (const segment of splitInlineCode(prose))
			pushSegment(fencedSegments, segment);
		prose = "";
	};

	const flushCode = () => {
		const content = code.endsWith("\n") ? code.slice(0, -1) : code;
		const segment: SpeechSegment = {
			kind: "codeBlock",
			text: content,
			...(fenceLanguage(info) ? { language: fenceLanguage(info) } : {}),
			...(info.trim() ? { info: info.trim() } : {}),
		};
		pushSegment(fencedSegments, segment);
		code = "";
		fenceCharacter = "";
		fenceLength = 0;
		info = "";
	};

	for (const lineWithEnding of lines) {
		const line = lineWithEnding.endsWith("\n")
			? lineWithEnding.slice(0, -1)
			: lineWithEnding;
		if (!fenceCharacter) {
			const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
			if (!opening?.[1]) {
				prose += lineWithEnding;
				continue;
			}
			if (opening[1][0] === "`" && opening[2]?.includes("`")) {
				prose += lineWithEnding;
				continue;
			}
			flushProse();
			fenceCharacter = opening[1][0] ?? "`";
			fenceLength = opening[1].length;
			info = opening[2] ?? "";
			continue;
		}

		const closing = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
		if (
			closing?.[1] &&
			closing[1][0] === fenceCharacter &&
			closing[1].length >= fenceLength
		) {
			flushCode();
			continue;
		}
		code += lineWithEnding;
	}

	if (fenceCharacter) flushCode();
	flushProse();
	return fencedSegments;
}

function segment(
	kind: SpeechSegmentKind,
	text: string,
	language?: string,
): SpeechSegment {
	return { kind, text, ...(language ? { language } : {}) };
}

function appendList(
	output: SpeechSegment[],
	values: readonly string[],
	kind: SpeechSegmentKind,
	language?: string,
): void {
	values.forEach((value, index) => {
		if (index > 0) {
			output.push(
				segment("prose", index === values.length - 1 ? " and " : ", "),
			);
		}
		output.push(segment(kind, value, language));
	});
}

function languageName(language: string | undefined): string {
	const names: Record<string, string> = {
		bash: "shell",
		c: "C",
		cpp: "C plus plus",
		cs: "C sharp",
		css: "CSS",
		diff: "diff",
		go: "Go",
		html: "HTML",
		java: "Java",
		javascript: "JavaScript",
		js: "JavaScript",
		json: "JSON",
		jsonc: "JSON",
		jsx: "JavaScript React",
		md: "Markdown",
		patch: "diff",
		py: "Python",
		python: "Python",
		rb: "Ruby",
		rs: "Rust",
		rust: "Rust",
		sh: "shell",
		shell: "shell",
		sql: "SQL",
		ts: "TypeScript",
		tsx: "TypeScript React",
		typescript: "TypeScript",
		yaml: "YAML",
		yml: "YAML",
	};
	return language ? (names[language.toLowerCase()] ?? language) : "code";
}

function isShellLanguage(language: string | undefined): boolean {
	return (
		!!language &&
		["bash", "console", "sh", "shell", "zsh"].includes(language.toLowerCase())
	);
}

function usefulLines(text: string): string[] {
	return text
		.replace(ANSI_PATTERN, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /[A-Za-z\d]/.test(line));
}

function truncate(value: string, maxChars: number): string {
	const text = value.trim();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function shellCommands(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim().replace(/^(?:\$|>)\s+/, ""))
		.filter((line) => line && !line.startsWith("#"));
}

function describeShellBlock(
	code: string,
	language: string | undefined,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] {
	const commands = shellCommands(code);
	if (commands.length === 0) {
		return [segment("codeBlock", "Empty shell block.", language)];
	}

	const short =
		commands.length <= profile.code.shortMaxLines &&
		code.length <= profile.code.shortMaxChars;
	const shownCount = short
		? commands.length
		: Math.min(commands.length, profile.code.shortMaxLines);
	const shown = commands
		.slice(0, shownCount)
		.map((command) => truncate(command, profile.code.shortMaxChars));
	const output = [
		segment("prose", short ? "Shell commands: " : "Shell block runs "),
	];
	appendList(output, shown, "command", language ?? "shell");
	output.push(segment("prose", "."));
	const omitted = commands.length - shown.length;
	if (omitted > 0) {
		output.push(
			segment(
				"prose",
				` ${omitted} more command${omitted === 1 ? "" : "s"} omitted.`,
			),
		);
	}
	return output;
}

interface Declaration {
	type: string;
	name: string;
}

function sourceDeclarations(code: string): Declaration[] {
	const declarations: Declaration[] = [];
	const seen = new Set<string>();
	const patterns: Array<[RegExp, string]> = [
		[/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "function"],
		[/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, "function"],
		[/\bclass\s+([A-Za-z_$][\w$]*)/, "class"],
		[/\binterface\s+([A-Za-z_$][\w$]*)/, "interface"],
		[/\b(?:type|typedef)\s+([A-Za-z_$][\w$]*)/, "type"],
		[/\b(?:enum)\s+([A-Za-z_$][\w$]*)/, "enum"],
		[/\b(?:struct)\s+([A-Za-z_$][\w$]*)/, "struct"],
		[/\b(?:trait)\s+([A-Za-z_$][\w$]*)/, "trait"],
		[/\bfn\s+([A-Za-z_][\w]*)\s*\(/, "function"],
		[/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/, "function"],
		[/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "value"],
	];

	for (const line of code.split("\n")) {
		for (const [pattern, type] of patterns) {
			const match = line.match(pattern);
			const name = match?.[1];
			if (!name || seen.has(name)) continue;
			seen.add(name);
			declarations.push({ type, name });
			break;
		}
	}
	return declarations;
}

function describeSourceBlock(
	code: string,
	language: string | undefined,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] | null {
	const declarations = sourceDeclarations(code).slice(0, 6);
	if (declarations.length === 0) return null;

	const output = [
		segment("prose", `The ${languageName(language)} block defines `),
	];
	declarations.forEach((declaration, index) => {
		if (index > 0) {
			output.push(
				segment("prose", index === declarations.length - 1 ? ", and " : ", "),
			);
		}
		output.push(segment("prose", `${declaration.type} `));
		output.push(segment("inlineCode", declaration.name, language));
	});
	output.push(segment("prose", "."));

	const total = sourceDeclarations(code).length;
	if (total > declarations.length) {
		output.push(
			segment(
				"prose",
				` ${total - declarations.length} more declarations omitted.`,
			),
		);
	}
	if (
		output.map((part) => part.text).join("").length > profile.limits.maxChars
	) {
		return output.slice(0, 3);
	}
	return output;
}

function describeJsonBlock(
	code: string,
	language: string | undefined,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] | null {
	try {
		const value = JSON.parse(code) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const keys = Object.keys(value as Record<string, unknown>);
			const shown = keys.slice(
				0,
				Math.min(keys.length, profile.limits.maxLines),
			);
			const output = [segment("prose", "JSON object with top-level keys: ")];
			if (shown.length === 0)
				return [segment("codeBlock", "Empty JSON object.", language)];
			appendList(output, shown, "inlineCode", language ?? "json");
			output.push(segment("prose", "."));
			if (keys.length > shown.length) {
				output.push(
					segment("prose", ` ${keys.length - shown.length} more keys omitted.`),
				);
			}
			return output;
		}
		if (Array.isArray(value)) {
			const output = [
				segment(
					"prose",
					`JSON array with ${value.length} item${value.length === 1 ? "" : "s"}.`,
				),
			];
			const first = value[0];
			if (first && typeof first === "object" && !Array.isArray(first)) {
				const keys = Object.keys(first as Record<string, unknown>).slice(
					0,
					profile.limits.maxLines,
				);
				if (keys.length > 0) {
					output.push(segment("prose", " First item keys: "));
					appendList(output, keys, "inlineCode", language ?? "json");
					output.push(segment("prose", "."));
				}
			}
			return output;
		}
		return [segment("codeBlock", `JSON value: ${String(value)}.`, language)];
	} catch {
		return null;
	}
}

function diffFiles(code: string): string[] {
	const files = new Set<string>();
	for (const line of code.split("\n")) {
		const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (gitHeader?.[2]) files.add(gitHeader[2]);
		const fileHeader = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
		if (fileHeader?.[1] && fileHeader[1] !== "/dev/null")
			files.add(fileHeader[1]);
	}
	return [...files];
}

function describeDiffBlock(
	code: string,
	language: string | undefined,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] | null {
	const files = diffFiles(code);
	if (files.length === 0) return null;
	const additions = code
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
	const removals = code
		.split("\n")
		.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
	const shown = files.slice(0, profile.limits.maxLines);
	const output = [
		segment(
			"prose",
			`Diff changes ${files.length} file${files.length === 1 ? "" : "s"}: `,
		),
	];
	appendList(output, shown, "path", language ?? "diff");
	output.push(
		segment(
			"prose",
			`. ${additions} addition${additions === 1 ? "" : "s"} and ${removals} removal${removals === 1 ? "" : "s"}.`,
		),
	);
	if (files.length > shown.length) {
		output.push(
			segment("prose", ` ${files.length - shown.length} more files omitted.`),
		);
	}
	return output;
}

function describeUnknownBlock(
	code: string,
	language: string | undefined,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] {
	const lines = usefulLines(code);
	if (lines.length === 0) {
		return [
			segment("codeBlock", `Empty ${languageName(language)} block.`, language),
		];
	}

	const shown: string[] = [];
	let chars = 0;
	const maxLines = Math.min(3, profile.limits.maxLines);
	for (const line of lines) {
		const excerpt = truncate(line, Math.min(180, profile.limits.maxChars));
		if (
			shown.length >= maxLines ||
			chars + excerpt.length > profile.limits.maxChars
		)
			break;
		shown.push(excerpt);
		chars += excerpt.length;
	}
	const omitted = lines.length - shown.length;
	const suffix =
		omitted > 0
			? ` ${omitted} more line${omitted === 1 ? "" : "s"} omitted.`
			: "";
	return [
		segment(
			"codeBlock",
			`${languageName(language)} block starts with: ${shown.join("; ")}.${suffix}`,
			language,
		),
	];
}

function describeCodeBlock(
	code: string,
	language: string | undefined,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] {
	const normalizedLanguage = language?.toLowerCase();
	if (isShellLanguage(normalizedLanguage)) {
		return describeShellBlock(code, normalizedLanguage, profile);
	}
	if (normalizedLanguage === "json" || normalizedLanguage === "jsonc") {
		return (
			describeJsonBlock(code, normalizedLanguage, profile) ??
			describeUnknownBlock(code, normalizedLanguage, profile)
		);
	}
	if (normalizedLanguage === "diff" || normalizedLanguage === "patch") {
		return (
			describeDiffBlock(code, normalizedLanguage, profile) ??
			describeUnknownBlock(code, normalizedLanguage, profile)
		);
	}
	return (
		describeSourceBlock(code, normalizedLanguage, profile) ??
		describeUnknownBlock(code, normalizedLanguage, profile)
	);
}

function isLongCodeBlock(code: string, profile: ResolvedSpeechProfile): boolean {
	return (
		usefulLines(code).length > profile.code.shortMaxLines ||
		code.length > profile.code.shortMaxChars
	);
}

export function codeSummaryTargets(
	input: string,
	profileConfig: SpeechProfileConfig = {},
): CodeSummaryTarget[] {
	const profile = resolveSpeechProfile(profileConfig);
	if (profile.code.longMode !== "llm") return [];
	let id = 0;
	const targets: CodeSummaryTarget[] = [];
	for (const item of segmentSpeechText(input)) {
		if (item.kind !== "codeBlock") continue;
		const targetId = id++;
		if (!isLongCodeBlock(item.text, profile)) continue;
		targets.push({
			id: targetId,
			...(item.language ? { language: item.language } : {}),
			text: item.text,
		});
	}
	return targets;
}

export function shouldSummarizeToolOutput(
	input: string,
	profileConfig: SpeechProfileConfig = {},
): boolean {
	const profile = resolveSpeechProfile(profileConfig);
	if (profile.toolOutput.longMode !== "llm") return false;
	return (
		toolLines(input).length > profile.limits.maxLines ||
		input.length > profile.limits.maxChars
	);
}

function argumentString(
	args: Record<string, unknown>,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (
			Array.isArray(value) &&
			value.every((item) => typeof item === "string")
		) {
			return value.join(" ");
		}
	}
	return undefined;
}

function argumentNumber(
	args: Record<string, unknown>,
	...names: string[]
): number | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	}
	return undefined;
}

function collapseRepeatedLines(lines: string[]): string[] {
	const output: string[] = [];
	for (let index = 0; index < lines.length; ) {
		let end = index + 1;
		while (end < lines.length && lines[end] === lines[index]) end++;
		const count = end - index;
		output.push(
			count > 1 ? `${lines[index]} (repeated ${count} times)` : lines[index],
		);
		index = end;
	}
	return output;
}

function toolLines(text: string): string[] {
	return collapseRepeatedLines(
		stripControlCharacters(text.replace(ANSI_PATTERN, ""))
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean),
	);
}

interface BoundedLines {
	values: string[];
	omitted: number;
}

function boundHeadTail(
	lines: string[],
	headLines: number,
	tailLines: number,
	maxChars: number,
): BoundedLines {
	const indexes =
		lines.length <= headLines + tailLines
			? lines.map((_, index) => index)
			: [
					...lines.slice(0, headLines).map((_, index) => index),
					...lines
						.slice(-tailLines)
						.map((_, index) => lines.length - tailLines + index),
				];
	const values: string[] = [];
	let chars = 0;
	for (const index of indexes) {
		const value = truncate(lines[index] ?? "", Math.min(240, maxChars));
		if (!value || chars + value.length > maxChars) break;
		values.push(value);
		chars += value.length;
	}
	return { values, omitted: Math.max(0, lines.length - values.length) };
}

function excerptText(excerpt: BoundedLines): string {
	if (excerpt.values.length === 0) return "no output";
	const omitted = excerpt.omitted
		? `; ${excerpt.omitted} line${excerpt.omitted === 1 ? "" : "s"} omitted`
		: "";
	return `${excerpt.values.join("; ")}${omitted}`;
}

function describeBashOutput(
	text: string,
	args: Record<string, unknown>,
	isError: boolean,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] {
	const command = argumentString(args, "command", "cmd");
	const output = [segment("prose", command ? "Bash command " : "Bash ")];
	if (command)
		output.push(
			segment(
				"command",
				truncate(command, profile.code.shortMaxChars),
				"shell",
			),
		);
	output.push(segment("prose", isError ? " failed." : " succeeded."));

	const lines = toolLines(text);
	if (lines.length === 0) {
		output.push(segment("prose", " No output."));
		return output;
	}
	const excerpt = isError
		? boundHeadTail(
				lines,
				profile.toolOutput.headLines,
				profile.toolOutput.tailLines,
				profile.limits.maxChars,
			)
		: boundHeadTail(
				lines,
				0,
				profile.toolOutput.tailLines,
				profile.limits.maxChars,
			);
	output.push(segment("prose", isError ? " Error output: " : " Output: "));
	output.push(segment(isError ? "error" : "prose", excerptText(excerpt)));
	output.push(segment("prose", "."));
	return output;
}

function languageFromPath(path: string | undefined): string | undefined {
	const extension = path?.match(/\.([A-Za-z\d]+)$/)?.[1]?.toLowerCase();
	const languages: Record<string, string> = {
		bash: "bash",
		c: "c",
		cpp: "cpp",
		cs: "cs",
		go: "go",
		java: "java",
		js: "js",
		json: "json",
		jsx: "jsx",
		py: "python",
		rb: "rb",
		rs: "rust",
		sh: "sh",
		ts: "ts",
		tsx: "tsx",
		yaml: "yaml",
		yml: "yaml",
	};
	return extension ? (languages[extension] ?? extension) : undefined;
}

function describeReadOutput(
	text: string,
	args: Record<string, unknown>,
	isError: boolean,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] {
	const path =
		argumentString(args, "filePath", "file_path", "path") ?? "a file";
	const output = [segment("prose", "Read "), segment("path", path)];
	const offset = argumentNumber(args, "offset", "startLine", "start_line");
	const limit = argumentNumber(args, "limit");
	if (offset !== undefined) {
		output.push(
			segment(
				"prose",
				limit !== undefined
					? `, lines ${offset} through ${Math.max(offset, offset + limit - 1)}`
					: `, starting at line ${offset}`,
			),
		);
	}
	output.push(segment("prose", isError ? " failed. Error: " : ". "));
	if (isError) {
		const excerpt = boundHeadTail(
			toolLines(text),
			profile.toolOutput.headLines,
			profile.toolOutput.tailLines,
			profile.limits.maxChars,
		);
		output.push(segment("error", excerptText(excerpt)), segment("prose", "."));
		return output;
	}

	const content = text.replace(/^\s*\d+:\s?/gm, "");
	const language = languageFromPath(path);
	const outline = describeCodeBlock(content, language, profile);
	output.push(...outline);
	return output;
}

function parseGrepLine(line: string): {
	path?: string;
	line?: string;
	content: string;
} {
	const match = line.match(/^(.+?):(\d+):(.*)$/);
	if (!match) return { content: line };
	return { path: match[1], line: match[2], content: match[3]?.trim() ?? "" };
}

function describeGrepOutput(
	text: string,
	args: Record<string, unknown>,
	isError: boolean,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] {
	const pattern = argumentString(args, "pattern", "query");
	const lines = toolLines(text);
	if (isError) {
		return describeGenericTool(
			"grep",
			text,
			isError,
			profile,
			pattern ? ` for ${pattern}` : "",
		);
	}

	const reportedCount = lines
		.map((line) => line.match(/(?:found\s+)?(\d+)\s+matches?/i)?.[1])
		.find(Boolean);
	const results = lines.filter(
		(line) => !/(?:found\s+)?\d+\s+matches?/i.test(line),
	);
	const parsed = results.map(parseGrepLine);
	const files = new Set(
		parsed
			.map((result) => result.path)
			.filter((path): path is string => !!path),
	);
	const count = reportedCount ? Number(reportedCount) : results.length;
	const output = [
		segment(
			"prose",
			count === 0
				? "Grep found no matches"
				: `Grep found ${count} match${count === 1 ? "" : "es"}${files.size ? ` in ${files.size} file${files.size === 1 ? "" : "s"}` : ""}`,
		),
	];
	if (pattern) {
		output.push(segment("prose", " for "), segment("inlineCode", pattern));
	}
	output.push(segment("prose", "."));

	const examples = parsed.slice(0, Math.min(3, profile.toolOutput.headLines));
	if (examples.length > 0) {
		output.push(segment("prose", " Examples: "));
		examples.forEach((example, index) => {
			if (index > 0) output.push(segment("prose", "; "));
			if (example.path) {
				output.push(segment("path", example.path));
				if (example.line)
					output.push(segment("prose", ` line ${example.line}`));
				output.push(segment("prose", ", "));
			}
			output.push(segment("prose", truncate(example.content, 180)));
		});
		output.push(segment("prose", "."));
	}
	return output;
}

function describePathList(
	tool: "find" | "ls",
	text: string,
	isError: boolean,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] {
	if (isError) return describeGenericTool(tool, text, true, profile);
	const paths = toolLines(text).filter((line) => !/^total\s+\d+$/i.test(line));
	if (paths.length === 0)
		return [segment("prose", `${tool} returned no results.`)];
	const shown = paths.slice(0, profile.toolOutput.headLines);
	const output = [
		segment(
			"prose",
			`${tool} returned ${paths.length} result${paths.length === 1 ? "" : "s"}. Examples: `,
		),
	];
	appendList(output, shown, "path");
	output.push(segment("prose", "."));
	if (paths.length > shown.length) {
		output.push(
			segment("prose", ` ${paths.length - shown.length} more results omitted.`),
		);
	}
	return output;
}

function describeGenericTool(
	tool: string,
	text: string,
	isError: boolean,
	profile: ResolvedSpeechProfile,
	qualifier = "",
): SpeechSegment[] {
	const lines = toolLines(text);
	const excerpt = boundHeadTail(
		lines,
		profile.toolOutput.headLines,
		profile.toolOutput.tailLines,
		profile.limits.maxChars,
	);
	return [
		segment(
			isError ? "error" : "prose",
			`Tool ${tool}${qualifier} ${isError ? "failed" : "returned"}: ${excerptText(excerpt)}.`,
		),
	];
}

function describeToolOutput(
	text: string,
	context: SpeechContext,
	args: Record<string, unknown>,
	isError: boolean,
	profile: ResolvedSpeechProfile,
): SpeechSegment[] {
	const rawTool = context.tool?.trim() || "tool";
	const tool =
		rawTool
			.toLowerCase()
			.split(/[\\/:.]/)
			.at(-1) ?? rawTool.toLowerCase();
	if (["bash", "shell", "sh"].includes(tool)) {
		return describeBashOutput(text, args, isError, profile);
	}
	if (tool === "read") return describeReadOutput(text, args, isError, profile);
	if (tool === "grep") return describeGrepOutput(text, args, isError, profile);
	if (tool === "find" || tool === "ls")
		return describePathList(tool, text, isError, profile);
	return describeGenericTool(rawTool, text, isError, profile);
}

function cleanProse(text: string): string {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/^\s*[-*_]{3,}\s*$/gm, "")
		.replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/gm, "")
		.replace(/^\s*\d+[.)]\s+/gm, "")
		.replace(/~~([^\n]+?)~~/g, "$1")
		.replace(/(\*\*\*|___)([^\n]+?)\1/g, "$2")
		.replace(/(\*\*|__)([^\n]+?)\1/g, "$2")
		.replace(/\*([^\n]+?)\*/g, "$1")
		.replace(/(^|[\s([{])_([^_\n]+?)_($|[\s)\]},.!?;:])/g, "$1$2$3")
		.replace(/<([a-z][a-z\d+.-]*:\/\/[^>]+)>/gi, "$1")
		.replace(/<\/?[a-z][a-z\d-]*(?:\s[^>]*)?>/gi, "")
		.replace(/[*`]+/g, "")
		.replace(/_{2,}/g, "")
		.replace(/[ \t]+/g, " ");
}

function cleanTechnicalText(text: string): string {
	return stripControlCharacters(text.replace(ANSI_PATTERN, ""))
		.replace(/[ \t\n]+/g, " ")
		.trim();
}

function spokenNumber(value: number): string {
	if (Number.isInteger(value)) return String(value);
	return String(Math.round(value * 10) / 10);
}

function formatBytes(bytes: number): string {
	const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
	if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const rounded = Math.round(value * 10) / 10;
	return `${spokenNumber(rounded)} ${units[unit]}${rounded === 1 ? "" : "s"}`;
}

function normalizeByteCounts(text: string): string {
	const expandedUnits = text.replace(
		/\b(\d+(?:\.\d+)?)\s*(KiB|KB|MiB|MB|GiB|GB|TiB|TB)\b/gi,
		(_match, rawValue: string, rawUnit: string) => {
			const unit = rawUnit.toLowerCase();
			const names: Record<string, string> = {
				gib: "gigabyte",
				gb: "gigabyte",
				kib: "kilobyte",
				kb: "kilobyte",
				mib: "megabyte",
				mb: "megabyte",
				tib: "terabyte",
				tb: "terabyte",
			};
			const value = Number(rawValue);
			const name = names[unit] ?? "byte";
			return `${spokenNumber(value)} ${name}${value === 1 ? "" : "s"}`;
		},
	);
	return expandedUnits.replace(
		/\b(\d[\d,_]*)\s*(?:bytes?|B)\b/g,
		(_match, rawValue: string) =>
			formatBytes(Number(rawValue.replace(/[,_]/g, ""))),
	);
}

function opaquePreview(
	value: string,
	prefixLength = 6,
	suffixLength = 4,
): string {
	if (value.length <= prefixLength + suffixLength + 3) return value;
	return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
}

function isOpaqueValue(value: string): boolean {
	if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
		return true;
	}
	if (/^(?:0x)?[0-9a-f]{24,}$/i.test(value)) return true;
	if (/^[A-Za-z\d+/]{22,}={0,2}$/.test(value) && value.length % 4 === 0) {
		const categories = [/[a-z]/, /[A-Z]/, /\d/, /[+/=]/].filter((pattern) =>
			pattern.test(value),
		);
		return categories.length >= 3;
	}
	return false;
}

function normalizeOpaqueValues(text: string): string {
	let output = text.replace(
		/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,
		(value) => `UUID ${opaquePreview(value, 8, 4)}`,
	);
	output = output.replace(/\b(?:0x)?[0-9a-f]{24,}\b/gi, (value) => {
		return `hex value ${opaquePreview(value)}`;
	});
	return output.replace(
		/[A-Za-z\d+/]{22,}={0,2}/g,
		(value, offset: number, source: string) => {
			const before = offset > 0 ? source[offset - 1] : undefined;
			const after = source[offset + value.length];
			if (
				(before && /[A-Za-z\d+/=]/.test(before)) ||
				(after && /[A-Za-z\d+/=]/.test(after))
			) {
				return value;
			}
			if (!isOpaqueValue(value)) return value;
			return `base64 value ${opaquePreview(value)}`;
		},
	);
}

export function normalizeTechnicalTokens(text: string): string {
	return normalizeOpaqueValues(normalizeByteCounts(text));
}

function scopeValues<T extends string>(
	value: ScopeValue<T> | undefined,
): readonly T[] | undefined {
	if (value === undefined) return undefined;
	return Array.isArray(value) ? value : [value as T];
}

function equalsInsensitive(
	values: readonly string[],
	value: string | undefined,
): boolean {
	if (value === undefined) return false;
	const normalized = value.toLowerCase();
	return values.some((candidate) => candidate.toLowerCase() === normalized);
}

function ruleMatchesScope(
	rule: PronunciationRule,
	context: SpeechContext,
	kind: SpeechSegmentKind,
	language: string | undefined,
): boolean {
	const scope = rule.scope;
	if (!scope) return true;
	const sources = scopeValues(scope.source);
	const events = scopeValues(scope.event);
	if (sources && !sources.includes(context.source)) return false;
	if (events && (!context.event || !events.includes(context.event)))
		return false;
	if (scope.roles && (!context.role || !scope.roles.includes(context.role)))
		return false;
	if (scope.kinds && !scope.kinds.includes(kind)) return false;
	if (scope.tools && !equalsInsensitive(scope.tools, context.tool))
		return false;
	if (
		scope.languages &&
		!equalsInsensitive(scope.languages, language ?? context.language)
	)
		return false;
	return true;
}

function tokenCharacter(value: string | undefined): boolean {
	return !!value && /[A-Za-z\d_]/.test(value);
}

function modeMatches(
	text: string,
	start: number,
	match: string,
	mode: PronunciationMode,
): boolean {
	const before = start > 0 ? text[start - 1] : undefined;
	const end = start + match.length;
	const after = end < text.length ? text[end] : undefined;
	if (mode === "literal") return true;
	if (mode === "word") return !tokenCharacter(before) && !tokenCharacter(after);
	if (mode === "prefix") return !tokenCharacter(before);
	if (mode === "suffix") return !tokenCharacter(after);
	return (
		(before === undefined || before === "/" || before === "\\") &&
		(after === undefined || after === "/" || after === "\\")
	);
}

interface PronunciationMatch {
	start: number;
	end: number;
	replacement: string;
	ruleIndex: number;
}

/** Applies scoped literal rules to one original string without replacement cascading. */
export function applyPronunciationRules(
	text: string,
	rules: readonly PronunciationRule[],
	context: SpeechContext = DEFAULT_CONTEXT,
	segmentContext: Pick<SpeechSegment, "kind" | "language"> = { kind: "prose" },
): string {
	const candidates: PronunciationMatch[] = [];
	rules.forEach((rule, ruleIndex) => {
		if (
			!rule ||
			typeof rule.match !== "string" ||
			!rule.match ||
			typeof rule.replace !== "string" ||
			!ruleMatchesScope(
				rule,
				context,
				segmentContext.kind,
				segmentContext.language,
			)
		) {
			return;
		}
		const mode = rule.mode ?? "word";
		if (!["word", "prefix", "suffix", "pathSegment", "literal"].includes(mode))
			return;
		let start = text.indexOf(rule.match);
		while (start >= 0) {
			if (modeMatches(text, start, rule.match, mode)) {
				candidates.push({
					start,
					end: start + rule.match.length,
					replacement: rule.replace,
					ruleIndex,
				});
			}
			start = text.indexOf(rule.match, start + 1);
		}
	});

	candidates.sort((left, right) => {
		const lengthDifference = right.end - right.start - (left.end - left.start);
		return (
			lengthDifference ||
			left.ruleIndex - right.ruleIndex ||
			left.start - right.start
		);
	});
	const selected: PronunciationMatch[] = [];
	for (const candidate of candidates) {
		if (
			selected.some(
				(match) => candidate.start < match.end && candidate.end > match.start,
			)
		) {
			continue;
		}
		selected.push(candidate);
	}
	selected.sort((left, right) => left.start - right.start);

	let output = "";
	let cursor = 0;
	for (const match of selected) {
		output += text.slice(cursor, match.start);
		output += match.replacement;
		cursor = match.end;
	}
	return output + text.slice(cursor);
}

function pronunciationRules(
	pronunciations: PronunciationFile | readonly PronunciationRule[] | undefined,
): readonly PronunciationRule[] {
	if (!pronunciations) return [];
	return Array.isArray(pronunciations)
		? pronunciations
		: ((pronunciations as PronunciationFile).rules ?? []);
}

function transformMarkdownSegments(
	segments: SpeechSegment[],
	profile: ResolvedSpeechProfile,
	codeSummaries: Readonly<Record<number, string>> = {},
): SpeechSegment[] {
	const output: SpeechSegment[] = [];
	let codeIndex = 0;
	for (const item of segments) {
		if (item.kind !== "codeBlock") {
			output.push(item);
			continue;
		}
		const summary = codeSummaries[codeIndex++]?.trim();
		if (summary) {
			output.push(
				segment("prose", `The ${languageName(item.language)} block: ${summary}`),
			);
		} else {
			output.push(...describeCodeBlock(item.text, item.language, profile));
		}
		output.push(segment("prose", "\n"));
	}
	return output;
}

function finishSpeechText(text: string): string {
	return text
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function prepareSpeechText(
	input: string,
	options: PrepareSpeechTextOptions = {},
): string {
	const text = String(input ?? "");
	if (!text.trim()) return "";
	const context = options.context ?? DEFAULT_CONTEXT;
	const profile = resolveSpeechProfile(options.profile);
	const rules = pronunciationRules(options.pronunciations);
	const isToolOutput = !!context.tool || context.role === "toolResult";
	const initial = options.toolSummary?.trim()
		? [segment(options.isError ? "error" : "prose", options.toolSummary.trim())]
		: isToolOutput
			? describeToolOutput(
				text,
				context,
				options.toolArgs ?? {},
				options.isError ?? false,
				profile,
				)
			: transformMarkdownSegments(
					segmentSpeechText(text),
					profile,
					options.codeSummaries,
				);

	const prepared = initial.map((item) => {
		const cleaned =
			item.kind === "prose"
				? cleanProse(item.text)
				: cleanTechnicalText(item.text);
		const normalized = normalizeTechnicalTokens(cleaned);
		const pronounced = applyPronunciationRules(
			normalized,
			rules,
			context,
			item,
		);
		return { ...item, text: pronounced };
	});
	return finishSpeechText(prepared.map((item) => item.text).join(""));
}
