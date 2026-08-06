import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type CancelledSpeechJobResult,
	type SpeechJobResult,
	SpeechScheduler,
	type SpeechSchedulerStatus,
} from "./speech-runtime.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function assertCancelled<T>(
	result: SpeechJobResult<T>,
	reasonType: CancelledSpeechJobResult["reason"]["type"],
): asserts result is CancelledSpeechJobResult {
	assert.equal(result.status, "cancelled");
	if (result.status !== "cancelled")
		assert.fail("Expected a cancelled speech job");
	assert.equal(result.reason.type, reasonType);
}

describe("SpeechScheduler", () => {
	it("runs exactly one job at a time in FIFO order and reports state", async () => {
		const schedulerStates: SpeechSchedulerStatus[] = [];
		const scheduler = new SpeechScheduler<string>({
			onStateChange(status) {
				schedulerStates.push(status);
			},
		});
		const controls = [
			deferred<string>(),
			deferred<string>(),
			deferred<string>(),
		];
		const starts: string[] = [];

		const jobs = ["first", "second", "third"].map((name, index) =>
			scheduler.enqueue({
				source: "tool",
				generation: 1,
				cancellable: true,
				run: () => {
					starts.push(name);
					return controls[index].promise;
				},
			}),
		);

		assert.deepEqual(starts, ["first"]);
		assert.equal(scheduler.active?.id, 1);
		assert.deepEqual(
			scheduler.queued.map((job) => job.id),
			[2, 3],
		);

		controls[0].resolve("one");
		assert.equal((await jobs[0]).status, "completed");
		assert.deepEqual(starts, ["first", "second"]);

		controls[1].resolve("two");
		assert.equal((await jobs[1]).status, "completed");
		assert.deepEqual(starts, ["first", "second", "third"]);

		controls[2].resolve("three");
		const third = await jobs[2];
		assert.equal(third.status, "completed");
		if (third.status === "completed") assert.equal(third.value, "three");
		assert.equal(scheduler.status.isIdle, true);
		assert.equal(schedulerStates.at(-1)?.isIdle, true);
	});

	it("continue preserves stale active and queued jobs in FIFO order", async () => {
		const scheduler = new SpeechScheduler<string>();
		const controls = [
			deferred<string>(),
			deferred<string>(),
			deferred<string>(),
		];
		const starts: number[] = [];
		const jobs = controls.map((control, index) =>
			scheduler.enqueue({
				source: "auto",
				generation: index < 2 ? 1 : 2,
				cancelOnUserInput: true,
				run: () => {
					starts.push(index);
					return control.promise;
				},
			}),
		);

		assert.equal(scheduler.cancelBeforeGeneration(2, "continue"), 0);
		assert.deepEqual(starts, [0]);
		assert.equal(scheduler.queued.length, 2);

		for (let index = 0; index < controls.length; index++) {
			controls[index].resolve(String(index));
			assert.equal((await jobs[index]).status, "completed");
		}
		assert.deepEqual(starts, [0, 1, 2]);
	});

	it("drop-pending cancels stale queued jobs but leaves the active job alone", async () => {
		const scheduler = new SpeechScheduler<string>();
		const activeControl = deferred<string>();
		let activeSignal: AbortSignal | undefined;
		const starts: string[] = [];

		const active = scheduler.enqueue({
			source: "auto",
			generation: 1,
			cancellable: true,
			run: (signal) => {
				activeSignal = signal;
				starts.push("active");
				return activeControl.promise;
			},
		});
		const stale = scheduler.enqueue({
			source: "auto",
			generation: 1,
			cancellable: true,
			run: () => {
				starts.push("stale");
				return Promise.resolve("stale");
			},
		});
		const current = scheduler.enqueue({
			source: "tool",
			generation: 2,
			cancellable: true,
			run: () => {
				starts.push("current");
				return Promise.resolve("current");
			},
		});

		assert.equal(scheduler.cancelBeforeGeneration(2, "drop-pending"), 1);
		assert.equal(activeSignal?.aborted, false);
		assert.deepEqual(starts, ["active"]);
		assertCancelled(await stale, "stale-generation");

		activeControl.resolve("active");
		assert.equal((await active).status, "completed");
		assert.equal((await current).status, "completed");
		assert.deepEqual(starts, ["active", "current"]);
	});

	it("interrupt aborts a stale active job without starting the next job early", async () => {
		const scheduler = new SpeechScheduler<string>();
		const activeControl = deferred<string>();
		const starts: string[] = [];
		let aborts = 0;

		const active = scheduler.enqueue({
			source: "auto",
			generation: 1,
			cancelOnUserInput: true,
			run: (signal) => {
				starts.push("active");
				signal.addEventListener("abort", () => aborts++);
				return activeControl.promise;
			},
		});
		const stale = scheduler.enqueue({
			source: "auto",
			generation: 1,
			cancelOnUserInput: true,
			run: () => {
				starts.push("stale");
				return Promise.resolve("stale");
			},
		});
		const current = scheduler.enqueue({
			source: "tool",
			generation: 2,
			cancelOnUserInput: true,
			run: () => {
				starts.push("current");
				return Promise.resolve("current");
			},
		});

		assert.equal(scheduler.cancelBeforeGeneration(2, "interrupt"), 2);
		assert.equal(aborts, 1);
		assert.equal(scheduler.active?.cancellationRequested, true);
		assert.deepEqual(starts, ["active"]);
		assertCancelled(await stale, "stale-generation");

		activeControl.resolve("ignored after abort");
		const activeResult = await active;
		assertCancelled(activeResult, "stale-generation");
		assert.deepEqual(starts, ["active", "current"]);
		assert.equal((await current).status, "completed");
	});

	it("preserves noncancellable stale sample jobs during interruption", async () => {
		const scheduler = new SpeechScheduler<string>();
		const activeControl = deferred<string>();
		const queuedSampleControl = deferred<string>();
		const starts: string[] = [];
		let activeSignal: AbortSignal | undefined;

		const activeSample = scheduler.enqueue({
			source: "sample",
			generation: 1,
			cancellable: false,
			run: (signal) => {
				activeSignal = signal;
				starts.push("active-sample");
				return activeControl.promise;
			},
		});
		const queuedSample = scheduler.enqueue({
			source: "sample",
			generation: 1,
			cancelOnUserInput: false,
			run: () => {
				starts.push("queued-sample");
				return queuedSampleControl.promise;
			},
		});
		const staleAuto = scheduler.enqueue({
			source: "auto",
			generation: 1,
			cancellable: true,
			run: () => {
				starts.push("stale-auto");
				return Promise.resolve("stale-auto");
			},
		});

		assert.equal(scheduler.cancelBeforeGeneration(2, "interrupt"), 1);
		assert.equal(activeSignal?.aborted, false);
		assertCancelled(await staleAuto, "stale-generation");

		activeControl.resolve("active-sample");
		assert.equal((await activeSample).status, "completed");
		assert.deepEqual(starts, ["active-sample", "queued-sample"]);

		queuedSampleControl.resolve("queued-sample");
		assert.equal((await queuedSample).status, "completed");
		assert.deepEqual(starts, ["active-sample", "queued-sample"]);
	});

	it("cancelAll settles queued jobs and aborts even a noncancellable active job", async () => {
		const scheduler = new SpeechScheduler<string>();
		const activeControl = deferred<string>();
		let activeSignal: AbortSignal | undefined;

		const active = scheduler.enqueue({
			source: "sample",
			generation: 1,
			cancellable: false,
			run: (signal) => {
				activeSignal = signal;
				return activeControl.promise;
			},
		});
		const queued = scheduler.enqueue({
			source: "tool",
			generation: 1,
			cancellable: false,
			run: () => Promise.resolve("should not run"),
		});

		assert.equal(scheduler.cancelAll("session cleanup"), 2);
		assert.equal(activeSignal?.aborted, true);
		const queuedResult = await queued;
		assertCancelled(queuedResult, "cancel-all");
		if (queuedResult.reason.type === "cancel-all") {
			assert.equal(queuedResult.reason.detail, "session cleanup");
		}
		assert.equal(scheduler.status.isIdle, false);
		let idleResolved = false;
		const idle = scheduler.whenIdle().then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		assert.equal(idleResolved, false);

		activeControl.resolve("ignored after cleanup");
		assertCancelled(await active, "cancel-all");
		await idle;
		assert.equal(scheduler.status.isIdle, true);
	});

	it("settles cancellation exactly once across repeated invalidation", async () => {
		const scheduler = new SpeechScheduler<string>();
		const activeControl = deferred<string>();
		let queuedRuns = 0;
		let settlements = 0;

		const active = scheduler.enqueue({
			source: "tool",
			generation: 2,
			cancellable: false,
			run: () => activeControl.promise,
		});
		const queued = scheduler.enqueue({
			source: "auto",
			generation: 1,
			cancellable: true,
			run: () => {
				queuedRuns++;
				return Promise.resolve("unexpected");
			},
		});
		void queued.then(() => settlements++);

		assert.equal(scheduler.cancelBeforeGeneration(2, "drop-pending"), 1);
		assert.equal(scheduler.cancelBeforeGeneration(2, "interrupt"), 0);
		assertCancelled(await queued, "stale-generation");
		await Promise.resolve();
		assert.equal(settlements, 1);
		assert.equal(queuedRuns, 0);

		activeControl.resolve("active");
		assert.equal((await active).status, "completed");
		assert.equal(settlements, 1);
	});

	it("treats AbortError as cancellation and continues with the next job", async () => {
		const scheduler = new SpeechScheduler<string>();
		const abortError = new Error("aborted");
		abortError.name = "AbortError";

		const aborted = scheduler.enqueue({
			source: "auto",
			generation: 1,
			cancellable: true,
			run: () => Promise.reject(abortError),
		});
		const next = scheduler.enqueue({
			source: "tool",
			generation: 1,
			cancellable: true,
			run: () => Promise.resolve("next"),
		});

		assertCancelled(await aborted, "aborted");
		const nextResult = await next;
		assert.equal(nextResult.status, "completed");
		if (nextResult.status === "completed")
			assert.equal(nextResult.value, "next");
	});

	it("returns ordinary failures without poisoning the queue", async () => {
		const scheduler = new SpeechScheduler<string>();
		const failure = new Error("synthesis failed");

		const failed = scheduler.enqueue({
			source: "auto",
			generation: 1,
			cancellable: true,
			run: () => Promise.reject(failure),
		});
		const next = scheduler.enqueue({
			source: "tool",
			generation: 1,
			cancellable: true,
			run: () => Promise.resolve("recovered"),
		});

		const failedResult = await failed;
		assert.equal(failedResult.status, "failed");
		if (failedResult.status === "failed")
			assert.equal(failedResult.error, failure);

		const nextResult = await next;
		assert.equal(nextResult.status, "completed");
		if (nextResult.status === "completed")
			assert.equal(nextResult.value, "recovered");
		assert.equal(scheduler.status.isIdle, true);
	});
});
