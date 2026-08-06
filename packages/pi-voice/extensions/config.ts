import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { InputSource } from "@earendil-works/pi-coding-agent";
import type { QueueInterruptionPolicy } from "./speech-runtime.ts";
import type {
	PronunciationFile,
	PronunciationMode,
	PronunciationRule,
	PronunciationScope,
	SpeechProfileConfig,
} from "./speech-text.ts";

export interface SpeechQueueConfig {
	onUserInput: QueueInterruptionPolicy;
	inputSources: InputSource[];
}

export interface SpeechProcessingConfig {
	defaultProfile: string;
	pronunciationFile?: string;
	profiles: Record<string, SpeechProfileConfig>;
}

export interface SpeechVoiceConfig {
	queue: SpeechQueueConfig;
	processing: SpeechProcessingConfig;
}

export const DEFAULT_SPEECH_CONFIG: SpeechVoiceConfig = {
	queue: {
		onUserInput: "continue",
		inputSources: ["interactive", "rpc"],
	},
	processing: {
		defaultProfile: "technical",
		profiles: {
			technical: { base: "technical" },
		},
	},
};

const QUEUE_POLICIES = new Set<QueueInterruptionPolicy>([
	"continue",
	"drop-pending",
	"interrupt",
]);
const INPUT_SOURCES = new Set<InputSource>(["interactive", "rpc", "extension"]);
const PRONUNCIATION_MODES = new Set<PronunciationMode>([
	"word",
	"prefix",
	"suffix",
	"pathSegment",
	"literal",
]);
const SPEECH_SOURCES = new Set(["auto", "tool", "sample"]);
const SPEECH_ROLES = new Set(["assistant", "user", "toolResult"]);
const SEGMENT_KINDS = new Set([
	"prose",
	"inlineCode",
	"codeBlock",
	"command",
	"path",
	"url",
	"error",
	"opaque",
]);
const PRONUNCIATION_SCOPE_KEYS = new Set([
	"source",
	"event",
	"roles",
	"kinds",
	"tools",
	"languages",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, allowed?: ReadonlySet<string>): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		return undefined;
	}
	const values = allowed ? value.filter((item) => allowed.has(item)) : value;
	return [...new Set(values)];
}

function optionalPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

function normalizeProfile(value: unknown): SpeechProfileConfig {
	if (!isRecord(value)) return { base: "technical" };
	const limits = isRecord(value.limits) ? value.limits : {};
	const code = isRecord(value.code) ? value.code : {};
	const toolOutput = isRecord(value.toolOutput) ? value.toolOutput : {};
	return {
		base: "technical",
		limits: {
			maxLines: optionalPositiveInteger(limits.maxLines),
			maxChars: optionalPositiveInteger(limits.maxChars),
		},
		code: {
			shortMaxLines: optionalPositiveInteger(code.shortMaxLines),
			shortMaxChars: optionalPositiveInteger(code.shortMaxChars),
			longMode: code.longMode === "llm" ? "llm" : "outline",
			fallback: "outline",
		},
		toolOutput: {
			headLines: optionalPositiveInteger(toolOutput.headLines),
			tailLines: optionalPositiveInteger(toolOutput.tailLines),
			longMode: toolOutput.longMode === "llm" ? "llm" : "bounded",
			fallback: "bounded",
		},
	};
}

export function normalizeSpeechConfig(value: unknown): SpeechVoiceConfig {
	const speech = isRecord(value) ? value : {};
	const queue = isRecord(speech.queue) ? speech.queue : {};
	const processing = isRecord(speech.processing) ? speech.processing : {};
	const rawProfiles = isRecord(processing.profiles) ? processing.profiles : {};
	const profiles = Object.fromEntries(
		Object.entries(rawProfiles).map(([name, profile]) => [name, normalizeProfile(profile)]),
	);
	if (!profiles.technical) profiles.technical = { base: "technical" };

	const policy = QUEUE_POLICIES.has(queue.onUserInput as QueueInterruptionPolicy)
		? (queue.onUserInput as QueueInterruptionPolicy)
		: DEFAULT_SPEECH_CONFIG.queue.onUserInput;
	const sources = stringArray(queue.inputSources, INPUT_SOURCES) as InputSource[] | undefined;
	const defaultProfile =
		typeof processing.defaultProfile === "string" && processing.defaultProfile.trim()
			? processing.defaultProfile.trim()
			: DEFAULT_SPEECH_CONFIG.processing.defaultProfile;

	return {
		queue: {
			onUserInput: policy,
			inputSources:
				sources !== undefined ? sources : [...DEFAULT_SPEECH_CONFIG.queue.inputSources],
		},
		processing: {
			defaultProfile,
			pronunciationFile:
				typeof processing.pronunciationFile === "string" &&
				processing.pronunciationFile.trim()
					? processing.pronunciationFile.trim()
					: undefined,
			profiles,
		},
	};
}

export function resolveConfiguredProfile(
	config: SpeechVoiceConfig | undefined,
	name?: string,
): SpeechProfileConfig {
	const speech = config ?? DEFAULT_SPEECH_CONFIG;
	const profileName = name?.trim() || speech.processing.defaultProfile;
	return speech.processing.profiles[profileName] ?? speech.processing.profiles.technical ?? {};
}

function strictScopeValues(
	value: unknown,
	allowSingle: boolean,
	allowed?: ReadonlySet<string>,
): string[] | undefined | null {
	if (value === undefined) return undefined;
	const values = allowSingle && typeof value === "string" ? [value] : value;
	if (!Array.isArray(values) || !values.every((item) => typeof item === "string")) {
		return null;
	}
	if (allowed && values.some((item) => !allowed.has(item))) return null;
	return [...new Set(values)];
}

function normalizeScope(value: unknown): PronunciationScope | null {
	if (!isRecord(value)) return null;
	if (Object.keys(value).some((key) => !PRONUNCIATION_SCOPE_KEYS.has(key))) return null;
	const sourceValues = strictScopeValues(value.source, true, SPEECH_SOURCES);
	const eventValues = strictScopeValues(value.event, true);
	const roles = strictScopeValues(value.roles, false, SPEECH_ROLES);
	const kinds = strictScopeValues(value.kinds, false, SEGMENT_KINDS);
	const tools = strictScopeValues(value.tools, false);
	const languages = strictScopeValues(value.languages, false);
	if ([sourceValues, eventValues, roles, kinds, tools, languages].includes(null)) return null;
	return {
		...(sourceValues !== undefined
			? {
					source: (sourceValues.length === 1
						? sourceValues[0]
						: sourceValues) as PronunciationScope["source"],
				}
			: {}),
		...(eventValues !== undefined
			? {
					event: (eventValues.length === 1
						? eventValues[0]
						: eventValues) as PronunciationScope["event"],
				}
			: {}),
		...(roles !== undefined ? { roles: roles as PronunciationScope["roles"] } : {}),
		...(kinds !== undefined ? { kinds: kinds as PronunciationScope["kinds"] } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(languages !== undefined ? { languages } : {}),
	};
}

function normalizeRule(value: unknown): PronunciationRule | null {
	if (!isRecord(value)) return null;
	if (typeof value.match !== "string" || !value.match) return null;
	if (typeof value.replace !== "string") return null;
	if (value.mode !== undefined && !PRONUNCIATION_MODES.has(value.mode as PronunciationMode)) {
		return null;
	}
	const mode = (value.mode as PronunciationMode | undefined) ?? "word";
	const scope = value.scope === undefined ? undefined : normalizeScope(value.scope);
	if (scope === null) return null;
	return {
		match: value.match,
		replace: value.replace,
		mode,
		...(scope ? { scope } : {}),
	};
}

export interface PronunciationLoadResult {
	file: PronunciationFile;
	path?: string;
	error?: string;
}

export function loadPronunciations(
	configDir: string,
	config: SpeechVoiceConfig | undefined,
	previous: PronunciationFile = { version: 1, rules: [] },
): PronunciationLoadResult {
	const configuredPath = config?.processing.pronunciationFile;
	if (!configuredPath) return { file: { version: 1, rules: [] } };
	const path = isAbsolute(configuredPath)
		? configuredPath
		: resolve(configDir, configuredPath);
	try {
		if (!existsSync(path)) {
			return { file: previous, path, error: `Pronunciation file not found: ${path}` };
		}
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.rules)) {
			throw new Error("Expected { version: 1, rules: [...] }");
		}
		const rules = raw.rules.map(normalizeRule);
		if (rules.some((rule) => rule === null)) {
			throw new Error("One or more pronunciation rules are invalid");
		}
		return { file: { version: 1, rules: rules as PronunciationRule[] }, path };
	} catch (error) {
		return {
			file: previous,
			path,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
