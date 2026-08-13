/**
 * dsh-routines — shared domain types.
 *
 * A routine is a named prompt + schedule + delivery stored as a YAML file
 * under `.dsh/routines/*.yaml` (project) or `~/.dsh/routines/*.yaml`
 * (global). Run records are JSON files under
 * `<routine.cwd>/.dsh/routines/runs/<runId>.json`.
 *
 * @module @dsh-routines/bundle/types
 */
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        /** One scheduled routine run, registered on `ctx.jobs` by the scheduler. */
        routine: 'routine';
    }
}
export {};
/** Where a routine definition came from. */
export type RoutineSource = 'project' | 'global';
/** Delivery channels a routine's digest is sent to after a run. */
export type DeliveryKind = 'file' | 'chatnode';
export interface Delivery {
    type: DeliveryKind;
}
/** Overlap policy when a routine is still running at its next due time. */
export type OverlapPolicy = 'skip' | 'queue' | 'cancel-previous';
/**
 * A validated, resolved routine. Defaults are applied at load time:
 * `timezone` defaults to `UTC` (never the host zone), `profile` to
 * `headless`, `overlap` to `skip`, `timeoutMin` to 45, `deliver` to
 * `[{ type: 'file' }]`, and `cwd` to the store's project directory.
 */
export interface Routine {
    /** Unique routine name: `[a-z0-9][a-z0-9-]*`, max 64 chars. */
    name: string;
    /** `0 2 * * *` (5-field cron), `@daily`, `@hourly`, or `every 4h`. */
    schedule: string;
    /** IANA timezone for schedule math, e.g. `Asia/Shanghai`. Never the host zone. */
    timezone: string;
    /** The prompt the headless run executes. */
    prompt: string;
    /** Resolved absolute working directory for the run. */
    cwd: string;
    /** DSH profile the run boots (`headless` by default). */
    profile: string;
    overlap: OverlapPolicy;
    /** Hard timeout in minutes; a wedged run is stopped at this bound. */
    timeoutMin: number;
    deliver: Delivery[];
    source: RoutineSource;
    /** Absolute path of the YAML file this routine was loaded from. */
    file: string;
    /** Whether the routine is paused (`dsh routines pause <name>`). */
    paused: boolean;
}
/** A routine file that failed to parse or validate. */
export interface InvalidRoutine {
    name: string;
    file: string;
    source: RoutineSource;
    error: string;
}
/**
 * Durable scheduler bookkeeping, persisted to
 * `<projectDir>/.dsh/routines/state.json`.
 */
export interface SchedulerState {
    /** Routine names paused by `dsh routines pause <name>`. */
    paused: string[];
    /** Wall-clock epoch ms of the last launch (or skip) per routine. */
    lastRunAt: Record<string, number>;
}
/** Terminal run status. `skipped` records an overlap-skip occurrence. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'skipped';
export type RunTrigger = 'schedule' | 'manual';
/** One permission request that was auto-denied during an unattended run. */
export interface DeniedApproval {
    toolName: string;
    reason?: string;
}
/** One delivery attempt for a finished run. */
export interface DeliveryResult {
    type: DeliveryKind;
    ok: boolean;
    error?: string;
}
/**
 * The full audit record of one run, persisted as JSON under
 * `<routine.cwd>/.dsh/routines/runs/<runId>.json`. The child run process
 * writes the run facts (status, digest, session id, denied approvals); the
 * scheduler fills anything missing and appends `deliveries`.
 */
export interface RunRecord {
    runId: string;
    routine: string;
    profile: string;
    cwd: string;
    status: RunStatus;
    trigger: RunTrigger;
    startedAt: number;
    finishedAt?: number;
    durationMs?: number;
    /** Subprocess exit code, when the run reached a process exit. */
    exitCode?: number;
    /** The run's one-shot session id (replay-able later by dsh-replay). */
    sessionId?: string;
    /** The digest: the last assistant message, or a summary of the session log. */
    digest?: string;
    /** Permission requests auto-denied under the unattended `never` policy. */
    denied?: DeniedApproval[];
    deliveries?: DeliveryResult[];
    /** Human-readable failure reason for non-completed runs. */
    error?: string;
}
/**
 * The conversation-node delivery contract dsh-routines delivers digests to.
 * A plugin (e.g. a future dsh-chatnode-wechat) provides this service on the
 * scheduler's context; when absent, chatnode deliveries are recorded as
 * `not-installed` and never crash the scheduler.
 */
export interface ChatnodeService {
    send(input: {
        text: string;
        title?: string;
    }): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Provided by the routine-store plugin. */
        routines?: RoutinesService;
        /** Provided by the scheduler plugin. */
        routinesScheduler?: RoutinesSchedulerService;
        /** Optional conversation node for chatnode delivery. */
        chatnode?: ChatnodeService;
    }
}
/** The store service: validated routines + durable state. */
export interface RoutinesService {
    /** All resolved routines (project overrides global on name), sorted by name. */
    list(): Routine[];
    /** Routine files that failed validation. */
    invalid(): InvalidRoutine[];
    get(name: string): Routine | undefined;
    /** Load the durable scheduler state. */
    state(): SchedulerState;
    /** Persist a state mutation and re-emit updates. */
    setState(mutate: (state: SchedulerState) => void): void;
    /** Subscribe to routine/state changes (files added/removed/edited, pause toggles). */
    onUpdated(listener: () => void): () => void;
    /** Directories the store watches. */
    dirs(): {
        project: string;
        global: string;
    };
}
/** Scheduler service used by the CLI for manual triggers and status. */
export interface RoutinesSchedulerService {
    /** Launch one routine now (manual trigger). Resolves with the final record. */
    launch(name: string, trigger?: RunTrigger): Promise<RunRecord>;
    /** Cancel a running routine (kills its job and subprocess). */
    cancel(name: string, reason?: string): boolean;
    /** Names of routines currently running. */
    running(): string[];
}
//# sourceMappingURL=types.d.ts.map