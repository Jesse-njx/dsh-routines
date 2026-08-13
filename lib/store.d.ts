/**
 * routine-store — watches `.dsh/routines/*.yaml` (project) and
 * `~/.dsh/routines/*.yaml` (global), validates each file, hot-reloads on
 * change, and exposes the `routines` service plus the durable scheduler
 * state.
 *
 * Cordis effects make add/remove clean: file events are debounced into one
 * transactional reload, and every subscriber is re-notified with the fresh
 * list. A file that fails to parse or validate is reported through
 * {@link RoutinesService.invalid} and never crashes the store.
 *
 * @module @dsh-routines/bundle/store
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Delivery, InvalidRoutine, Routine, RoutineSource } from './types.ts';
/** Stable Cordis plugin name. */
export declare const name = "routines-store";
/** Services required before routine files can be watched. */
export declare const inject: string[];
/** Plugin config with defaults applied by the loader. */
export interface Config {
    /** Project directory whose `.dsh/routines/` holds project routines. */
    projectDir?: string;
    /** Global routines directory (`~/.dsh/routines` by default). */
    globalDir?: string;
    /** Whether to watch for file changes. Tests disable this. */
    watch?: boolean;
}
export declare const Config: z<Config>;
/** Expand `~/` against the OS home; leave other paths untouched. */
export declare function expandHomePath(path: string): string;
/** The harness home: `$DSH_HOME` when non-empty, else `~/.dsh`. */
export declare function dshHome(): string;
interface RawRoutine {
    name: string;
    schedule: string;
    timezone: string;
    prompt: string;
    cwd?: string;
    profile: string;
    overlap: 'skip' | 'queue' | 'cancel-previous';
    timeoutMin: number;
    deliver: Delivery[];
}
/** Resolve one routine file into a validated `Routine` or an error string. */
export declare function resolveRoutine(raw: RawRoutine, source: RoutineSource, file: string, projectDir: string): Routine | InvalidRoutine;
/** Parse one YAML file into a raw routine config, or return an error text. */
export declare function parseRoutineFile(file: string): RawRoutine | string;
/**
 * Mount the routine store and provide the `routines` service.
 * @param ctx - plugin context carrying the timer service.
 * @param config - validated store configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
export {};
//# sourceMappingURL=store.d.ts.map