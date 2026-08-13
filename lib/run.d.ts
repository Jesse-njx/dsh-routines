/**
 * routines-run — the child-side driver executed inside each one-shot run
 * subprocess. The scheduler replaces the `headless-runner` row with this
 * module in a generated `--patch` overlay, so a run drives one fresh Agent
 * (full session log = full audit, replay-able later by dsh-replay) and then
 * writes the run record: status, digest, session id, and auto-denied
 * permission requests.
 *
 * Resolution constraint: this module is imported by absolute path from
 * whatever profile the run boots, so it imports ONLY Node builtins at
 * runtime. Every capability arrives through injected services (`agents`,
 * `sessions`, `agentDefaultModel`, `llm`, `headlessStartup`); all
 * `@deepseek-ai` imports below are type-only and erased at build time.
 *
 * With no run context (no `runRecord` in config) it degrades to plain
 * headless behavior: drive the task, print the final assistant text, exit.
 *
 * @module @dsh-routines/bundle/run
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "routines-run";
/** Core services required before the one-shot turn can start. */
export declare const inject: string[];
/** Plugin config: the task plus the optional run-record context. */
export interface Config {
    /** The prompt text for the single run. */
    task: string;
    /** Absolute path of the run record JSON the scheduler opened. */
    runRecord?: string;
    /** Routine name, recorded with the digest. */
    routine?: string;
    /** Run id, recorded with the digest. */
    runId?: string;
    /** A last assistant message longer than this is summarized instead. */
    digestMaxChars?: number;
    /** Byte cap on the transcript handed to the summarizer. */
    summaryMaxChars?: number;
    /** Output-token cap for the summarizer call. */
    summaryMaxTokens?: number;
    /** End-to-end summarizer deadline in ms. */
    summaryTimeoutMs?: number;
}
/** Process-facing effects of one run; tests substitute captures. */
interface RunIo {
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
    exit(code: number): void;
}
/** The process streams the runner writes to; tests substitute captures. */
export declare const internals: Pick<RunIo, 'stdout' | 'stderr'>;
/**
 * Mount the one-shot run driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated run config.
 */
export declare function apply(ctx: Context, config: Config): void;
export {};
//# sourceMappingURL=run.d.ts.map