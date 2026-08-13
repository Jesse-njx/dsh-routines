import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { TimerService } from '@deepseek-ai/cordis-plugin-timer'
import { apply as applyStore } from '../src/store.ts'
import { Scheduler, realSpawn } from '../src/scheduler.ts'
import type { RunRecord } from '../src/types.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-adapter.ts', import.meta.url))
const RUN_MODULE = fileURLToPath(new URL('../src/run.ts', import.meta.url))

/** Resolve the `dsh` CLI binary, or `undefined` when not on PATH. */
function resolveDshBin(): string | undefined {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
  return probe.error === undefined ? 'dsh' : undefined
}

/** Poll the runs dir for a terminal record. */
async function waitForTerminalRecord(runsDir: string, timeoutMs = 60_000): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let files: string[] = []
    try {
      files = readdirSync(runsDir).filter((f) => f.endsWith('.json') && f.startsWith('run-'))
    } catch {
      files = []
    }
    for (const file of files) {
      const record = JSON.parse(readFileSync(join(runsDir, file), 'utf8')) as RunRecord
      if (record.status !== 'running') return record
    }
    if (Date.now() > deadline) throw new Error(`e2e: timed out waiting for a terminal run record in ${runsDir}; files=${JSON.stringify(files)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

test('e2e: a fixture routine runs through a real headless subprocess against a mock model', { timeout: 120_000 }, async (t) => {
  const dshBin = resolveDshBin()
  if (dshBin === undefined) {
    t.skip('the real `dsh` CLI is not on PATH; install @deepseek-ai/dsh to run the end-to-end test')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'dsh-routines-e2e-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dsh-routines-e2e-proj-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  try {
    // 1. A real profile named "e2e" under the temp DSH_HOME: base + headless,
    //    patched with the mock adapter and a mock default model.
    const profileDir = join(home, 'profiles', 'e2e')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'e2e-profile',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
    }, null, 2) + '\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: e2e-mock',
      `      name: ${JSON.stringify(FIXTURE)}`,
      '- id: agent-default-model',
      '  config:',
      '    provider: mock',
      '    model: mock-model',
      '',
    ].join('\n'))

    // 2. A project with one fixture routine.
    const routinesDir = join(project, '.dsh', 'routines')
    mkdirSync(routinesDir, { recursive: true })
    writeFileSync(join(routinesDir, 'nightly.yaml'), [
      'name: nightly',
      'schedule: "@hourly"',
      'profile: e2e',
      'prompt: "run the e2e tests"',
      '',
    ].join('\n'))

    // 3. Boot the store + scheduler in-process with the REAL spawner.
    new TimerService(ctx)
    new LocalJobRegistry(ctx, {})
    ctx.jobs.attachController('test')
    applyStore(ctx, { projectDir: project, globalDir: join(home, 'routines'), watch: false })
    const scheduler = new Scheduler(ctx, ctx.routines!, {
      tickIntervalMs: 30_000,
      maxRunsPerTick: 4,
      killGraceMs: 10_000,
      dshBin,
      runModule: RUN_MODULE,
      digestMaxChars: 2000,
      summaryMaxChars: 24000,
      summaryMaxTokens: 400,
      summaryTimeoutMs: 60_000,
      now: () => Date.now(),
      spawn: (spec) => realSpawn(spec),
    })
    // The routine was due an hour ago: the tick must fire exactly one run.
    ctx.routines!.setState((s) => { s.lastRunAt.nightly = Date.now() - 61 * 60_000 })
    scheduler.tick()

    // 4. Wait for the real subprocess to finish and write the run record.
    const runsDir = join(project, '.dsh', 'routines', 'runs')
    const record = await waitForTerminalRecord(runsDir)
    assert.equal(record.status, 'completed')
    assert.equal(record.routine, 'nightly')
    assert.equal(record.profile, 'e2e')
    assert.equal(record.exitCode, 0)
    assert.ok(record.sessionId, 'the run must record its session id')
    assert.match(record.digest ?? '', /E2E OK: run the e2e tests/, 'the digest must come from the mock model via the real subprocess')
    const digestMd = join(runsDir, `${record.runId}.md`)
    assert.ok(existsSync(digestMd), 'the digest markdown file must exist')

    // 5. No backlog replay: another tick must not fire again.
    const before = readdirSync(runsDir).filter((f) => f.endsWith('.json')).length
    scheduler.tick()
    assert.equal(readdirSync(runsDir).filter((f) => f.endsWith('.json')).length, before)

    await ctx.fiber.dispose()
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
