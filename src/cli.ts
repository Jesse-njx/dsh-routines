/**
 * routines-cli — `dsh routines list | run <name> | pause <name> |
 * resume <name> | logs <name>`, parsed from the launcher's immutable
 * command-line snapshot. With no inner arguments the command stays silent and
 * the process stays alive — that is daemon mode, where the scheduler ticks.
 *
 * @module @dsh-routines/bundle/cli
 */

import type { Context } from '@deepseek-ai/cordis'
import { Command } from 'commander'
import { internals as cmdlineInternals } from '@deepseek-ai/dsh-cmdline'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { nextAfter, parseSchedule } from './cron.ts'
import { readRecord, runsDirFor } from './run-record.ts'
import type { Routine, RoutinesSchedulerService, RoutinesService, RunRecord } from './types.ts'

/** The process streams the CLI writes to; tests substitute captures. */
export const internals: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Write one line to the CLI stdout. */
function print(line = ''): void {
  internals.stdout.write(line + '\n')
}

/** Write one line to the CLI stderr. */
function printError(line: string): void {
  internals.stderr.write(line + '\n')
}

/** Stable Cordis plugin name. */
export const name = 'routines-cli'

/** Services required before the command line can be parsed. */
export const inject = ['cmdlineArgs', 'routines', 'routinesScheduler']

/** Build the commander program for this app. */
function buildProgram(ctx: Context): Command {
  const routines = ctx.get('routines')
  const scheduler = ctx.get('routinesScheduler')
  const exit = ctx.get('appExit')
  if (routines === undefined || scheduler === undefined || exit === undefined) {
    throw new Error('routines-cli: missing services (routines, routinesScheduler, appExit)')
  }

  const program = new Command()
    .name('dsh routines')
    .description('Manage scheduled routines: list, run, pause, resume, logs')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Examples:
  dsh --profile routines routines list
  dsh --profile routines routines run nightly-tests
  dsh --profile routines routines pause nightly-tests
  dsh --profile routines routines logs nightly-tests --limit 5
`)

  program
    .command('list')
    .description('list routines with schedule, pause state, and next run time')
    .action(() => {
      printList(routines, scheduler)
      exit(0)
    })

  program
    .command('run')
    .description('run a routine now (manual trigger)')
    .argument('<name>', 'routine name')
    .action((name: string) => {
      void runNow(routines, scheduler, exit, name)
    })

  program
    .command('pause')
    .description('pause a routine (scheduled runs stop)')
    .argument('<name>', 'routine name')
    .action((name: string) => {
      setPaused(routines, exit, name, true)
    })

  program
    .command('resume')
    .description('resume a paused routine')
    .argument('<name>', 'routine name')
    .action((name: string) => {
      setPaused(routines, exit, name, false)
    })

  program
    .command('logs')
    .description('show recent run records for a routine')
    .argument('<name>', 'routine name')
    .option('--limit <n>', 'number of records to show', '10')
    .action((name: string, options: { limit: string }) => {
      printLogs(routines, exit, name, Number(options.limit))
    })

  // Daemon mode: `dsh --profile <name>` with no inner arguments stays alive so
  // scheduled runs fire. The scheduler owns the process lifetime.
  program.action(() => {})

  return program
}

/** Print the routine table plus any invalid files. */
function printList(routines: RoutinesService, scheduler: RoutinesSchedulerService): void {
  const now = Date.now()
  const state = routines.state()
  const running = new Set(scheduler.running())
  for (const routine of routines.list()) {
    const lastRunAt = state.lastRunAt[routine.name] ?? 0
    let next: number | null
    try {
      next = nextAfter(parseSchedule(routine.schedule), lastRunAt === 0 ? now : lastRunAt, routine.timezone)
    } catch {
      next = null
    }
    const status = routine.paused ? 'paused' : running.has(routine.name) ? 'running' : 'active'
    print(
      `${routine.name.padEnd(24)} ${status.padEnd(8)} ${routine.schedule.padEnd(20)} tz=${routine.timezone.padEnd(14)} next=${next === null ? 'never' : new Date(next).toISOString()}`,
    )
  }
  for (const invalid of routines.invalid()) {
    printError(`invalid ${invalid.file}: ${invalid.error}`)
  }
}

/** Run one routine now and print its digest. */
async function runNow(routines: RoutinesService, scheduler: RoutinesSchedulerService, exit: (code: number) => void, name: string): Promise<void> {
  const routine = routines.get(name)
  if (routine === undefined) {
    printError(`dsh routines: routine ${JSON.stringify(name)} not found (run 'dsh routines routines list')`)
    exit(1)
    return
  }
  print(`running ${name} (profile ${routine.profile}, cwd ${routine.cwd})…`)
  try {
    const record = await scheduler.launch(name, 'manual')
    print('')
    print(`status: ${record.status}${record.durationMs !== undefined ? ` in ${record.durationMs} ms` : ''}`)
    if (record.sessionId !== undefined) print(`session: ${record.sessionId}`)
    if (record.denied !== undefined && record.denied.length > 0) {
      print(`auto-denied: ${record.denied.map((d) => d.toolName).join(', ')}`)
    }
    if (record.error !== undefined) print(`error: ${record.error}`)
    if (record.digest !== undefined) print(`--- digest ---\n${record.digest}`)
    exit(record.status === 'completed' ? 0 : 1)
  } catch (error) {
    printError(`dsh routines: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  }
}

/** Pause or resume one routine. */
function setPaused(routines: RoutinesService, exit: (code: number) => void, name: string, paused: boolean): void {
  const routine = routines.get(name)
  if (routine === undefined) {
    printError(`dsh routines: routine ${JSON.stringify(name)} not found`)
    exit(1)
    return
  }
  routines.setState((state) => {
    if (paused) {
      if (!state.paused.includes(name)) state.paused.push(name)
    } else {
      state.paused = state.paused.filter((p) => p !== name)
    }
  })
  print(`routine ${name} ${paused ? 'paused' : 'resumed'}`)
  exit(0)
}

/** Print recent run records for one routine. */
function printLogs(routines: RoutinesService, exit: (code: number) => void, name: string, limit: number): void {
  const routine = routines.get(name)
  if (routine === undefined) {
    printError(`dsh routines: routine ${JSON.stringify(name)} not found`)
    exit(1)
    return
  }
  const records = readRecentRecords(routine)
  if (records.length === 0) {
    print(`no run records for ${name} (${runsDirFor(routine.cwd)})`)
    exit(0)
    return
  }
  for (const record of records.slice(0, Math.max(0, limit))) {
    const started = new Date(record.startedAt).toISOString()
    const duration = record.durationMs !== undefined ? ` ${record.durationMs} ms` : ''
    const session = record.sessionId !== undefined ? ` session=${record.sessionId}` : ''
    print(`[${record.status}] ${started}${duration}${session} ${record.runId}`)
    if (record.error !== undefined) print(`  error: ${record.error}`)
    if (record.digest !== undefined) print(`  ${record.digest.split('\n')[0] ?? ''}`)
  }
  exit(0)
}

/** Read run records newest-first for one routine's cwd. */
export function readRecentRecords(routine: Routine, all = false): RunRecord[] {
  const dir = runsDirFor(routine.cwd)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => statMtime(join(dir, b)) - statMtime(join(dir, a)))
  } catch {
    return []
  }
  const records: RunRecord[] = []
  for (const file of files) {
    if (!all && !file.startsWith('run-')) continue
    const record = readRecord(join(dir, file))
    if (record !== undefined) records.push(record)
  }
  return records
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Mount the CLI: parse the launcher's inner arguments and run the invoked
 * `routines` subcommand.
 *
 * The dsh launcher hands everything after its own flags to the profile, so
 * `dsh --profile ops routines list` arrives as `['routines', 'list']`. Strip
 * the leading `routines` token before commander parses. This mirrors
 * `dsh-cmdline`'s parse contract (exit and output routed through the
 * launcher) but owns its argument snapshot, since the launcher-provided
 * `cmdlineArgs` service cannot be replaced.
 * @param ctx - plugin context carrying the command line, routines, and scheduler services.
 */
export function apply(ctx: Context): void {
  const cmdline = ctx.get('cmdlineArgs')
  const appExit = ctx.get('appExit')
  if (cmdline === undefined || appExit === undefined) {
    throw new Error('routines-cli: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts')
  }
  const raw = cmdline.get()
  const args = raw[0] === 'routines' ? raw.slice(1) : raw
  const program = buildProgram(ctx)
  configureExitAndOutput(program)
  try {
    program.parse([...args], { from: 'user' })
  } catch (error) {
    if (isCommanderError(error)) appExit(error.exitCode)
    else throw error
  }
}

/** Route commander's exit and output through the launcher adapter (mirrors dsh-cmdline). */
function configureExitAndOutput(command: Command): void {
  command.exitOverride().configureOutput({
    writeOut: (text) => void cmdlineInternals.stdout.write(text),
    writeErr: (text) => void cmdlineInternals.stderr.write(text),
  })
  for (const child of command.commands) configureExitAndOutput(child)
}

/** Structural commander control-flow check (mirrors dsh-cmdline). */
function isCommanderError(error: unknown): error is { exitCode: number } {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; exitCode?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('commander.') && typeof candidate.exitCode === 'number'
}
