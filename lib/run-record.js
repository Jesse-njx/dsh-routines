/**
 * Run-record file IO. Records live under
 * `<routine.cwd>/.dsh/routines/runs/<runId>.json` and are written
 * atomically (temp file + rename) so a killed process never leaves a torn
 * JSON file behind.
 *
 * @module @dsh-routines/bundle/run-record
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** The runs directory for one routine cwd. */
export function runsDirFor(cwd) {
    return join(cwd, '.dsh', 'routines', 'runs');
}
/** The record file path for one run. */
export function recordPathFor(cwd, runId) {
    return join(runsDirFor(cwd), `${runId}.json`);
}
/** Atomic JSON write. */
export function writeRecord(path, record) {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
}
/** Read a run record, or `undefined` when absent or unparsable. */
export function readRecord(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=run-record.js.map