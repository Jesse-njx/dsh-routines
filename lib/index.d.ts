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
export * from './types.ts';
export { parseSchedule, nextAfter } from './cron.ts';
export type { RoutineSchedule } from './cron.ts';
export { parseRoutineFile, resolveRoutine, expandHomePath, dshHome } from './store.ts';
export { Scheduler, realSpawn, defaultDshBin } from './scheduler.ts';
export type { SpawnedRun, RunSpawner, RunSpawnSpec, SpawnExit } from './scheduler.ts';
export { readRecentRecords } from './cli.ts';
export { summarizeEvents, transcriptOf, deniedApprovalsOf, truncate, deepFreeze } from './digest.ts';
//# sourceMappingURL=index.d.ts.map