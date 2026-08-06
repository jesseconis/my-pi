export type QueueInterruptionPolicy = "continue" | "drop-pending" | "interrupt";

export type SpeechJobSource = "auto" | "tool" | "sample";

export type CancellingQueueInterruptionPolicy = Exclude<
	QueueInterruptionPolicy,
	"continue"
>;

export interface StaleGenerationCancellationReason {
	type: "stale-generation";
	generation: number;
	minimumGeneration: number;
	policy: CancellingQueueInterruptionPolicy;
}

export interface CancelAllCancellationReason {
	type: "cancel-all";
	detail?: string;
}

export interface AbortedCancellationReason {
	type: "aborted";
	error?: unknown;
}

export type SpeechCancellationReason =
	| StaleGenerationCancellationReason
	| CancelAllCancellationReason
	| AbortedCancellationReason;

export interface SpeechJobStatus {
	id: number;
	source: SpeechJobSource;
	generation: number;
	cancellable: boolean;
	cancellationRequested: boolean;
}

export interface SpeechSchedulerStatus {
	active: SpeechJobStatus | null;
	queued: readonly SpeechJobStatus[];
	isIdle: boolean;
	minimumGeneration: number | null;
	interruptionPolicy: QueueInterruptionPolicy;
}

interface SpeechJobResultBase {
	id: number;
	source: SpeechJobSource;
	generation: number;
}

export interface CompletedSpeechJobResult<T> extends SpeechJobResultBase {
	status: "completed";
	value: T;
}

export interface CancelledSpeechJobResult extends SpeechJobResultBase {
	status: "cancelled";
	reason: SpeechCancellationReason;
}

export interface FailedSpeechJobResult extends SpeechJobResultBase {
	status: "failed";
	error: unknown;
}

export type SpeechJobResult<T> =
	| CompletedSpeechJobResult<T>
	| CancelledSpeechJobResult
	| FailedSpeechJobResult;

export type SpeechJobCancellationOptions =
	| { cancellable: boolean; cancelOnUserInput?: never }
	| { cancelOnUserInput: boolean; cancellable?: never };

export type SpeechEnqueueOptions<T> = SpeechJobCancellationOptions & {
	source: SpeechJobSource;
	generation: number;
	run: (signal: AbortSignal) => Promise<T>;
};

export interface SpeechSchedulerOptions {
	onStateChange?: (status: SpeechSchedulerStatus) => void;
}

interface QueuedSpeechJob<T> {
	id: number;
	source: SpeechJobSource;
	generation: number;
	cancellable: boolean;
	run: (signal: AbortSignal) => Promise<T>;
	resolve: (result: SpeechJobResult<T>) => void;
	controller: AbortController | null;
	cancellationReason: SpeechCancellationReason | null;
	settled: boolean;
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "AbortError"
	);
}

export class SpeechScheduler<T = void> {
	private readonly onStateChange?: (status: SpeechSchedulerStatus) => void;
	private queue: Array<QueuedSpeechJob<T>> = [];
	private activeJob: QueuedSpeechJob<T> | null = null;
	private nextId = 0;
	private generationFloor: number | null = null;
	private policy: QueueInterruptionPolicy = "continue";
	private idleWaiters: Array<() => void> = [];

	constructor(options: SpeechSchedulerOptions = {}) {
		this.onStateChange = options.onStateChange;
	}

	get status(): SpeechSchedulerStatus {
		const active = this.activeJob ? this.jobStatus(this.activeJob) : null;
		const queued = this.queue.map((job) => this.jobStatus(job));
		return {
			active,
			queued,
			isIdle: active === null && queued.length === 0,
			minimumGeneration: this.generationFloor,
			interruptionPolicy: this.policy,
		};
	}

	get active(): SpeechJobStatus | null {
		return this.activeJob ? this.jobStatus(this.activeJob) : null;
	}

	get queued(): readonly SpeechJobStatus[] {
		return this.queue.map((job) => this.jobStatus(job));
	}

	whenIdle(): Promise<void> {
		if (this.status.isIdle) return Promise.resolve();
		return new Promise((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	enqueue(options: SpeechEnqueueOptions<T>): Promise<SpeechJobResult<T>> {
		const cancellable = options.cancellable ?? options.cancelOnUserInput;

		return new Promise((resolve) => {
			const job: QueuedSpeechJob<T> = {
				id: ++this.nextId,
				source: options.source,
				generation: options.generation,
				cancellable,
				run: options.run,
				resolve,
				controller: null,
				cancellationReason: null,
				settled: false,
			};

			if (this.shouldCancelStale(job)) {
				this.settle(job, this.cancelledResult(job, this.staleReason(job)));
				return;
			}

			this.queue.push(job);
			this.emitStateChange();
			this.drain();
		});
	}

	cancelBeforeGeneration(
		minimumGeneration: number,
		policy: QueueInterruptionPolicy,
	): number {
		if (!Number.isFinite(minimumGeneration)) {
			throw new RangeError("minimumGeneration must be a finite number");
		}

		this.generationFloor = Math.max(
			this.generationFloor ?? minimumGeneration,
			minimumGeneration,
		);
		this.policy = policy;

		let cancelled = 0;
		if (policy !== "continue") {
			const remaining: Array<QueuedSpeechJob<T>> = [];
			for (const job of this.queue) {
				if (job.cancellable && this.isStale(job)) {
					this.settle(job, this.cancelledResult(job, this.staleReason(job)));
					cancelled++;
				} else {
					remaining.push(job);
				}
			}
			this.queue = remaining;

			if (
				policy === "interrupt" &&
				this.activeJob?.cancellable &&
				this.isStale(this.activeJob) &&
				!this.activeJob.controller?.signal.aborted
			) {
				const reason = this.staleReason(this.activeJob);
				this.activeJob.cancellationReason = reason;
				this.activeJob.controller?.abort(reason);
				cancelled++;
			}
		}

		this.emitStateChange();
		return cancelled;
	}

	cancelAll(detail?: string): number {
		const reason: CancelAllCancellationReason = {
			type: "cancel-all",
			...(detail === undefined ? {} : { detail }),
		};
		let cancelled = 0;

		for (const job of this.queue) {
			this.settle(job, this.cancelledResult(job, reason));
			cancelled++;
		}
		this.queue = [];

		if (this.activeJob && !this.activeJob.controller?.signal.aborted) {
			this.activeJob.cancellationReason = reason;
			this.activeJob.controller?.abort(reason);
			cancelled++;
		}

		if (cancelled > 0) this.emitStateChange();
		return cancelled;
	}

	private drain(): void {
		if (this.activeJob) return;
		const job = this.queue.shift();
		if (!job) return;

		job.controller = new AbortController();
		this.activeJob = job;
		this.emitStateChange();
		void this.execute(job);
	}

	private async execute(job: QueuedSpeechJob<T>): Promise<void> {
		const signal = job.controller?.signal;
		let result: SpeechJobResult<T>;

		if (!signal || signal.aborted) {
			result = this.cancelledResult(
				job,
				job.cancellationReason ?? { type: "aborted" },
			);
		} else {
			try {
				const value = await job.run(signal);
				result = signal.aborted
					? this.cancelledResult(
							job,
							job.cancellationReason ?? { type: "aborted" },
						)
					: this.completedResult(job, value);
			} catch (error) {
				result =
					signal.aborted || isAbortError(error)
						? this.cancelledResult(
								job,
								job.cancellationReason ?? { type: "aborted", error },
							)
						: this.failedResult(job, error);
			}
		}

		if (this.activeJob === job) this.activeJob = null;
		this.settle(job, result);
		this.emitStateChange();
		this.drain();
	}

	private isStale(job: QueuedSpeechJob<T>): boolean {
		return (
			this.generationFloor !== null && job.generation < this.generationFloor
		);
	}

	private shouldCancelStale(job: QueuedSpeechJob<T>): boolean {
		return job.cancellable && this.policy !== "continue" && this.isStale(job);
	}

	private staleReason(
		job: QueuedSpeechJob<T>,
	): StaleGenerationCancellationReason {
		return {
			type: "stale-generation",
			generation: job.generation,
			minimumGeneration: this.generationFloor ?? job.generation,
			policy: this.policy as CancellingQueueInterruptionPolicy,
		};
	}

	private completedResult(
		job: QueuedSpeechJob<T>,
		value: T,
	): CompletedSpeechJobResult<T> {
		return {
			status: "completed",
			id: job.id,
			source: job.source,
			generation: job.generation,
			value,
		};
	}

	private cancelledResult(
		job: QueuedSpeechJob<T>,
		reason: SpeechCancellationReason,
	): CancelledSpeechJobResult {
		return {
			status: "cancelled",
			id: job.id,
			source: job.source,
			generation: job.generation,
			reason,
		};
	}

	private failedResult(
		job: QueuedSpeechJob<T>,
		error: unknown,
	): FailedSpeechJobResult {
		return {
			status: "failed",
			id: job.id,
			source: job.source,
			generation: job.generation,
			error,
		};
	}

	private settle(job: QueuedSpeechJob<T>, result: SpeechJobResult<T>): void {
		if (job.settled) return;
		job.settled = true;
		job.resolve(result);
	}

	private jobStatus(job: QueuedSpeechJob<T>): SpeechJobStatus {
		return {
			id: job.id,
			source: job.source,
			generation: job.generation,
			cancellable: job.cancellable,
			cancellationRequested: job.controller?.signal.aborted ?? false,
		};
	}

	private emitStateChange(): void {
		if (this.status.isIdle && this.idleWaiters.length > 0) {
			for (const resolve of this.idleWaiters.splice(0)) resolve();
		}
		try {
			this.onStateChange?.(this.status);
		} catch {
			// Observers must not poison the queue.
		}
	}
}
