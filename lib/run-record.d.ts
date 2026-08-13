/**
 * Run-record file IO. Records live under
 * `<routine.cwd>/.dsh/routines/runs/<runId>.json` and are written
 * atomically (temp file + rename) so a killed process never leaves a torn
 * JSON file behind.
 *
 * @module @dsh-routines/bundle/run-record
 */
import type { RunRecord } from './types.ts';
/** The runs directory for one routine cwd. */
export declare function runsDirFor(cwd: string): string;
/** The record file path for one run. */
export declare function recordPathFor(cwd: string, runId: string): string;
/** Atomic JSON write. */
export declare function writeRecord(path: string, record: RunRecord): void;
/** Read a run record, or `undefined` when absent or unparsable. */
export declare function readRecord(path: string): RunRecord | undefined;
//# sourceMappingURL=run-record.d.ts.map