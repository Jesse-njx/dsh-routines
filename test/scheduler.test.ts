import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { TimerService } from '@deepseek-ai/cordis-plugin-timer'
import { Scheduler, type RunSpawnSpec, type SpawnedRun, type SpawnExit } from '../src/scheduler.ts'
import type { Routine, RoutinesService, SchedulerState } from '../src/types.ts'

/** A controllable fake run subprocess. */
class FakeSpawn implements SpawnedRun {
  killed = false
  readonly exit: Promise<SpawnExit>
  readonly spec: RunSpawnSpec
  private resolveExit!: (value: SpawnExit) => void
  constructor(spec: RunSpawnSpec) {
    this.spec = spec
    this.exit = new Promise((resolve) => { this.resolveExit = resolve })
  }
  kill(signal: NodeJS.Signals): void {
    this.killed = true
    this.resolveExit({ code: null, signal })
  }
  settle(code: number): void {
    this.resolveExit({ code, signal: null })
  }
}

/** A fake spawner that records calls and lets the test settle each child. */
class FakeSpawner {
  calls: RunSpawnSpec[] = []
  spawned: FakeSpawn[] = []
  spawn(spec: RunSpawnSpec): SpawnedRun {
    const fake = new FakeSpawn(spec)
    this.calls.push(spec)
    this.spawned.push(fake)
    return fake
  }
}

/** A minimal routines service backed by in-memory routines. */
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

/** Build a routine with defaults. */
function routine(overrides: Partial<Routine> & { name: string }, cwd: string): Routine {
  return {
    schedule: '0 2 * * *',
    timezone: 'UTC',
    prompt: 'run the tests',
    cwd,
    profile: 'headless',
    overlap: 'skip',
    timeoutMin: 45,
    deliver: [{ type: 'file' }],
    source: 'project',
    file: `${cwd}/.dsh/routines/${overrides.name}.yaml`,
    paused: false,
    ...overrides,
  }
}

interface Harness {
  ctx: Context
  scheduler: Scheduler
  spawner: FakeSpawner
  routines: MockRoutines
  cwd: string
  now: { value: number }
  dispose(): Promise<void>
}

function setup(makeRoutines: (cwd: string) => Routine[], overrides: { now?: number; maxRunsPerTick?: number; killGraceMs?: number } = {}): Harness {
  const ctx = new Context()
  new TimerService(ctx)
  new LocalJobRegistry(ctx, {})
  ctx.jobs.attachController('test')
  const spawner = new FakeSpawner()
  const now = { value: overrides.now ?? Date.parse('2026-08-14T02:00:30Z') }
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-routines-scheduler-'))
  const mock = new MockRoutines(makeRoutines(cwd))
  const scheduler = new Scheduler(ctx, mock, {
    tickIntervalMs: 30_000,
    maxRunsPerTick: overrides.maxRunsPerTick ?? 4,
    killGraceMs: overrides.killGraceMs ?? 1_000,
    dshBin: '/fake/dsh',
    runModule: '/fake/run.js',
    digestMaxChars: 2000,
    summaryMaxChars: 24000,
    summaryMaxTokens: 400,
    summaryTimeoutMs: 60_000,
    now: () => now.value,
    spawn: (spec) => spawner.spawn(spec),
  })
  return {
    ctx,
    scheduler,
    spawner,
    routines: mock,
    cwd,
    now,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

/** Read terminal run records in a routine cwd, newest first. */
function records(h: Harness): Record<string, unknown>[] {
  const dir = join(h.cwd, '.dsh', 'routines', 'runs')
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f.startsWith('run-'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
      .sort((a, b) => Number(b.startedAt) - Number(a.startedAt))
  } catch {
    return []
  }
}

/** Wait until the spawner has been asked to start `count` runs. */
async function waitForSpawns(h: Harness, count: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (h.spawner.calls.length >= count) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} spawns; got ${h.spawner.calls.length}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Wait until `count` run records reach a terminal status. */
async function waitForRecords(h: Harness, count: number, timeoutMs = 2000): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const done = records(h).filter((r) => r.status !== 'running')
    if (done.length >= count) return done
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} terminal records; got ${done.length}: ${JSON.stringify(records(h))}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('scheduler: due routine fires and the record finalizes as completed', async () => {
  const h = setup((cwd) => [routine({ name: 'nightly' }, cwd)], { now: Date.parse('2026-08-14T02:00:30Z') })
  h.routines.stateValue.lastRunAt.nightly = Date.parse('2026-08-13T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1)
  const call = h.spawner.calls[0]!
  assert.equal(call.profile, 'headless')
  assert.equal(call.cwd, h.cwd)
  assert.ok(call.patchPath.endsWith('.patch.yml'))
  assert.equal(call.prompt, 'run the tests')
  // The overlay must force unattended approval, disable the stock runner,
  // and mount the routines run driver in its place.
  const patch = readFileSync(call.patchPath, 'utf8')
  assert.match(patch, /policy: never/)
  assert.match(patch, /defaultPreset: workspace-write-deny/)
  assert.match(patch, /- id: headless-runner\s*\n\s*disabled: true/)
  assert.match(patch, /- id: routines-run-driver/)
  assert.match(patch, /name: "\/fake\/run\.js"/)
  assert.match(patch, /- id: routines-scheduler\s*\n\s*disabled: true/)
  h.spawner.spawned[0]!.settle(0)
  const [record] = await waitForRecords(h, 1)
  assert.equal(record.status, 'completed')
  assert.equal(record.routine, 'nightly')
  assert.equal(record.trigger, 'schedule')
  assert.equal(record.exitCode, 0)
  // lastRunAt advanced to the fire time: no backlog replay on the next tick.
  h.now.value = Date.parse('2026-08-14T03:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1)
  await h.dispose()
})

test('scheduler: a routine that is not due does not launch', async () => {
  const h = setup((cwd) => [routine({ name: 'later' }, cwd)], { now: Date.parse('2026-08-14T10:00:00Z') })
  h.routines.stateValue.lastRunAt.later = Date.parse('2026-08-14T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 0)
  await h.dispose()
})

test('scheduler: missed runs fire at most once on wake, never a backlog', async () => {
  const h = setup((cwd) => [routine({ name: 'nightly' }, cwd)], { now: Date.parse('2026-08-14T09:00:00Z') })
  // The machine was asleep since 2026-08-11: three daily occurrences were missed.
  h.routines.stateValue.lastRunAt.nightly = Date.parse('2026-08-11T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1, 'exactly one catch-up run on wake')
  h.spawner.spawned[0]!.settle(0)
  await waitForRecords(h, 1)
  // No backlog replay: the next tick must not fire again.
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1)
  await h.dispose()
})

test('scheduler: overlap skip never stacks two agents on one repo', async () => {
  const h = setup((cwd) => [routine({ name: 'nightly', overlap: 'skip' }, cwd)], { now: Date.parse('2026-08-14T02:00:30Z') })
  h.routines.stateValue.lastRunAt.nightly = Date.parse('2026-08-13T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1)
  // While the first run is still in flight, the next occurrence becomes due.
  h.now.value = Date.parse('2026-08-14T03:00:00Z')
  h.routines.stateValue.lastRunAt.nightly = Date.parse('2026-08-13T02:00:00Z') // stale anchor simulates the missed window
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1, 'skip must not start a second run')
  h.spawner.spawned[0]!.settle(0)
  await waitForRecords(h, 2) // completed + skipped
  const skipped = records(h).find((r) => r.status === 'skipped')
  assert.ok(skipped, 'a skipped record documents the overlap occurrence')
  assert.match(String(skipped.error), /overlap/)
  await h.dispose()
})

test('scheduler: overlap queue runs the queued occurrence after the current one', async () => {
  const h = setup((cwd) => [routine({ name: 'hourly', overlap: 'queue', schedule: '0 * * * *' }, cwd)], { now: Date.parse('2026-08-14T02:00:30Z') })
  h.routines.stateValue.lastRunAt.hourly = Date.parse('2026-08-14T01:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1)
  // 3am becomes due while the 2am run is still running.
  h.now.value = Date.parse('2026-08-14T03:00:30Z')
  h.routines.stateValue.lastRunAt.hourly = Date.parse('2026-08-14T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1, 'queue must not start a second run immediately')
  h.spawner.spawned[0]!.settle(0)
  await waitForRecords(h, 1)
  // The queued occurrence launches once the first run settles.
  await waitForSpawns(h, 2)
  assert.equal(h.spawner.calls.length, 2)
  h.spawner.spawned[1]!.settle(0)
  await waitForRecords(h, 2)
  await h.dispose()
})

test('scheduler: overlap cancel-previous stops the in-flight run and starts fresh', async () => {
  const h = setup((cwd) => [routine({ name: 'hourly', overlap: 'cancel-previous', schedule: '0 * * * *' }, cwd)], { now: Date.parse('2026-08-14T02:00:30Z') })
  h.routines.stateValue.lastRunAt.hourly = Date.parse('2026-08-14T01:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1)
  h.now.value = Date.parse('2026-08-14T03:00:30Z')
  h.routines.stateValue.lastRunAt.hourly = Date.parse('2026-08-14T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 2, 'cancel-previous launches the new occurrence immediately')
  assert.equal(h.spawner.spawned[0]!.killed, true, 'the previous subprocess was killed')
  h.spawner.spawned[1]!.settle(0)
  await waitForRecords(h, 2)
  const killed = records(h).find((r) => r.status === 'killed')
  assert.ok(killed, 'the superseded run is recorded as killed')
  await h.dispose()
})

test('scheduler: a wedged run is hard-stopped at the timeout', async () => {
  const h = setup((cwd) => [routine({ name: 'wedged', timeoutMin: 0.0005 }, cwd)], { now: Date.parse('2026-08-14T02:00:30Z'), killGraceMs: 50 })
  h.routines.stateValue.lastRunAt.wedged = Date.parse('2026-08-13T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 1)
  // The fake subprocess never exits on its own; the timeout must stop it.
  const [record] = await waitForRecords(h, 1, 3000)
  assert.equal(record.status, 'timeout')
  assert.match(String(record.error), /timeout/)
  assert.equal(h.spawner.spawned[0]!.killed, true)
  await h.dispose()
})

test('scheduler: paused routines are never launched', async () => {
  const h = setup((cwd) => [routine({ name: 'paused-one', paused: true }, cwd)], { now: Date.parse('2026-08-14T02:00:30Z') })
  h.routines.stateValue.lastRunAt['paused-one'] = Date.parse('2026-08-13T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 0)
  await h.dispose()
})

test('scheduler: maxRunsPerTick caps the wake-up stampede', async () => {
  const h = setup(
    (cwd) => ['a', 'b', 'c', 'd'].map((name) => routine({ name, schedule: '0 2 * * *' }, cwd)),
    { now: Date.parse('2026-08-14T02:00:30Z'), maxRunsPerTick: 2 },
  )
  for (const name of ['a', 'b', 'c', 'd']) h.routines.stateValue.lastRunAt[name] = Date.parse('2026-08-13T02:00:00Z')
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 2)
  // Settle both; the next tick launches the remainder.
  h.spawner.spawned[0]!.settle(0)
  h.spawner.spawned[1]!.settle(0)
  await waitForRecords(h, 2)
  h.scheduler.tick()
  assert.equal(h.spawner.calls.length, 4)
  await h.dispose()
})

test('scheduler: manual launch returns the final record and updates the anchor', async () => {
  const h = setup((cwd) => [routine({ name: 'manual-one' }, cwd)], { now: Date.parse('2026-08-14T10:00:00Z') })
  const done = h.scheduler.launch('manual-one', 'manual')
  assert.equal(h.spawner.calls.length, 1)
  h.spawner.spawned[0]!.settle(0)
  const record = await done
  assert.equal(record.status, 'completed')
  assert.equal(record.trigger, 'manual')
  assert.equal(h.routines.stateValue.lastRunAt['manual-one'], h.now.value)
  await h.dispose()
})

test('scheduler: manual launch of an unknown routine rejects', async () => {
  const h = setup(() => [], {})
  await assert.rejects(() => h.scheduler.launch('missing', 'manual'), /not found/)
  await h.dispose()
})

test('scheduler: deliver chatnode fails soft when no node is installed', async () => {
  const h = setup((cwd) => [routine({ name: 'chatty', deliver: [{ type: 'file' }, { type: 'chatnode' }] }, cwd)], { now: Date.parse('2026-08-14T02:00:30Z') })
  h.routines.stateValue.lastRunAt.chatty = Date.parse('2026-08-13T02:00:00Z')
  h.scheduler.tick()
  h.spawner.spawned[0]!.settle(0)
  const [record] = await waitForRecords(h, 1)
  assert.equal(record.status, 'completed')
  const deliveries = record.deliveries as { type: string; ok: boolean; error?: string }[]
  assert.equal(deliveries.length, 2)
  assert.equal(deliveries[0]!.ok, true)
  assert.equal(deliveries[1]!.type, 'chatnode')
  assert.equal(deliveries[1]!.ok, false)
  assert.match(String(deliveries[1]!.error), /no chatnode/)
  await h.dispose()
})
