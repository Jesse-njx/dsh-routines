import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { internals as cmdlineInternals } from '@deepseek-ai/dsh-cmdline'
import { apply, internals as cliInternals } from '../src/cli.ts'
import type { Routine, RoutinesService, RoutinesSchedulerService, RunRecord, SchedulerState } from '../src/types.ts'

/** Capture the CLI's own output and commander's help/error output. */
const out: string[] = []
const err: string[] = []
cliInternals.stdout = { write: (chunk: string) => { out.push(chunk) } }
cliInternals.stderr = { write: (chunk: string) => { err.push(chunk) } }
cmdlineInternals.stdout = { write: (chunk: string) => { out.push(chunk) } }
cmdlineInternals.stderr = { write: (chunk: string) => { err.push(chunk) } }

class MockRoutines implements RoutinesService {
  stateValue: SchedulerState = { paused: [], lastRunAt: {} }
  private readonly routines: Routine[]
  constructor(routines: Routine[]) {
    this.routines = routines
  }
  list(): Routine[] { return this.routines }
  invalid() { return [] }
  get(name: string): Routine | undefined { return this.routines.find((r) => r.name === name) }
  state(): SchedulerState { return { paused: [...this.stateValue.paused], lastRunAt: { ...this.stateValue.lastRunAt } } }
  setState(mutate: (state: SchedulerState) => void): void {
    const next: SchedulerState = { paused: [...this.stateValue.paused], lastRunAt: { ...this.stateValue.lastRunAt } }
    mutate(next)
    this.stateValue = next
  }
  onUpdated(): () => void { return () => {} }
  dirs() { return { project: '/tmp', global: '/tmp' } }
}

class MockScheduler implements RoutinesSchedulerService {
  launchCalls: { name: string; trigger: string }[] = []
  private readonly record: RunRecord
  constructor(record: RunRecord) {
    this.record = record
  }
  launch(name: string, trigger: 'schedule' | 'manual' = 'manual'): Promise<RunRecord> {
    this.launchCalls.push({ name, trigger })
    return Promise.resolve(this.record)
  }
  cancel(): boolean { return true }
  running(): string[] { return [] }
}

function makeRoutine(name: string, overrides: Partial<Routine> = {}): Routine {
  return {
    name,
    schedule: '0 2 * * *',
    timezone: 'UTC',
    prompt: 'go',
    cwd: '/tmp/proj',
    profile: 'headless',
    overlap: 'skip',
    timeoutMin: 45,
    deliver: [{ type: 'file' }],
    source: 'project',
    file: `/tmp/proj/.dsh/routines/${name}.yaml`,
    paused: false,
    ...overrides,
  }
}

interface CliHarness {
  ctx: Context
  exitCodes: number[]
  routines: MockRoutines
  scheduler: MockScheduler
}

function setup(args: string[], routines: Routine[], record?: RunRecord): CliHarness {
  const ctx = new Context()
  const exitCodes: number[] = []
  const routinesService = new MockRoutines(routines)
  const scheduler = new MockScheduler(record ?? { runId: 'run-1', routine: 'nightly', profile: 'headless', cwd: '/tmp/proj', status: 'completed', trigger: 'manual', startedAt: 1, digest: 'all green' })
  ctx.provide('cmdlineArgs', { get: () => Object.freeze([...args]) })
  ctx.provide('appExit', (code: number) => { exitCodes.push(code) })
  ctx.provide('routines', routinesService)
  ctx.provide('routinesScheduler', scheduler)
  apply(ctx)
  return { ctx, exitCodes, routines: routinesService, scheduler }
}

test('cli: list prints routines and exits 0', () => {
  out.length = 0
  const h = setup(['list'], [
    makeRoutine('nightly'),
    makeRoutine('weekly', { paused: true, schedule: '@daily' }),
  ])
  assert.deepEqual(h.exitCodes, [0])
  const text = out.join('')
  assert.match(text, /nightly/)
  assert.match(text, /weekly/)
  assert.match(text, /paused/)
  assert.match(text, /next=/)
})

test('cli: run launches the routine and prints the digest', async () => {
  out.length = 0
  const record: RunRecord = { runId: 'run-9', routine: 'nightly', profile: 'headless', cwd: '/tmp/proj', status: 'completed', trigger: 'manual', startedAt: 1, finishedAt: 2, durationMs: 1000, sessionId: 'session-abc', digest: 'tests passed: 42/42' }
  const h = setup(['run', 'nightly'], [makeRoutine('nightly')], record)
  // The run action is async; let the microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(h.scheduler.launchCalls, [{ name: 'nightly', trigger: 'manual' }])
  assert.deepEqual(h.exitCodes, [0])
  const text = out.join('')
  assert.match(text, /running nightly/)
  assert.match(text, /session: session-abc/)
  assert.match(text, /tests passed: 42\/42/)
})

test('cli: run of an unknown routine exits 1', async () => {
  out.length = 0
  err.length = 0
  const h = setup(['run', 'missing'], [makeRoutine('nightly')])
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(h.exitCodes, [1])
  assert.match(err.join(''), /not found/)
})

test('cli: pause and resume toggle the paused state', () => {
  const h = setup(['pause', 'nightly'], [makeRoutine('nightly')])
  assert.deepEqual(h.exitCodes, [0])
  assert.deepEqual(h.routines.stateValue.paused, ['nightly'])
  out.length = 0
  const h2 = setup(['resume', 'nightly'], [makeRoutine('nightly')])
  assert.deepEqual(h2.exitCodes, [0])
  assert.deepEqual(h2.routines.stateValue.paused, [])
})

test('cli: logs prints recent records and exits 0', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-routines-cli-'))
  const runsDir = join(cwd, '.dsh', 'routines', 'runs')
  mkdirSync(runsDir, { recursive: true })
  writeFileSync(join(runsDir, 'run-1.json'), JSON.stringify({
    runId: 'run-1', routine: 'nightly', profile: 'headless', cwd,
    status: 'completed', trigger: 'schedule', startedAt: 1000, finishedAt: 2000, durationMs: 1000,
    sessionId: 'session-x', digest: 'all green',
  }), 'utf8')
  out.length = 0
  const h = setup(['logs', 'nightly', '--limit', '5'], [makeRoutine('nightly', { cwd })])
  assert.deepEqual(h.exitCodes, [0])
  const text = out.join('')
  assert.match(text, /\[completed\]/)
  assert.match(text, /run-1/)
  assert.match(text, /session=session-x/)
  rmSync(cwd, { recursive: true, force: true })
})

test('cli: a leading "routines" token is stripped (dsh --profile ops routines list)', () => {
  out.length = 0
  const h = setup(['routines', 'list'], [makeRoutine('nightly')])
  assert.deepEqual(h.exitCodes, [0])
  const text = out.join('')
  assert.match(text, /nightly/)
  assert.match(text, /next=/)
})

test('cli: no inner arguments stays alive (daemon mode, no exit)', () => {
  out.length = 0
  const h = setup([], [makeRoutine('nightly')])
  assert.deepEqual(h.exitCodes, [])
  assert.equal(out.join(''), '')
})

test('cli: unknown subcommand exits nonzero', () => {
  out.length = 0
  const h = setup(['bogus'], [])
  assert.deepEqual(h.exitCodes, [1])
})

test('cli: foreign app flags (dsh web --host/--port) do not crash startup (issues #1, #2)', () => {
  out.length = 0
  err.length = 0
  const h = setup(['--host', '127.0.0.1', '--port', '3080', '--trusted-host', '172.31.250.2:3080'], [makeRoutine('nightly')])
  // The shared argv snapshot carries another app's flags; routines-cli must
  // ignore them (no exit, no "unknown option" error) instead of killing boot.
  assert.deepEqual(h.exitCodes, [])
  assert.doesNotMatch(err.join(''), /unknown option/)
})
