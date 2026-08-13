/**
 * scheduler — registers due routines on `ctx.jobs` and owns the boring
 * semantics: overlap policies, missed-run catch-up (at most once, never a
 * backlog replay), and hard timeouts via the jobs API.
 *
 * Each due routine launches a fresh headless run as its own job of kind
 * `routine` (visible in any jobs UI). The run subprocess boots
 * `dsh --profile <routine.profile> --patch <generated overlay> -- <prompt>`
 * with the routine's cwd as its workspace, the approval row forced to
 * `never` (unattended: anything that would prompt is auto-denied and noted
 * in the digest), and the `headless-runner` row replaced by
 * `@dsh-routines/bundle/run` so the subprocess writes the full run record.
 *
 * A fake clock, fake spawner, and manual ticks make the whole matrix
 * table-testable without real cron waits or subprocesses.
 *
 * @module @dsh-routines/bundle/scheduler
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { RunRecord, RoutinesSchedulerService, RoutinesService, RunTrigger } from './types.ts';
/** Stable Cordis plugin name. */
export declare const name = "routines-scheduler";
/** Services required before scheduling can start. */
export declare const inject: string[];
/** Plugin config with defaults applied by the loader. */
export interface Config {
    /** How often the scheduler checks for due routines. */
    tickIntervalMs?: number;
    /** Max routines launched in one tick (stampede guard on wake). */
    maxRunsPerTick?: number;
    /** Grace between SIGTERM and SIGKILL when stopping a wedged run. */
    killGraceMs?: number;
    /** The `dsh` binary (or entry script) used to launch runs. */
    dshBin?: string;
    /** Absolute path of the child-side run module the overlay replaces headless-runner with. */
    runModule?: string;
    /** Digest sizing the overlay embeds into each run. */
    digestMaxChars?: number;
    summaryMaxChars?: number;
    summaryMaxTokens?: number;
    summaryTimeoutMs?: number;
    /** Test seams: fake clock and fake spawner. */
    now?: () => number;
    spawn?: RunSpawner;
}
export declare const Config: z<Config>;
/** The dsh entry the operator is running under, or `dsh` on PATH. */
export declare function defaultDshBin(): string;
/** The exit of one spawned run subprocess. */
export interface SpawnExit {
    code: number | null;
    signal: NodeJS.Signals | null;
    /** Set when the process could not be spawned at all. */
    error?: string;
}
/** A spawned run subprocess, real or faked. */
export interface SpawnedRun {
    kill(signal: NodeJS.Signals): void;
    exit: Promise<SpawnExit>;
}
/** Everything the spawner needs to start one run. */
export interface RunSpawnSpec {
    bin: string;
    profile: string;
    patchPath: string;
    prompt: string;
    cwd: string;
    env: Record<string, string | undefined>;
}
export type RunSpawner = (spec: RunSpawnSpec) => SpawnedRun;
/** Spawn a run with the real `dsh` CLI, inheriting the operator's streams. */
export declare function realSpawn(spec: RunSpawnSpec): SpawnedRun;
/** The scheduler core. */
export declare class Scheduler implements RoutinesSchedulerService {
    private readonly inFlight;
    private readonly queued;
    private tickDisposer;
    private readonly doneDisposer;
    private readonly ctx;
    private readonly routines;
    private readonly config;
    constructor(ctx: Context, routines: RoutinesService, config: Required<Pick<Config, 'tickIntervalMs' | 'maxRunsPerTick' | 'killGraceMs' | 'dshBin' | 'runModule' | 'digestMaxChars' | 'summaryMaxChars' | 'summaryMaxTokens' | 'summaryTimeoutMs'>> & Pick<Config, 'now' | 'spawn'>);
    private now;
    /**
     * Start ticking. The first tick waits for the loader to settle: job
     * controllers (e.g. `dsh-tool-jobs`) attach during tree activation, and a
     * tick that raced them would fail every `ctx.jobs.start` it launched.
     */
    start(): void;
    /** Stop ticking (job runs already in flight continue). */
    stop(): void;
    /** One scheduling pass. */
    tick(): void;
    /** Launch one run (scheduled or manual). Returns the final record promise. */
    launch(name: string, trigger?: RunTrigger): Promise<RunRecord>;
    /** Cancel a running routine. Returns false when nothing was running. */
    cancel(name: string, reason?: string): boolean;
    /** Names of routines currently running. */
    running(): string[];
    /** Register the job and subprocess for one run. */
    private startRun;
    /** Await the child exit, finalize the record, and clean up the overlay. */
    private finalizeAfterExit;
    /** Fill any missing record fields, run deliveries, and persist. */
    private finalizeRun;
    /** Deliver the digest per the routine config. Delivery failures never crash the scheduler. */
    private deliver;
    /** Write a run record for an occurrence that was skipped by the overlap policy. */
    private recordSkipped;
    /** SIGTERM, then SIGKILL after the grace window. */
    private requestKill;
    /** After a job settles, release the slot and drain one queued occurrence. */
    private onJobDone;
    private routineNameOf;
    /** Write the generated `--patch` overlay that turns a plain headless run into a routine run. */
    private writeRunPatch;
}
/**
 * Mount the scheduler: tick immediately, then on the configured interval.
 * @param ctx - plugin context carrying the routines service, jobs registry, and timer.
 * @param config - validated scheduler configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=scheduler.d.ts.map