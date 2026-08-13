/**
 * Durable scheduler state IO. State lives at
 * `<projectDir>/.dsh/routines/state.json` and holds the paused set plus the
 * last launch time per routine (the anchor the missed-run policy advances
 * from). Written atomically.
 *
 * @module @dsh-routines/bundle/state
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SchedulerState } from './types.ts'

export const EMPTY_STATE: SchedulerState = { paused: [], lastRunAt: {} }

/** The state file path for one project directory. */
export function statePathFor(projectDir: string): string {
  return join(projectDir, '.dsh', 'routines', 'state.json')
}

/** Load the persisted state, tolerating an absent or corrupt file. */
export function loadState(projectDir: string): SchedulerState {
  const path = statePathFor(projectDir)
  try {
    if (!existsSync(path)) return { paused: [], lastRunAt: {} }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SchedulerState>
    const lastRunAt: Record<string, number> = {}
    if (parsed.lastRunAt !== null && typeof parsed.lastRunAt === 'object') {
      for (const [name, value] of Object.entries(parsed.lastRunAt as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) lastRunAt[name] = value
      }
    }
    return {
      paused: Array.isArray(parsed.paused) ? parsed.paused.filter((p): p is string => typeof p === 'string') : [],
      lastRunAt,
    }
  } catch {
    return { paused: [], lastRunAt: {} }
  }
}

/** Persist state atomically. */
export function saveState(projectDir: string, state: SchedulerState): void {
  const path = statePathFor(projectDir)
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}
