import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	highlightCode,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type AssistantSnippet,
	extractAssistantSnippets,
	type SnippetExtractionOptions,
} from "./snippets.ts";

type ShortcutAction = "show" | "next" | "previous" | "copy";
type ShortcutValue = string | string[];

interface SnippetsConfig extends SnippetExtractionOptions {
	shortcuts?: Partial<Record<ShortcutAction, ShortcutValue>>;
}

interface LoadedConfig {
	config: Required<SnippetExtractionOptions> & {
		shortcuts: Record<ShortcutAction, string[]>;
	};
	warning?: string;
}

const DEFAULT_SHORTCUTS: Record<ShortcutAction, string[]> = {
	show: ["ctrl+shift+b"],
	next: ["ctrl+shift+j"],
	previous: ["ctrl+shift+k"],
	copy: ["ctrl+shift+y"],
};

function shortcutValues(
	value: ShortcutValue | undefined,
	fallback: string[],
): string[] {
	const values =
		value === undefined ? fallback : Array.isArray(value) ? value : [value];
	return [
		...new Set(
			values
				.filter((item) => typeof item === "string" && item.trim())
				.map((item) => item.trim()),
		),
	];
}

function loadConfig(): LoadedConfig {
	const configPath = join(getAgentDir(), "snippets.json");
	let parsed: SnippetsConfig = {};
	let warning: string | undefined;

	if (existsSync(configPath)) {
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf8")) as SnippetsConfig;
		} catch (error) {
			warning = `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	return {
		config: {
			includeFenced: parsed.includeFenced !== false,
			includeInline: parsed.includeInline !== false,
			shortcuts: {
				show: shortcutValues(parsed.shortcuts?.show, DEFAULT_SHORTCUTS.show),
				next: shortcutValues(parsed.shortcuts?.next, DEFAULT_SHORTCUTS.next),
				previous: shortcutValues(
					parsed.shortcuts?.previous,
					DEFAULT_SHORTCUTS.previous,
				),
				copy: shortcutValues(parsed.shortcuts?.copy, DEFAULT_SHORTCUTS.copy),
			},
		},
		warning,
	};
}

function padAnsi(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function snippetLabel(snippet: AssistantSnippet): string {
	if (snippet.kind === "inline") return "inline";
	return snippet.language ? `fenced ${snippet.language}` : "fenced code";
}

class SnippetViewer {
	private selectedIndex: number;
	private scrollOffset = 0;
	private pageSize = 1;
	private renderedLineCount = 1;
	private status = "";

	constructor(
		private readonly snippets: AssistantSnippet[],
		selectedIndex: number,
		private readonly theme: Theme,
		private readonly terminalRows: () => number,
		private readonly requestRender: () => void,
		private readonly onSelect: (snippet: AssistantSnippet) => void,
		private readonly onClose: () => void,
		private readonly onCopy: (snippet: AssistantSnippet) => Promise<void>,
	) {
		this.selectedIndex = selectedIndex;
		this.onSelect(this.current());
	}

	private current(): AssistantSnippet {
		const snippet = this.snippets[this.selectedIndex];
		if (!snippet) throw new Error("Snippet selection is out of bounds");
		return snippet;
	}

	private select(delta: number): void {
		this.selectedIndex =
			(this.selectedIndex + delta + this.snippets.length) %
			this.snippets.length;
		this.scrollOffset = 0;
		this.status = "";
		this.onSelect(this.current());
		this.requestRender();
	}

	private selectEdge(index: number): void {
		this.selectedIndex = index;
		this.scrollOffset = 0;
		this.status = "";
		this.onSelect(this.current());
		this.requestRender();
	}

	private scroll(delta: number): void {
		const maxOffset = Math.max(0, this.renderedLineCount - this.pageSize);
		this.scrollOffset = Math.max(
			0,
			Math.min(maxOffset, this.scrollOffset + delta),
		);
		this.requestRender();
	}

	private copy(closeAfter: boolean): void {
		const snippet = this.current();
		void this.onCopy(snippet)
			.then(() => {
				if (closeAfter) {
					this.onClose();
					return;
				}
				this.status = "Copied to clipboard";
				this.requestRender();
			})
			.catch(() => {
				this.status = "Clipboard copy failed";
				this.requestRender();
			});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.onClose();
			return;
		}
		if (
			matchesKey(data, "down") ||
			matchesKey(data, "ctrl+shift+j") ||
			data === "j" ||
			data === "n" ||
			data === "]"
		) {
			this.select(1);
			return;
		}
		if (
			matchesKey(data, "up") ||
			matchesKey(data, "ctrl+shift+k") ||
			data === "k" ||
			data === "p" ||
			data === "["
		) {
			this.select(-1);
			return;
		}
		if (data === "g") {
			this.selectEdge(0);
			return;
		}
		if (data === "G") {
			this.selectEdge(this.snippets.length - 1);
			return;
		}
		if (
			matchesKey(data, "pageDown") ||
			matchesKey(data, "ctrl+d") ||
			data === " "
		) {
			this.scroll(this.pageSize);
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.scroll(-this.pageSize);
			return;
		}
		if (matchesKey(data, "home")) {
			this.scroll(-this.renderedLineCount);
			return;
		}
		if (matchesKey(data, "end")) {
			this.scroll(this.renderedLineCount);
			return;
		}
		if (
			data === "y" ||
			matchesKey(data, "ctrl+x") ||
			matchesKey(data, "ctrl+shift+y")
		) {
			this.copy(false);
			return;
		}
		if (matchesKey(data, "enter")) this.copy(true);
	}

	private codeLines(width: number): string[] {
		const snippet = this.current();
		const highlighted =
			snippet.kind === "fenced"
				? highlightCode(snippet.content, snippet.language)
				: [this.theme.fg("mdCode", snippet.content)];
		const wrapped = highlighted.flatMap((line) => {
			const result = wrapTextWithAnsi(line, width);
			return result.length > 0 ? result : [""];
		});
		return wrapped.length > 0
			? wrapped
			: [this.theme.fg("dim", "(empty block)")];
	}

	render(width: number): string[] {
		const safeWidth = Math.max(4, width);
		const innerWidth = safeWidth - 2;
		const snippet = this.current();
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content = "") =>
			`${border("│")}${padAnsi(content, innerWidth)}${border("│")}`;
		const divider = () => border(`├${"─".repeat(innerWidth)}┤`);
		const maxRows = Math.max(10, Math.floor(this.terminalRows() * 0.8));
		this.pageSize = Math.max(3, maxRows - 8);

		const code = this.codeLines(Math.max(1, innerWidth - 2));
		this.renderedLineCount = code.length;
		const maxOffset = Math.max(0, code.length - this.pageSize);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visibleCode = code.slice(
			this.scrollOffset,
			this.scrollOffset + this.pageSize,
		);
		const firstLine = code.length === 0 ? 0 : this.scrollOffset + 1;
		const lastLine = Math.min(code.length, this.scrollOffset + this.pageSize);
		const position = `${this.selectedIndex + 1}/${this.snippets.length}`;
		const source = `response ${snippet.responseIndex}/${snippet.responseCount}`;
		const lineRange = `${firstLine}-${lastLine}/${code.length}`;
		const context = snippet.context
			? this.theme.fg("muted", ` ${snippet.context}`)
			: this.theme.fg("dim", " No surrounding text");
		const status = this.status
			? this.theme.fg("success", this.status)
			: this.theme.fg(
					"dim",
					"j/k snippet  ·  PgUp/PgDn scroll  ·  y copy  ·  Enter copy+close  ·  q close",
				);

		return [
			border(`╭${"─".repeat(innerWidth)}╮`),
			row(
				` ${this.theme.fg("accent", this.theme.bold("Response snippets"))}  ${this.theme.fg("muted", `${position} · ${snippetLabel(snippet)} · ${source} · lines ${lineRange}`)}`,
			),
			row(context),
			divider(),
			...visibleCode.map((line) => row(` ${line}`)),
			divider(),
			row(` ${status}`),
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {}
}

export default function snippetsExtension(pi: ExtensionAPI): void {
	const loaded = loadConfig();
	let selectedSnippetId: string | undefined;
	let viewerOpen = false;

	function snippets(ctx: ExtensionContext): AssistantSnippet[] {
		return extractAssistantSnippets(ctx.sessionManager.getBranch(), {
			includeFenced: loaded.config.includeFenced,
			includeInline: loaded.config.includeInline,
		});
	}

	function selectedIndex(items: AssistantSnippet[]): number {
		const existing = selectedSnippetId
			? items.findIndex((snippet) => snippet.id === selectedSnippetId)
			: -1;
		return existing >= 0 ? existing : items.length - 1;
	}

	async function copySnippet(
		ctx: ExtensionContext,
		snippet: AssistantSnippet,
	): Promise<void> {
		try {
			await copyToClipboard(snippet.content);
			selectedSnippetId = snippet.id;
			ctx.ui.notify(
				`Copied ${snippetLabel(snippet)} from response ${snippet.responseIndex}`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				`Clipboard copy failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			throw error;
		}
	}

	async function showViewer(
		ctx: ExtensionContext,
		movement: "current" | "next" | "previous" = "current",
		explicitIndex?: number,
	): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Response snippets require interactive mode", "warning");
			return;
		}
		if (viewerOpen) return;

		const items = snippets(ctx);
		if (items.length === 0) {
			ctx.ui.notify(
				"No backtick-formatted snippets found on the current branch",
				"warning",
			);
			return;
		}

		let index = explicitIndex ?? selectedIndex(items);
		if (movement === "next" && selectedSnippetId)
			index = (index + 1) % items.length;
		if (movement === "previous" && selectedSnippetId)
			index = (index - 1 + items.length) % items.length;
		const selected = items[index];
		if (!selected) return;
		selectedSnippetId = selected.id;
		viewerOpen = true;

		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new SnippetViewer(
						items,
						index,
						theme,
						() => tui.terminal.rows,
						() => tui.requestRender(),
						(snippet) => {
							selectedSnippetId = snippet.id;
						},
						() => done(undefined),
						(snippet) => copySnippet(ctx, snippet),
					),
				{
					overlay: true,
					overlayOptions: {
						width: "88%",
						minWidth: 48,
						maxHeight: "80%",
						anchor: "center",
						margin: 1,
					},
				},
			);
		} finally {
			viewerOpen = false;
		}
	}

	async function copyCurrent(ctx: ExtensionContext): Promise<void> {
		const items = snippets(ctx);
		if (items.length === 0) {
			ctx.ui.notify(
				"No backtick-formatted snippets found on the current branch",
				"warning",
			);
			return;
		}
		const selected = items[selectedIndex(items)];
		if (selected) await copySnippet(ctx, selected);
	}

	pi.on("session_start", (_event, ctx) => {
		selectedSnippetId = undefined;
		if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
	});
	pi.on("session_tree", () => {
		selectedSnippetId = undefined;
	});

	pi.registerCommand("snippets", {
		description:
			"Browse and copy backtick-formatted snippets from assistant responses",
		getArgumentCompletions: (prefix) =>
			["next", "previous", "copy"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "copy") {
				await copyCurrent(ctx);
				return;
			}
			if (action === "next" || action === "previous") {
				await showViewer(ctx, action);
				return;
			}
			if (/^\d+$/.test(action)) {
				const items = snippets(ctx);
				const requested = Number(action) - 1;
				if (requested < 0 || requested >= items.length) {
					ctx.ui.notify(
						`Snippet number must be between 1 and ${items.length}`,
						"warning",
					);
					return;
				}
				await showViewer(ctx, "current", requested);
				return;
			}
			await showViewer(ctx);
		},
	});

	const handlers: Record<
		ShortcutAction,
		(ctx: ExtensionContext) => Promise<void>
	> = {
		show: (ctx) => showViewer(ctx),
		next: (ctx) => showViewer(ctx, "next"),
		previous: (ctx) => showViewer(ctx, "previous"),
		copy: (ctx) => copyCurrent(ctx),
	};
	const descriptions: Record<ShortcutAction, string> = {
		show: "Open response snippet navigator",
		next: "Show next response snippet",
		previous: "Show previous response snippet",
		copy: "Copy current response snippet",
	};

	for (const action of Object.keys(handlers) as ShortcutAction[]) {
		for (const shortcut of loaded.config.shortcuts[action]) {
			pi.registerShortcut(shortcut as KeyId, {
				description: descriptions[action],
				handler: handlers[action],
			});
		}
	}
}
