/**
 * Digest construction for routine runs. Pure helpers with no imports beyond
 * Node builtins — the run module runs inside a one-shot subprocess where
 * only injected services are guaranteed resolvable.
 *
 * @module @dsh-routines/bundle/digest
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DeniedApproval } from './types.ts'

/** Byte cap on the session-log text handed to the summarizer. */
export const DEFAULT_SUMMARY_MAX_CHARS = 24_000
/** A last assistant message at or below this many chars is the digest as-is. */
export const DEFAULT_DIGEST_MAX_CHARS = 2_000
/** Output-token cap for the one-shot summarizer call. */
export const DEFAULT_SUMMARY_MAX_TOKENS = 400
/** End-to-end deadline for the summarizer call. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 60_000

/** The last assistant text and turn outcome since `firstSeq` (headless semantics). */
export function summarizeEvents(events: readonly SessionEvent[], firstSeq: number): { text: string; reason: { kind: string } | undefined } {
  let started = false
  let text = ''
  let reason: { kind: string } | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** The bounded user/assistant transcript of a run, for the summarizer. */
export function transcriptOf(events: readonly SessionEvent[], firstSeq: number, maxChars: number): string {
  const lines: string[] = []
  let total = 0
  for (const event of events) {
    if (event.seq < firstSeq) continue
    let text = ''
    let role: 'USER' | 'ASSISTANT'
    if (event.type === 'user/message') {
      text = event.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      role = 'USER'
    } else if (event.type === 'assistant/message') {
      text = event.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      role = 'ASSISTANT'
    } else {
      continue
    }
    if (text === '') continue
    const line = `${role}: ${text}`
    if (total + line.length > maxChars) {
      lines.push(line.slice(0, Math.max(0, maxChars - total)))
      break
    }
    lines.push(line)
    total += line.length
  }
  return lines.join('\n')
}

/** Collect permission requests auto-denied under the unattended `never` policy. */
export function deniedApprovalsOf(events: readonly SessionEvent[]): DeniedApproval[] {
  // The approval audit events are declared by dsh-user-approval's module
  // augmentation; this module reads them by their string event names.
  const widened = events as readonly { type: string; data: Record<string, unknown> }[]
  const asked = new Map<string, { id: string; toolName: string; reason?: string }>()
  const decided = new Map<string, string>()
  for (const event of widened) {
    if (event.type === 'approval/asked') {
      const data = event.data as unknown as { id: string; toolName: string; reason?: string }
      asked.set(data.id, data)
    } else if (event.type === 'approval/decided') {
      const data = event.data as unknown as { id: string; outcome: string }
      decided.set(data.id, data.outcome)
    }
  }
  const denied: DeniedApproval[] = []
  for (const [id, a] of asked) {
    if (decided.get(id) !== 'allowed-once') denied.push({ toolName: a.toolName, reason: a.reason })
  }
  return denied
}

/** Truncate text to `max` chars with an explicit ellipsis marker. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Recursively freeze a plain value (message/options safety). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** The summarizer system prompt (stable). */
export const SUMMARY_SYSTEM = [
  'You summarize agent runs for a busy operator. You receive the transcript of one unattended run',
  '(user prompts and assistant replies) and must produce a digest the operator can act on.',
  'Rules: at most 10 lines; state what was done and what still needs attention;',
  'keep concrete details (paths, names, numbers); no greetings, no filler, no markdown headers.',
].join(' ')
