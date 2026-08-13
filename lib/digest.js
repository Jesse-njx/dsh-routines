/**
 * Digest construction for routine runs. Pure helpers with no imports beyond
 * Node builtins — the run module runs inside a one-shot subprocess where
 * only injected services are guaranteed resolvable.
 *
 * @module @dsh-routines/bundle/digest
 */
/** Byte cap on the session-log text handed to the summarizer. */
export const DEFAULT_SUMMARY_MAX_CHARS = 24_000;
/** A last assistant message at or below this many chars is the digest as-is. */
export const DEFAULT_DIGEST_MAX_CHARS = 2_000;
/** Output-token cap for the one-shot summarizer call. */
export const DEFAULT_SUMMARY_MAX_TOKENS = 400;
/** End-to-end deadline for the summarizer call. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 60_000;
/** The last assistant text and turn outcome since `firstSeq` (headless semantics). */
export function summarizeEvents(events, firstSeq) {
    let started = false;
    let text = '';
    let reason;
    for (const event of events) {
        if (event.seq < firstSeq)
            continue;
        if (event.type === 'turn/start') {
            started = true;
            continue;
        }
        if (!started)
            continue;
        if (event.type === 'assistant/message') {
            const joined = event.data.message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('');
            if (joined !== '')
                text = joined;
        }
        if (event.type === 'turn/end')
            reason = event.data.reason;
    }
    return { text, reason };
}
/** The bounded user/assistant transcript of a run, for the summarizer. */
export function transcriptOf(events, firstSeq, maxChars) {
    const lines = [];
    let total = 0;
    for (const event of events) {
        if (event.seq < firstSeq)
            continue;
        let text = '';
        let role;
        if (event.type === 'user/message') {
            text = event.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
            role = 'USER';
        }
        else if (event.type === 'assistant/message') {
            text = event.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
            role = 'ASSISTANT';
        }
        else {
            continue;
        }
        if (text === '')
            continue;
        const line = `${role}: ${text}`;
        if (total + line.length > maxChars) {
            lines.push(line.slice(0, Math.max(0, maxChars - total)));
            break;
        }
        lines.push(line);
        total += line.length;
    }
    return lines.join('\n');
}
/** Collect permission requests auto-denied under the unattended `never` policy. */
export function deniedApprovalsOf(events) {
    // The approval audit events are declared by dsh-user-approval's module
    // augmentation; this module reads them by their string event names.
    const widened = events;
    const asked = new Map();
    const decided = new Map();
    for (const event of widened) {
        if (event.type === 'approval/asked') {
            const data = event.data;
            asked.set(data.id, data);
        }
        else if (event.type === 'approval/decided') {
            const data = event.data;
            decided.set(data.id, data.outcome);
        }
    }
    const denied = [];
    for (const [id, a] of asked) {
        if (decided.get(id) !== 'allowed-once')
            denied.push({ toolName: a.toolName, reason: a.reason });
    }
    return denied;
}
/** Truncate text to `max` chars with an explicit ellipsis marker. */
export function truncate(text, max) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}
/** Recursively freeze a plain value (message/options safety). */
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value))
            deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}
/** The summarizer system prompt (stable). */
export const SUMMARY_SYSTEM = [
    'You summarize agent runs for a busy operator. You receive the transcript of one unattended run',
    '(user prompts and assistant replies) and must produce a digest the operator can act on.',
    'Rules: at most 10 lines; state what was done and what still needs attention;',
    'keep concrete details (paths, names, numbers); no greetings, no filler, no markdown headers.',
].join(' ');
//# sourceMappingURL=digest.js.map