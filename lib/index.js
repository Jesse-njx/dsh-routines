/**
 * dsh-routines — scheduled agents for DSH: run a prompt on a cron, get the
 * digest where you already are.
 *
 * One bundle, three plugins (+ the run driver):
 * - `@dsh-routines/bundle/store` — watches `.dsh/routines/*.yaml` (project)
 *   and `~/.dsh/routines/*.yaml` (global), validates, hot-reloads.
 * - `@dsh-routines/bundle/scheduler` — registers due routines on `ctx.jobs`,
 *   owns overlap/missed-run/timeout semantics.
 * - `@dsh-routines/bundle/cli` — `dsh routines list|run|pause|resume|logs`.
 * - `@dsh-routines/bundle/run` — the child-side driver injected into each
 *   one-shot run subprocess; writes the run record and digest.
 *
 * @module @dsh-routines/bundle
 */
export * from "./types.js";
export { parseSchedule, nextAfter } from "./cron.js";
export { parseRoutineFile, resolveRoutine, expandHomePath, dshHome } from "./store.js";
export { Scheduler, realSpawn, defaultDshBin } from "./scheduler.js";
export { readRecentRecords } from "./cli.js";
export { summarizeEvents, transcriptOf, deniedApprovalsOf, truncate, deepFreeze } from "./digest.js";
//# sourceMappingURL=index.js.map