/**
 * Durable scheduler state IO. State lives at
 * `<projectDir>/.dsh/routines/state.json` and holds the paused set plus the
 * last launch time per routine (the anchor the missed-run policy advances
 * from). Written atomically.
 *
 * @module @dsh-routines/bundle/state
 */
import type { SchedulerState } from './types.ts';
export declare const EMPTY_STATE: SchedulerState;
/** The state file path for one project directory. */
export declare function statePathFor(projectDir: string): string;
/** Load the persisted state, tolerating an absent or corrupt file. */
export declare function loadState(projectDir: string): SchedulerState;
/** Persist state atomically. */
export declare function saveState(projectDir: string, state: SchedulerState): void;
//# sourceMappingURL=state.d.ts.map