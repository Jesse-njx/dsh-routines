/**
 * routines-cli — `dsh routines list | run <name> | pause <name> |
 * resume <name> | logs <name>`, parsed from the launcher's immutable
 * command-line snapshot. With no inner arguments the command stays silent and
 * the process stays alive — that is daemon mode, where the scheduler ticks.
 *
 * @module @dsh-routines/bundle/cli
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Routine, RunRecord } from './types.ts';
/** The process streams the CLI writes to; tests substitute captures. */
export declare const internals: {
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
};
/** Stable Cordis plugin name. */
export declare const name = "routines-cli";
/** Services required before the command line can be parsed. */
export declare const inject: string[];
/** Read run records newest-first for one routine's cwd. */
export declare function readRecentRecords(routine: Routine, all?: boolean): RunRecord[];
/**
 * Mount the CLI: parse the launcher's inner arguments and run the invoked
 * `routines` subcommand.
 *
 * The dsh launcher hands everything after its own flags to the profile, so
 * `dsh --profile ops routines list` arrives as `['routines', 'list']`. Strip
 * the leading `routines` token before commander parses. This mirrors
 * `dsh-cmdline`'s parse contract (exit and output routed through the
 * launcher) but owns its argument snapshot, since the launcher-provided
 * `cmdlineArgs` service cannot be replaced.
 * @param ctx - plugin context carrying the command line, routines, and scheduler services.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=cli.d.ts.map