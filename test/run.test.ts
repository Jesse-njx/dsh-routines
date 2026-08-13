import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { internals, apply as applyRun } from '../src/run.ts'
import type { Config as RunConfig } from '../src/run.ts'
import type { RunRecord } from '../src/types.ts'

/** Capture run stdout/stderr for all tests in this file. */
const runOutput: string[] = []
internals.stdout = { write: (chunk: string) => { runOutput.push(chunk) } }
internals.stderr = { write: (chunk: string) => { runOutput.push(chunk) } }

/** Build a session event with the fields digest/run consume. */
function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, data, seq, time: Date.now() } as unknown as SessionEvent
}

function assistantMessage(text: string, seq: number): SessionEvent {
  return ev('assistant/message', { turn: 1, step: 1, message: { id: `m-${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'mock', model: 'mock-model' } } }, seq)
}

/** A scripted agent that "completes" its turn on the second whenIdle. */
class FakeAgent {
  ran = false
  followupMessage: unknown
  session = {
    id: 'session-e2e' as SessionId,
    seq: 10,
    events: [] as SessionEvent[],
  }
  private readonly script: SessionEvent[]
  constructor(script: SessionEvent[]) {
    this.script = script
  }
  async whenIdle(): Promise<void> {
    if (this.ran) return
    this.ran = true
    this.session.events.push(...this.script)
  }
  followup(message: unknown): void {
    this.followupMessage = message
  }
}

interface MockServices {
  ctx: Context
  exitCode: Promise<number>
  llmCalls: number
  resolveExit: (code: number) => void
  agent: FakeAgent
}

function setupRun(script: SessionEvent[], config: Partial<RunConfig> = {}, llmStream?: AsyncGenerator<{ type: string; text?: string; reason?: string }>): MockServices {
  const ctx = new Context()
  let resolveExit!: (code: number) => void
  const exitCode = new Promise<number>((resolve) => { resolveExit = resolve })
  const agent = new FakeAgent(script)
  const llmCalls = { count: 0 }
  ctx.provide('appExit', resolveExit)
  ctx.provide('loader', { await: async () => {} })
  ctx.provide('agents', {
    create: async () => ({ agent }),
  })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock-model' }),
  })
  ctx.provide('sessions', { flush: async () => {} })
  ctx.provide('llm', {
    stream: () => {
      llmCalls.count += 1
      return llmStream ?? defaultSummaryStream()
    },
  })
  const recordPath = join(mkdtempSync(join(tmpdir(), 'dsh-routines-run-')), 'record.json')
  ctx.provide('routinesRunRecordPath', recordPath)
  applyRun(ctx, { task: 'run the tests', runRecord: recordPath, routine: 'nightly', runId: 'run-1', ...config })
  return { ctx, exitCode, llmCalls, resolveExit, agent }
}

async function* defaultSummaryStream(): AsyncGenerator<{ type: string; text?: string; reason?: string }> {
  yield { type: 'text-delta', text: 'SUMMARY RESULT' }
  yield { type: 'finish', reason: 'completed' }
}

const completedScript = [
  ev('turn/start', {}, 10),
  assistantMessage('tests passed: 42/42 green', 11),
  ev('turn/end', { reason: { kind: 'completed' } }, 12),
]

const deniedScript = [
  ev('turn/start', {}, 10),
  assistantMessage('short answer', 11),
  ev('approval/asked', { id: 'a1', toolName: 'write_file', reason: 'edit config' }, 12),
  ev('approval/decided', { id: 'a1', outcome: 'rejected' }, 13),
  ev('approval/asked', { id: 'a2', toolName: 'bash', reason: 'run tests' }, 14),
  ev('approval/decided', { id: 'a2', outcome: 'allowed-once' }, 15),
  ev('turn/end', { reason: { kind: 'completed' } }, 16),
]

test('run: completes a short run, writes the record and digest file', async () => {
  const h = setupRun(completedScript)
  const code = await h.exitCode
  assert.equal(code, 0)
  const path = h.ctx.get('routinesRunRecordPath') as string
  const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  assert.equal(record.status, 'completed')
  assert.equal(record.routine, 'nightly')
  assert.equal(record.digest, 'tests passed: 42/42 green')
  assert.equal(record.sessionId, 'session-e2e')
  assert.equal(record.exitCode, 0)
  assert.ok((record.durationMs ?? 0) >= 0)
  // The digest markdown sits next to the record.
  const md = readFileSync(path.replace(/\.json$/, '.md'), 'utf8')
  assert.match(md, /# dsh-routines digest — nightly/)
  assert.match(md, /tests passed: 42\/42 green/)
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('run: a long last message is summarized through the mock model', async () => {
  const long = 'x'.repeat(3000)
  const h = setupRun([
    ev('turn/start', {}, 10),
    assistantMessage(long, 11),
    ev('turn/end', { reason: { kind: 'completed' } }, 12),
  ])
  const code = await h.exitCode
  assert.equal(code, 0)
  assert.equal(h.llmCalls.count, 1, 'the summarizer must be called for a long message')
  const path = h.ctx.get('routinesRunRecordPath') as string
  const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  assert.equal(record.digest, 'SUMMARY RESULT')
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('run: a failing summarizer falls back to a truncated head', async () => {
  async function* throwingStream(): AsyncGenerator<never> {
    throw new Error('provider down')
  }
  const h = setupRun([
    ev('turn/start', {}, 10),
    assistantMessage('z'.repeat(3000), 11),
    ev('turn/end', { reason: { kind: 'completed' } }, 12),
  ], {}, throwingStream())
  const code = await h.exitCode
  assert.equal(code, 0)
  const path = h.ctx.get('routinesRunRecordPath') as string
  const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  assert.match(record.digest ?? '', /truncated/)
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('run: auto-denied approvals are collected into the record', async () => {
  const h = setupRun(deniedScript)
  await h.exitCode
  const path = h.ctx.get('routinesRunRecordPath') as string
  const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  assert.deepEqual(record.denied, [{ toolName: 'write_file', reason: 'edit config' }])
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('run: an error turn marks the run failed and exits 1', async () => {
  const h = setupRun([
    ev('turn/start', {}, 10),
    ev('turn/end', { reason: { kind: 'error', error: { code: 'MODEL_ERROR', message: 'boom' } } }, 11),
  ])
  const code = await h.exitCode
  assert.equal(code, 1)
  const path = h.ctx.get('routinesRunRecordPath') as string
  const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  assert.equal(record.status, 'failed')
  assert.match(record.error ?? '', /boom/)
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('run: without a run record it degrades to plain headless output', async () => {
  const h = setupRun(completedScript, {})
  const code = await h.exitCode
  assert.equal(code, 0)
  assert.ok(runOutput.join('').includes('tests passed: 42/42 green'))
})
