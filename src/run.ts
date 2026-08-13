/**
 * routines-run — the child-side driver executed inside each one-shot run
 * subprocess. The scheduler replaces the `headless-runner` row with this
 * module in a generated `--patch` overlay, so a run drives one fresh Agent
 * (full session log = full audit, replay-able later by dsh-replay) and then
 * writes the run record: status, digest, session id, and auto-denied
 * permission requests.
 *
 * Resolution constraint: this module is imported by absolute path from
 * whatever profile the run boots, so it imports ONLY Node builtins at
 * runtime. Every capability arrives through injected services (`agents`,
 * `sessions`, `agentDefaultModel`, `llm`, `headlessStartup`); all
 * `@deepseek-ai` imports below are type-only and erased at build time.
 *
 * With no run context (no `runRecord` in config) it degrades to plain
 * headless behavior: drive the task, print the final assistant text, exit.
 *
 * @module @dsh-routines/bundle/run
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { RunRecord, DeniedApproval } from './types.ts'
import {
  DEFAULT_DIGEST_MAX_CHARS,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_MAX_TOKENS,
  DEFAULT_SUMMARY_TIMEOUT_MS,
  SUMMARY_SYSTEM,
  deepFreeze,
  deniedApprovalsOf,
  summarizeEvents,
  transcriptOf,
  truncate,
} from './digest.ts'

/** Stable Cordis plugin name. */
export const name = 'routines-run'

/** Core services required before the one-shot turn can start. */
export const inject = ['loader', 'agents', 'agentDefaultModel', 'sessions', 'llm', 'headlessStartup']

/** Plugin config: the task plus the optional run-record context. */
export interface Config {
  /** The prompt text for the single run. */
  task: string
  /** Absolute path of the run record JSON the scheduler opened. */
  runRecord?: string
  /** Routine name, recorded with the digest. */
  routine?: string
  /** Run id, recorded with the digest. */
  runId?: string
  /** A last assistant message longer than this is summarized instead. */
  digestMaxChars?: number
  /** Byte cap on the transcript handed to the summarizer. */
  summaryMaxChars?: number
  /** Output-token cap for the summarizer call. */
  summaryMaxTokens?: number
  /** End-to-end summarizer deadline in ms. */
  summaryTimeoutMs?: number
}

/** Process-facing effects of one run; tests substitute captures. */
interface RunIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: Pick<RunIo, 'stdout' | 'stderr'> = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: RunIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/** Read the scheduler-opened record, tolerating absence. */
function readRecord(path: string | undefined): RunRecord | undefined {
  if (path === undefined) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  } catch {
    return undefined
  }
}

/** Atomically update the run record. */
function writeRecordFile(path: string | undefined, record: RunRecord): void {
  if (path === undefined) return
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/** Write the human-readable digest file next to the record. */
function writeDigestMd(recordPath: string | undefined, record: RunRecord): void {
  if (recordPath === undefined) return
  const md = [
    `# dsh-routines digest — ${record.routine}`,
    '',
    `- run: ${record.runId}`,
    `- status: ${record.status}`,
    ...(record.sessionId !== undefined ? [`- session: ${record.sessionId}`] : []),
    `- started: ${new Date(record.startedAt).toISOString()}`,
    ...(record.finishedAt !== undefined ? [`- finished: ${new Date(record.finishedAt).toISOString()}`] : []),
    ...(record.durationMs !== undefined ? [`- duration: ${record.durationMs} ms`] : []),
    '',
    record.digest ?? '',
    '',
  ].join('\n')
  try {
    writeFileSync(`${recordPath.replace(/\.json$/, '')}.md`, md, 'utf8')
  } catch {
    // the digest file is a convenience; a failure must not fail the run
  }
}

/** Install the selected provider/model into the agent context (mini installModelSelection). */
function installModelSelection(agentCtx: Context, selection: { provider: string; model: string }): () => void {
  const selected = { current: selection }
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const current = selected.current
    if (current === undefined) return assembled
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: current.provider, model: current.model },
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const current = selected.current
    if (current === undefined) return resolved
    const { reasoningEffort: _inherited, ...without } = resolved
    return { ...without, provider: current.provider, model: current.model }
  })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}

/** One-shot summarizer call over the run transcript; `undefined` on any failure. */
async function summarizeTranscript(
  ctx: Context,
  transcript: string,
  selection: { provider: string; model: string },
  config: Config,
  sessionId: SessionId,
): Promise<string | undefined> {
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined
  const timeoutMs = config.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  const options: GenerateOptions = deepFreeze({
    provider: selection.provider,
    model: selection.model,
    messages: [{
      id: randomUUID() as MessageId,
      role: 'user',
      content: [{ type: 'text', text: transcript }],
      source: { kind: 'plugin', plugin: 'dsh-routines' },
    }],
    system: SUMMARY_SYSTEM,
    maxTokens: config.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
    sessionId,
    signal,
  })
  let text = ''
  try {
    for await (const chunk of llm.stream(options)) {
      signal.throwIfAborted()
      if (chunk.type === 'text-delta') text += chunk.text
    }
  } catch {
    return undefined
  }
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Run one task through a freshly created Agent, then write the run record. */
async function run(ctx: Context, config: Config, io: RunIo): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    throw new Error('routines-run: missing core services (agents, agentDefaultModel, sessions)')
  }
  const recordPath = config.runRecord
  const existing = readRecord(recordPath)
  const startedAt = existing?.startedAt ?? Date.now()
  const selection = defaultModel.currentSelection()

  let record: RunRecord = {
    runId: config.runId ?? existing?.runId ?? `run-${startedAt}`,
    routine: config.routine ?? existing?.routine ?? '(unknown)',
    profile: existing?.profile ?? '',
    cwd: existing?.cwd ?? process.cwd(),
    status: 'running',
    trigger: existing?.trigger ?? 'manual',
    startedAt,
  }

  const { agent } = await agents.create({
    sessionId: `session-${randomUUID()}` as SessionId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx: Context) => {
      installModelSelection(agentCtx, selection)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(deepFreeze<UserMessage>({
    id: randomUUID() as MessageId,
    role: 'user',
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  const outcome = summarizeEvents(agent.session.events, firstSeq)
  const finishedAt = Date.now()
  const completed = outcome.reason?.kind === 'completed'
  const digestMaxChars = config.digestMaxChars ?? DEFAULT_DIGEST_MAX_CHARS

  let digest: string
  let summarized = false
  if (outcome.text !== '' && outcome.text.length <= digestMaxChars) {
    digest = outcome.text
  } else if (outcome.text !== '') {
    const transcript = transcriptOf(agent.session.events, firstSeq, config.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS)
    const summary = await summarizeTranscript(ctx, transcript, selection, config, agent.session.id)
    if (summary !== undefined) {
      digest = summary
      summarized = true
    } else {
      digest = `${truncate(outcome.text, digestMaxChars)}\n\n(truncated: the summary call failed, so this is the head of the last assistant message)`
    }
  } else {
    digest = '(no assistant output)'
  }

  const denied: DeniedApproval[] = deniedApprovalsOf(agent.session.events)
  record = {
    ...record,
    status: completed ? 'completed' : 'failed',
    finishedAt,
    durationMs: finishedAt - startedAt,
    exitCode: completed ? 0 : 1,
    sessionId: agent.session.id,
    digest,
    denied,
    error: completed ? record.error : (outcome.reason as { error?: { message?: string } } | undefined)?.error?.message ?? 'run ended without completion',
  }
  writeRecordFile(recordPath, record)
  writeDigestMd(recordPath, record)

  io.stdout.write(outcome.text + (summarized ? `\n\n<!-- dsh-routines: summarized -->` : '') + '\n')
  io.exit(completed ? 0 : 1)
}

/**
 * Mount the one-shot run driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated run config.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('routines-run: the launcher must provide ctx.appExit before the tree mounts')
  const io: RunIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  run(ctx, config, io).catch((error) => fail(io, error))
}
