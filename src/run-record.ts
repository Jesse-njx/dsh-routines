/**
 * Run-record file IO. Records live under
 * `<routine.cwd>/.dsh/routines/runs/<runId>.json` and are written
 * atomically (temp file + rename) so a killed process never leaves a torn
 * JSON file behind.
 *
 * @module @dsh-routines/bundle/run-record
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunRecord } from './types.ts'

/** The runs directory for one routine cwd. */
export function runsDirFor(cwd: string): string {
  return join(cwd, '.dsh', 'routines', 'runs')
}

/** The record file path for one run. */
export function recordPathFor(cwd: string, runId: string): string {
  return join(runsDirFor(cwd), `${runId}.json`)
}

/** Atomic JSON write. */
export function writeRecord(path: string, record: RunRecord): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/** Read a run record, or `undefined` when absent or unparsable. */
export function readRecord(path: string): RunRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  } catch {
    return undefined
  }
}
