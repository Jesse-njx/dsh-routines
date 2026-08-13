import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { TimerService } from '@deepseek-ai/cordis-plugin-timer'
import { apply, parseRoutineFile, resolveRoutine } from '../src/store.ts'
import type { Routine } from '../src/types.ts'

test('store: parseRoutineFile accepts a valid routine and applies schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-routines-store-'))
  const file = join(dir, 'r.yaml')
  writeFileSync(file, [
    'name: nightly-tests',
    'schedule: "0 2 * * *"',
    'timezone: Asia/Shanghai',
    'prompt: |',
    '  Run the test suite.',
    'cwd: ~/work/projectx',
    'overlap: queue',
    'timeoutMin: 45',
    'deliver:',
    '  - type: file',
    '  - type: chatnode',
    '',
  ].join('\n'), 'utf8')
  const parsed = parseRoutineFile(file)
  assert.equal(typeof parsed, 'object')
  const raw = parsed as { name: string; schedule: string; timezone: string; overlap: string; timeoutMin: number; deliver: { type: string }[] }
  assert.equal(raw.name, 'nightly-tests')
  assert.equal(raw.timezone, 'Asia/Shanghai')
  assert.equal(raw.overlap, 'queue')
  assert.equal(raw.deliver.length, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('store: parseRoutineFile reports bad YAML, non-mappings, and schema errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-routines-store-'))
  const badYaml = join(dir, 'bad.yaml')
  writeFileSync(badYaml, 'name: [unclosed\n', 'utf8')
  assert.match(String(parseRoutineFile(badYaml)), /invalid YAML/)

  const list = join(dir, 'list.yaml')
  writeFileSync(list, '- a\n- b\n', 'utf8')
  assert.match(String(parseRoutineFile(list)), /mapping/)

  const missing = join(dir, 'missing.yaml')
  writeFileSync(missing, 'name: x\n', 'utf8') // schedule + prompt required
  assert.match(String(parseRoutineFile(missing)), /invalid routine/)

  rmSync(dir, { recursive: true, force: true })
})

test('store: resolveRoutine validates names, zones, schedules, and applies defaults', () => {
  const ok = resolveRoutine(
    { name: 'nightly', schedule: '0 2 * * *', timezone: 'UTC', prompt: 'go', profile: 'headless', overlap: 'skip', timeoutMin: 45, deliver: [{ type: 'file' }] },
    'project',
    '/x/nightly.yaml',
    '/proj',
  )
  assert.equal('error' in ok, false)
  const routine = ok as Routine
  assert.equal(routine.cwd, '/proj') // cwd defaults to the project dir
  assert.equal(routine.timezone, 'UTC')
  assert.equal(routine.profile, 'headless')

  assert.ok('error' in resolveRoutine({ ...base('Bad_Name') }, 'project', '/x', '/proj'))
  assert.ok('error' in resolveRoutine({ ...base('x'), timezone: 'Not/AZone' }, 'project', '/x', '/proj'))
  assert.ok('error' in resolveRoutine({ ...base('x'), schedule: 'not a cron' }, 'project', '/x', '/proj'))
  assert.ok('error' in resolveRoutine({ ...base('x'), timeoutMin: 0 }, 'project', '/x', '/proj'))

  const tilde = resolveRoutine({ ...base('tilde'), cwd: '~/work' }, 'project', '/x', '/proj')
  assert.equal('error' in tilde, false)
  assert.ok((tilde as Routine).cwd.includes('work'))
})

function base(name: string) {
  return { name, schedule: '0 2 * * *', timezone: 'UTC', prompt: 'go', profile: 'headless', overlap: 'skip' as const, timeoutMin: 45, deliver: [{ type: 'file' as const }] }
}

function setupStore(projectDir: string, globalDir: string) {
  const ctx = new Context()
  new TimerService(ctx)
  apply(ctx, { projectDir, globalDir, watch: false })
  return ctx
}

test('store: loads project and global routines, project wins on name conflict', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-routines-store-'))
  const projectDir = join(base, 'proj')
  const globalDir = join(base, 'global')
  mkdirSync(join(projectDir, '.dsh', 'routines'), { recursive: true })
  mkdirSync(globalDir, { recursive: true })
  writeFileSync(join(projectDir, '.dsh', 'routines', 'nightly.yaml'), 'name: nightly\nschedule: "0 2 * * *"\nprompt: project version\n', 'utf8')
  writeFileSync(join(globalDir, 'nightly.yaml'), 'name: nightly\nschedule: "0 2 * * *"\nprompt: global version\n', 'utf8')
  writeFileSync(join(globalDir, 'weekly.yaml'), 'name: weekly\nschedule: "@daily"\nprompt: global weekly\n', 'utf8')
  writeFileSync(join(projectDir, '.dsh', 'routines', 'broken.yaml'), 'name: [broken\n', 'utf8')

  const ctx = setupStore(projectDir, globalDir)
  const names = ctx.routines!.list().map((r) => r.name)
  assert.deepEqual(names, ['nightly', 'weekly'])
  assert.equal(ctx.routines!.get('nightly')!.prompt, 'project version')
  assert.equal(ctx.routines!.get('nightly')!.source, 'project')
  assert.equal(ctx.routines!.get('weekly')!.source, 'global')
  assert.equal(ctx.routines!.invalid().length, 1)
  assert.match(ctx.routines!.invalid()[0]!.error, /invalid YAML/)
  rmSync(base, { recursive: true, force: true })
})

test('store: pause state persists to the state file and survives reload', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-routines-store-'))
  const projectDir = join(base, 'proj')
  const globalDir = join(base, 'global')
  mkdirSync(join(projectDir, '.dsh', 'routines'), { recursive: true })
  writeFileSync(join(projectDir, '.dsh', 'routines', 'nightly.yaml'), 'name: nightly\nschedule: "@daily"\nprompt: go\n', 'utf8')

  const ctx = setupStore(projectDir, globalDir)
  assert.equal(ctx.routines!.get('nightly')!.paused, false)
  ctx.routines!.setState((s) => { s.paused.push('nightly') })
  assert.equal(ctx.routines!.get('nightly')!.paused, true)

  // A fresh store over the same dirs reads the persisted pause.
  const ctx2 = setupStore(projectDir, globalDir)
  assert.equal(ctx2.routines!.get('nightly')!.paused, true)
  ctx2.routines!.setState((s) => { s.paused = [] })
  rmSync(base, { recursive: true, force: true })
})

test('store: lastRunAt bookkeeping survives reload', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-routines-store-'))
  const projectDir = join(base, 'proj')
  const globalDir = join(base, 'global')
  mkdirSync(join(projectDir, '.dsh', 'routines'), { recursive: true })
  writeFileSync(join(projectDir, '.dsh', 'routines', 'nightly.yaml'), 'name: nightly\nschedule: "@daily"\nprompt: go\n', 'utf8')
  const ctx = setupStore(projectDir, globalDir)
  ctx.routines!.setState((s) => { s.lastRunAt.nightly = 12345 })
  const ctx2 = setupStore(projectDir, globalDir)
  assert.equal(ctx2.routines!.state().lastRunAt.nightly, 12345)
  rmSync(base, { recursive: true, force: true })
})
