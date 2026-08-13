/**
 * scheduler — registers due routines on `ctx.jobs` and owns the boring
 * semantics: overlap policies, missed-run catch-up (at most once, never a
 * backlog replay), and hard timeouts via the jobs API.
 *
 * Each due routine launches a fresh headless run as its own job of kind
 * `routine` (visible in any jobs UI). The run subprocess boots
 * `dsh --profile <routine.profile> --patch <generated overlay> -- <prompt>`
 * with the routine's cwd as its workspace, the approval row forced to
 * `never` (unattended: anything that would prompt is auto-denied and noted
 * in the digest), and the `headless-runner` row replaced by
 * `@dsh-routines/bundle/run` so the subprocess writes the full run record.
 *
 * A fake clock, fake spawner, and manual ticks make the whole matrix
 * table-testable without real cron waits or subprocesses.
 *
 * @module @dsh-routines/bundle/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import z from '@deepseek-ai/schemastery'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { JobHooks, JobId, JobOutcome, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { nextAfter, parseSchedule } from './cron.ts'
import { readRecord, recordPathFor, runsDirFor, writeRecord } from './run-record.ts'
import {
  DEFAULT_DIGEST_MAX_CHARS,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_MAX_TOKENS,
  DEFAULT_SUMMARY_TIMEOUT_MS,
} from './digest.ts'
import type { DeliveryResult, Routine, RunRecord, RoutinesSchedulerService, RoutinesService, RunTrigger } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'routines-scheduler'

/** Services required before scheduling can start. */
export const inject = ['routines', 'jobs', 'timer']

/** Plugin config with defaults applied by the loader. */
export interface Config {
  /** How often the scheduler checks for due routines. */
  tickIntervalMs?: number
  /** Max routines launched in one tick (stampede guard on wake). */
  maxRunsPerTick?: number
  /** Grace between SIGTERM and SIGKILL when stopping a wedged run. */
  killGraceMs?: number
  /** The `dsh` binary (or entry script) used to launch runs. */
  dshBin?: string
  /** Absolute path of the child-side run module the overlay replaces headless-runner with. */
  runModule?: string
  /** Digest sizing the overlay embeds into each run. */
  digestMaxChars?: number
  summaryMaxChars?: number
  summaryMaxTokens?: number
  summaryTimeoutMs?: number
  /** Test seams: fake clock and fake spawner. */
  now?: () => number
  spawn?: RunSpawner
}

export const Config: z<Config> = z.object({
  tickIntervalMs: z.number().default(30_000),
  maxRunsPerTick: z.number().default(4),
  killGraceMs: z.number().default(10_000),
  dshBin: z.string(),
  runModule: z.string(),
  digestMaxChars: z.number().default(DEFAULT_DIGEST_MAX_CHARS),
  summaryMaxChars: z.number().default(DEFAULT_SUMMARY_MAX_CHARS),
  summaryMaxTokens: z.number().default(DEFAULT_SUMMARY_MAX_TOKENS),
  summaryTimeoutMs: z.number().default(DEFAULT_SUMMARY_TIMEOUT_MS),
  now: z.function(),
  spawn: z.function(),
})

/** The dsh entry the operator is running under, or `dsh` on PATH. */
export function defaultDshBin(): string {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  const entry = process.argv[1]
  return entry !== undefined && entry !== '' ? entry : 'dsh'
}

/** The exit of one spawned run subprocess. */
export interface SpawnExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Set when the process could not be spawned at all. */
  error?: string
}

/** A spawned run subprocess, real or faked. */
export interface SpawnedRun {
  kill(signal: NodeJS.Signals): void
  exit: Promise<SpawnExit>
}

/** Everything the spawner needs to start one run. */
export interface RunSpawnSpec {
  bin: string
  profile: string
  patchPath: string
  prompt: string
  cwd: string
  env: Record<string, string | undefined>
}

export type RunSpawner = (spec: RunSpawnSpec) => SpawnedRun

/** Spawn a run with the real `dsh` CLI, inheriting the operator's streams. */
export function realSpawn(spec: RunSpawnSpec): SpawnedRun {
  const args = ['--profile', spec.profile, '--patch', spec.patchPath, '--', spec.prompt]
  let child: ChildProcess
  const looksLikeScript = /\.(mjs|cjs|js)$/.test(spec.bin)
  try {
    child = looksLikeScript ? spawn(process.execPath, [spec.bin, ...args], { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'inherit', 'inherit'] }) : spawn(spec.bin, args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      kill: () => {},
      exit: Promise.resolve({ code: null, signal: null, error: `cannot spawn ${spec.bin}: ${message}` }),
    }
  }
  const exit = new Promise<SpawnExit>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal })
    })
    child.on('error', (error) => {
      resolve({ code: null, signal: null, error: error.message })
    })
  })
  return {
    kill: (signal) => {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    },
    exit,
  }
}

/** One in-flight run tracked by the scheduler. */
interface RunningRun {
  routine: Routine
  runId: string
  recordPath: string
  patchPath: string
  jobId?: JobId
  spawned: SpawnedRun
  terminal: { timedOut: boolean; reason?: string }
  done: Promise<RunRecord>
}

/** The scheduler core. */
export class Scheduler implements RoutinesSchedulerService {
  private readonly inFlight = new Map<string, RunningRun>()
  private readonly queued = new Set<string>()
  private tickDisposer: (() => void) | undefined
  private readonly doneDisposer: () => void
  private readonly ctx: Context
  private readonly routines: RoutinesService
  private readonly config: Required<Pick<Config, 'tickIntervalMs' | 'maxRunsPerTick' | 'killGraceMs' | 'dshBin' | 'runModule' | 'digestMaxChars' | 'summaryMaxChars' | 'summaryMaxTokens' | 'summaryTimeoutMs'>> & Pick<Config, 'now' | 'spawn'>

  constructor(
    ctx: Context,
    routines: RoutinesService,
    config: Required<Pick<Config, 'tickIntervalMs' | 'maxRunsPerTick' | 'killGraceMs' | 'dshBin' | 'runModule' | 'digestMaxChars' | 'summaryMaxChars' | 'summaryMaxTokens' | 'summaryTimeoutMs'>> & Pick<Config, 'now' | 'spawn'>,
  ) {
    this.ctx = ctx
    this.routines = routines
    this.config = config
    this.doneDisposer = this.ctx.jobs.onJobDone(this.onJobDone.bind(this))
    ctx.effect(() => () => {
      this.tickDisposer?.()
      this.doneDisposer()
    })
  }

  private now(): number {
    return this.config.now?.() ?? Date.now()
  }

  /**
   * Start ticking. The first tick waits for the loader to settle: job
   * controllers (e.g. `dsh-tool-jobs`) attach during tree activation, and a
   * tick that raced them would fail every `ctx.jobs.start` it launched.
   */
  start(): void {
    this.tickDisposer = this.ctx.interval(() => this.tick(), this.config.tickIntervalMs)
    const loader = this.ctx.get('loader')
    if (loader !== undefined) {
      void loader.await().then(() => {
        if (this.tickDisposer !== undefined) this.tick()
      }).catch(() => {
        // loader teardown during shutdown: nothing to schedule anyway
      })
    } else {
      this.tick()
    }
  }

  /** Stop ticking (job runs already in flight continue). */
  stop(): void {
    this.tickDisposer?.()
    this.tickDisposer = undefined
  }

  /** One scheduling pass. */
  tick(): void {
    const now = this.now()
    const state = this.routines.state()
    let launched = 0
    for (const routine of this.routines.list()) {
      if (this.queued.has(routine.name)) continue
      if (routine.paused || state.paused.includes(routine.name)) continue
      const lastRunAt = state.lastRunAt[routine.name] ?? 0
      let schedule
      try {
        schedule = parseSchedule(routine.schedule)
      } catch {
        continue // the store already reported the invalid file
      }
      const next = nextAfter(schedule, lastRunAt === 0 ? now : lastRunAt, routine.timezone) ?? Number.POSITIVE_INFINITY
      if (next === Number.POSITIVE_INFINITY || next > now) continue
      if (this.inFlight.has(routine.name)) {
        if (routine.overlap === 'skip') {
          this.recordSkipped(routine, 'overlap-skip: a run was still in progress')
          this.routines.setState((s) => { s.lastRunAt[routine.name] = now })
          continue
        }
        if (routine.overlap === 'queue') {
          this.queued.add(routine.name)
          this.routines.setState((s) => { s.lastRunAt[routine.name] = now })
          continue
        }
        // cancel-previous: stop the in-flight run, then launch the new one.
        this.cancel(routine.name, 'superseded by the next scheduled occurrence')
      }
      this.launch(routine.name, 'schedule')
      launched += 1
      if (launched >= this.config.maxRunsPerTick) break
    }
  }

  /** Launch one run (scheduled or manual). Returns the final record promise. */
  launch(name: string, trigger: RunTrigger = 'manual'): Promise<RunRecord> {
    const routine = this.routines.get(name)
    if (routine === undefined) return Promise.reject(new Error(`routine ${JSON.stringify(name)} not found`))
    return this.startRun(routine, trigger).done
  }

  /** Cancel a running routine. Returns false when nothing was running. */
  cancel(name: string, reason = 'cancelled'): boolean {
    const entry = this.inFlight.get(name)
    if (entry === undefined || entry.jobId === undefined) return false
    this.ctx.jobs.kill(entry.jobId, undefined, reason)
    return true
  }

  /** Names of routines currently running. */
  running(): string[] {
    return [...this.inFlight.keys()]
  }

  /** Register the job and subprocess for one run. */
  private startRun(routine: Routine, trigger: RunTrigger): RunningRun {
    const runId = `run-${this.now()}-${Math.random().toString(36).slice(2, 7)}`
    const runsDir = runsDirFor(routine.cwd)
    mkdirSync(runsDir, { recursive: true })
    const recordPath = recordPathFor(routine.cwd, runId)
    const patchPath = join(runsDir, `.${runId}.patch.yml`)
    writeRecord(recordPath, {
      runId,
      routine: routine.name,
      profile: routine.profile,
      cwd: routine.cwd,
      status: 'running',
      trigger,
      startedAt: this.now(),
    })
    this.writeRunPatch(patchPath, routine, runId, recordPath)
    this.routines.setState((s) => { s.lastRunAt[routine.name] = this.now() })

    const terminal: RunningRun['terminal'] = { timedOut: false }
    const spawned = this.config.spawn !== undefined
      ? this.config.spawn({ bin: this.config.dshBin, profile: routine.profile, patchPath, prompt: routine.prompt, cwd: routine.cwd, env: process.env })
      : realSpawn({ bin: this.config.dshBin, profile: routine.profile, patchPath, prompt: routine.prompt, cwd: routine.cwd, env: process.env })

    const entry: RunningRun = {
      routine,
      runId,
      recordPath,
      patchPath,
      spawned,
      terminal,
      done: Promise.resolve(undefined as unknown as RunRecord),
    }
    entry.done = this.finalizeAfterExit(entry, spawned, terminal)

    let jobId: JobId
    try {
      jobId = this.ctx.jobs.start({
        kind: 'routine',
        label: `routine ${routine.name} (${runId})`,
        run: () => ({
          cancel: (reason) => {
            if (reason === 'routine timeout') terminal.timedOut = true
            else terminal.reason = reason
            this.requestKill(spawned)
          },
          done: entry.done.then((record): JobOutcome => ({
            status: record.status === 'completed' ? 'completed' : record.status === 'failed' ? 'failed' : 'killed',
            detail: record.error,
            output: record.digest,
          })),
        }),
      })
    } catch (error) {
      // The registry refused the job: stop the child and report the failed run.
      this.requestKill(spawned)
      const failed: RunRecord = {
        runId,
        routine: routine.name,
        profile: routine.profile,
        cwd: routine.cwd,
        status: 'failed',
        trigger,
        startedAt: this.now(),
        finishedAt: this.now(),
        durationMs: 0,
        error: `job registration failed: ${error instanceof Error ? error.message : String(error)}`,
      }
      writeRecord(recordPath, failed)
      throw error
    }
    entry.jobId = jobId

    // Hard stop via the jobs API: a wedged 2am agent must not still hold the repo at 9am.
    const timeoutMs = routine.timeoutMin * 60_000
    this.ctx.timeout(() => {
      if (this.inFlight.get(routine.name)?.runId === runId) this.ctx.jobs.kill(jobId, undefined, 'routine timeout')
    }, timeoutMs)

    this.inFlight.set(routine.name, entry)
    return entry
  }

  /** Await the child exit, finalize the record, and clean up the overlay. */
  private async finalizeAfterExit(entry: RunningRun, spawned: SpawnedRun, terminal: RunningRun['terminal']): Promise<RunRecord> {
    const exitInfo = await spawned.exit
    const record = this.finalizeRun(entry.routine, entry.runId, entry.recordPath, terminal, exitInfo)
    rmSync(entry.patchPath, { force: true })
    return record
  }

  /** Fill any missing record fields, run deliveries, and persist. */
  private async finalizeRun(routine: Routine, runId: string, recordPath: string, terminal: RunningRun['terminal'], exitInfo: SpawnExit): Promise<RunRecord> {
    const existing = readRecord(recordPath)
    const record: RunRecord = existing ?? {
      runId,
      routine: routine.name,
      profile: routine.profile,
      cwd: routine.cwd,
      status: 'running',
      trigger: 'schedule',
      startedAt: this.now(),
    }
    if (record.status === 'running') {
      if (terminal.timedOut) {
        record.status = 'timeout'
        record.error = record.error ?? `run exceeded its ${routine.timeoutMin}-minute timeout and was stopped`
      } else if (terminal.reason !== undefined) {
        record.status = 'killed'
        record.error = record.error ?? terminal.reason
      } else if (exitInfo.error !== undefined) {
        record.status = 'failed'
        record.error = record.error ?? exitInfo.error
      } else if (exitInfo.code === 0) {
        record.status = 'completed'
      } else {
        record.status = 'failed'
        record.error = record.error ?? `run process exited ${describeExit(exitInfo)} without a final record`
      }
    }
    if (record.finishedAt === undefined) {
      record.finishedAt = this.now()
      record.durationMs = record.finishedAt - record.startedAt
    }
    if (record.exitCode === undefined && exitInfo.code !== null) record.exitCode = exitInfo.code
    record.deliveries = await this.deliver(record, routine)
    writeRecord(recordPath, record)
    return record
  }

  /** Deliver the digest per the routine config. Delivery failures never crash the scheduler. */
  private async deliver(record: RunRecord, routine: Routine): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = []
    for (const delivery of routine.deliver) {
      if (delivery.type === 'file') {
        results.push({ type: 'file', ok: true })
        continue
      }
      if (delivery.type === 'chatnode') {
        const node = this.ctx.get('chatnode')
        if (node === undefined || typeof node.send !== 'function') {
          results.push({ type: 'chatnode', ok: false, error: 'no chatnode service installed' })
          continue
        }
        try {
          await node.send({
            title: `dsh-routines: ${record.routine}`,
            text: `[${record.status}] ${record.routine}\n\n${record.digest ?? '(no digest)'}`,
          })
          results.push({ type: 'chatnode', ok: true })
        } catch (error) {
          results.push({ type: 'chatnode', ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    return results
  }

  /** Write a run record for an occurrence that was skipped by the overlap policy. */
  private recordSkipped(routine: Routine, reason: string): void {
    const runId = `run-${this.now()}-skipped`
    const record: RunRecord = {
      runId,
      routine: routine.name,
      profile: routine.profile,
      cwd: routine.cwd,
      status: 'skipped',
      trigger: 'schedule',
      startedAt: this.now(),
      finishedAt: this.now(),
      durationMs: 0,
      error: reason,
    }
    writeRecord(recordPathFor(routine.cwd, runId), record)
  }

  /** SIGTERM, then SIGKILL after the grace window. */
  private requestKill(spawned: SpawnedRun): void {
    spawned.kill('SIGTERM')
    const grace = this.config.killGraceMs
    const timer = setTimeout(() => spawned.kill('SIGKILL'), grace)
    timer.unref?.()
  }

  /** After a job settles, release the slot and drain one queued occurrence. */
  private onJobDone(snapshot: JobSnapshot): void {
    const name = this.routineNameOf(snapshot.id)
    if (name === undefined) return
    this.inFlight.delete(name)
    if (this.queued.has(name)) {
      this.queued.delete(name)
      const routine = this.routines.get(name)
      if (routine !== undefined) this.startRun(routine, 'schedule')
    }
  }

  private routineNameOf(jobId: JobId): string | undefined {
    for (const [name, entry] of this.inFlight) {
      if (entry.jobId === jobId) return name
    }
    return undefined
  }

  /** Write the generated `--patch` overlay that turns a plain headless run into a routine run. */
  private writeRunPatch(patchPath: string, routine: Routine, runId: string, recordPath: string): void {
    const q = (value: string): string => JSON.stringify(value)
    const lines = [
      '# dsh-routines run overlay (generated; safe to delete)',
      `# run ${runId} of routine ${routine.name}`,
      '',
      '# Unattended safety: anything that would prompt is auto-denied and noted in the digest.',
      '- id: approval',
      '  config:',
      '    policy: never',
      '# The permission table must still validate: register the unattended combo',
      '# (workspace-write sandbox + never approval) as the run profile default.',
      '- id: permission',
      '  config:',
      '    defaultPreset: workspace-write-deny',
      '    presets:',
      '      workspace-write-deny:',
      '        sandbox: workspace-write',
      '        approval: never',
      '',
      '# A run subprocess must never schedule nested runs.',
      '- id: routines-scheduler',
      '  disabled: true',
      '',
      '# Replace the headless runner with the routines run driver: disable the',
      '# stock one-shot runner and mount our driver on the same task service.',
      '- id: headless-runner',
      '  disabled: true',
      '- insert:',
      '    - id: routines-run-driver',
      `      name: ${q(this.config.runModule)}`,
      '      inject: [headlessStartup]',
      '      config:',
      '        task: !!js ctx.headlessStartup.task',
      `        runRecord: ${q(recordPath)}`,
      `        routine: ${q(routine.name)}`,
      `        runId: ${q(runId)}`,
      `        digestMaxChars: ${this.config.digestMaxChars}`,
      `        summaryMaxChars: ${this.config.summaryMaxChars}`,
      `        summaryMaxTokens: ${this.config.summaryMaxTokens}`,
      `        summaryTimeoutMs: ${this.config.summaryTimeoutMs}`,
      '',
    ].join('\n')
    writeFileSync(patchPath, lines, 'utf8')
  }
}

/** Human text for a subprocess exit. */
function describeExit(exitInfo: SpawnExit): string {
  if (exitInfo.error !== undefined) return exitInfo.error
  if (exitInfo.signal !== null) return `signal ${exitInfo.signal}`
  return `exit code ${String(exitInfo.code)}`
}

/**
 * Mount the scheduler: tick immediately, then on the configured interval.
 * @param ctx - plugin context carrying the routines service, jobs registry, and timer.
 * @param config - validated scheduler configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const routines = ctx.get('routines')
  if (routines === undefined) throw new Error('routines-scheduler: the routines service is required (load routines-store first)')
  const scheduler = new Scheduler(ctx, routines, {
    tickIntervalMs: config.tickIntervalMs ?? 30_000,
    maxRunsPerTick: config.maxRunsPerTick ?? 4,
    killGraceMs: config.killGraceMs ?? 10_000,
    dshBin: config.dshBin ?? defaultDshBin(),
    runModule: config.runModule ?? fileURLToPath(new URL('./run.js', import.meta.url)),
    digestMaxChars: config.digestMaxChars ?? DEFAULT_DIGEST_MAX_CHARS,
    summaryMaxChars: config.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS,
    summaryMaxTokens: config.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
    summaryTimeoutMs: config.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS,
    now: config.now,
    spawn: config.spawn,
  })
  scheduler.start()
  ctx.provide('routinesScheduler', scheduler)
}
