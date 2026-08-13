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

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import z from '@deepseek-ai/schemastery'
import * as yaml from 'js-yaml'
import { existsSync, mkdirSync, readFileSync, readdirSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseSchedule } from './cron.ts'
import { isValidTimeZone } from './time.ts'
import { loadState, saveState } from './state.ts'
import type { Delivery, InvalidRoutine, Routine, RoutineSource, RoutinesService, SchedulerState } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'routines-store'

/** Services required before routine files can be watched. */
export const inject = ['timer']

/** Plugin config with defaults applied by the loader. */
export interface Config {
  /** Project directory whose `.dsh/routines/` holds project routines. */
  projectDir?: string
  /** Global routines directory (`~/.dsh/routines` by default). */
  globalDir?: string
  /** Whether to watch for file changes. Tests disable this. */
  watch?: boolean
}

export const Config: z<Config> = z.object({
  projectDir: z.string().default(process.cwd()),
  globalDir: z.string().default(join(dshHome(), 'routines')),
  watch: z.boolean().default(true),
})

/** Expand `~/` against the OS home; leave other paths untouched. */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** The harness home: `$DSH_HOME` when non-empty, else `~/.dsh`. */
export function dshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const DeliverySchema = z.object({
  type: z.union([z.const('file'), z.const('chatnode')]).required(),
})

const RoutineConfigSchema = z.object({
  name: z.string().required(),
  schedule: z.string().required(),
  timezone: z.string().default('UTC'),
  prompt: z.string().required(),
  cwd: z.string(),
  profile: z.string().default('headless'),
  overlap: z.union([z.const('skip'), z.const('queue'), z.const('cancel-previous')]).default('skip'),
  timeoutMin: z.number().default(45),
  deliver: z.array(DeliverySchema).default([{ type: 'file' }]),
})

interface RawRoutine {
  name: string
  schedule: string
  timezone: string
  prompt: string
  cwd?: string
  profile: string
  overlap: 'skip' | 'queue' | 'cancel-previous'
  timeoutMin: number
  deliver: Delivery[]
}

/** Resolve one routine file into a validated `Routine` or an error string. */
export function resolveRoutine(raw: RawRoutine, source: RoutineSource, file: string, projectDir: string): Routine | InvalidRoutine {
  if (!NAME_PATTERN.test(raw.name) || raw.name.length > 64) {
    return { name: raw.name || '(unnamed)', file, source, error: `invalid name ${JSON.stringify(raw.name)}: use [a-z0-9][a-z0-9-]*, max 64 chars` }
  }
  if (raw.prompt.trim() === '') return { name: raw.name, file, source, error: 'prompt must not be empty' }
  if (!isValidTimeZone(raw.timezone)) return { name: raw.name, file, source, error: `invalid timezone ${JSON.stringify(raw.timezone)}` }
  try {
    parseSchedule(raw.schedule)
  } catch (error) {
    return { name: raw.name, file, source, error: error instanceof Error ? error.message : String(error) }
  }
  if (!Number.isFinite(raw.timeoutMin) || raw.timeoutMin <= 0) {
    return { name: raw.name, file, source, error: `timeoutMin must be a positive number (got ${String(raw.timeoutMin)})` }
  }
  const expanded = expandHomePath(raw.cwd ?? projectDir)
  const cwd = isAbsolute(expanded) ? expanded : resolve(projectDir, expanded)
  const deliver = raw.deliver.length > 0 ? raw.deliver : [{ type: 'file' as const }]
  return {
    name: raw.name,
    schedule: raw.schedule,
    timezone: raw.timezone,
    prompt: raw.prompt,
    cwd,
    profile: raw.profile,
    overlap: raw.overlap,
    timeoutMin: raw.timeoutMin,
    deliver,
    source,
    file,
    paused: false,
  }
}

/** Parse one YAML file into a raw routine config, or return an error text. */
export function parseRoutineFile(file: string): RawRoutine | string {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return error instanceof Error ? `cannot read ${file}: ${error.message}` : `cannot read ${file}`
  }
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (error) {
    return error instanceof Error ? `invalid YAML in ${file}: ${error.message}` : `invalid YAML in ${file}`
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `routine file ${file} must hold a YAML mapping`
  }
  try {
    return RoutineConfigSchema(parsed) as unknown as RawRoutine
  } catch (error) {
    return error instanceof Error ? `invalid routine in ${file}: ${error.message}` : `invalid routine in ${file}`
  }
}

/** The store's internal state: routines by name plus durable scheduler state. */
class RoutineStore implements RoutinesService {
  private routines = new Map<string, Routine>()
  private invalidList: InvalidRoutine[] = []
  private stateData: SchedulerState
  private readonly listeners = new Set<() => void>()
  private reloadTimer: (() => void) | undefined
  private readonly projectDir: string
  private readonly globalDir: string
  private readonly ctx: Context
  private readonly watchEnabled: boolean

  constructor(
    ctx: Context,
    projectDir: string,
    globalDir: string,
    watchEnabled: boolean,
  ) {
    this.ctx = ctx
    this.watchEnabled = watchEnabled
    this.projectDir = projectDir
    this.globalDir = globalDir
    this.stateData = loadState(projectDir)
    mkdirSync(join(projectDir, '.dsh', 'routines'), { recursive: true })
    mkdirSync(globalDir, { recursive: true })
    this.reload()
    if (watchEnabled) {
      for (const dir of [projectDir === globalDir ? globalDir : join(projectDir, '.dsh', 'routines'), globalDir]) {
        this.attachWatcher(dir)
      }
    }
    ctx.effect(() => () => {
      this.reloadTimer?.()
      this.listeners.clear()
    })
  }

  private attachWatcher(dir: string): void {
    let watcher: ReturnType<typeof watch> | undefined
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename !== null && !String(filename).endsWith('.yaml') && !String(filename).endsWith('.yml')) return
        this.scheduleReload()
      })
    } catch {
      return // directory vanished; a later mkdir/reload re-attaches on next store construction
    }
    this.ctx.effect(() => () => watcher?.close())
  }

  private scheduleReload(): void {
    this.reloadTimer?.()
    this.reloadTimer = this.ctx.timeout(() => {
      this.reloadTimer = undefined
      this.reload()
    }, 150)
  }

  /** Re-read both directories and publish the fresh routine list. */
  private reload(): void {
    const byName = new Map<string, Routine>()
    const invalid: InvalidRoutine[] = []
    const scan = (dir: string, source: RoutineSource): void => {
      let files: string[]
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()
      } catch {
        return
      }
      for (const file of files) {
        const path = join(dir, file)
        const parsed = parseRoutineFile(path)
        if (typeof parsed === 'string') {
          invalid.push({ name: file.replace(/\.ya?ml$/, ''), file: path, source, error: parsed })
          continue
        }
        const routine = resolveRoutine(parsed, source, path, this.projectDir)
        if ('error' in routine) {
          invalid.push(routine)
          continue
        }
        const existing = byName.get(routine.name)
        if (existing === undefined || source === 'project') byName.set(routine.name, routine)
      }
    }
    scan(this.globalDir, 'global')
    scan(join(this.projectDir, '.dsh', 'routines'), 'project')
    for (const routine of byName.values()) routine.paused = this.stateData.paused.includes(routine.name)
    this.routines = byName
    this.invalidList = invalid
    this.emitUpdated()
  }

  private emitUpdated(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // a broken subscriber must not break the store's commit
      }
    }
  }

  list(): Routine[] {
    return [...this.routines.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  invalid(): InvalidRoutine[] {
    return this.invalidList
  }

  get(name: string): Routine | undefined {
    return this.routines.get(name)
  }

  state(): SchedulerState {
    return { paused: [...this.stateData.paused], lastRunAt: { ...this.stateData.lastRunAt } }
  }

  setState(mutate: (state: SchedulerState) => void): void {
    const next: SchedulerState = {
      paused: [...this.stateData.paused],
      lastRunAt: { ...this.stateData.lastRunAt },
    }
    mutate(next)
    this.stateData = next
    saveState(this.projectDir, next)
    for (const routine of this.routines.values()) routine.paused = next.paused.includes(routine.name)
    this.emitUpdated()
  }

  onUpdated(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dirs(): { project: string; global: string } {
    return { project: join(this.projectDir, '.dsh', 'routines'), global: this.globalDir }
  }
}

/**
 * Mount the routine store and provide the `routines` service.
 * @param ctx - plugin context carrying the timer service.
 * @param config - validated store configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const projectDir = config.projectDir ?? process.cwd()
  const globalDir = config.globalDir ?? join(dshHome(), 'routines')
  const store = new RoutineStore(ctx, projectDir, globalDir, config.watch ?? true)
  ctx.provide('routines', store)
}
