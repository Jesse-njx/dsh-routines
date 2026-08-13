/**
 * Digest construction for routine runs. Pure helpers with no imports beyond
 * Node builtins — the run module runs inside a one-shot subprocess where
 * only injected services are guaranteed resolvable.
 *
 * @module @dsh-routines/bundle/digest
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { DeniedApproval } from './types.ts';
/** Byte cap on the session-log text handed to the summarizer. */
export declare const DEFAULT_SUMMARY_MAX_CHARS = 24000;
/** A last assistant message at or below this many chars is the digest as-is. */
export declare const DEFAULT_DIGEST_MAX_CHARS = 2000;
/** Output-token cap for the one-shot summarizer call. */
export declare const DEFAULT_SUMMARY_MAX_TOKENS = 400;
/** End-to-end deadline for the summarizer call. */
export declare const DEFAULT_SUMMARY_TIMEOUT_MS = 60000;
/** The last assistant text and turn outcome since `firstSeq` (headless semantics). */
export declare function summarizeEvents(events: readonly SessionEvent[], firstSeq: number): {
    text: string;
    reason: {
        kind: string;
    } | undefined;
};
/** The bounded user/assistant transcript of a run, for the summarizer. */
export declare function transcriptOf(events: readonly SessionEvent[], firstSeq: number, maxChars: number): string;
/** Collect permission requests auto-denied under the unattended `never` policy. */
export declare function deniedApprovalsOf(events: readonly SessionEvent[]): DeniedApproval[];
/** Truncate text to `max` chars with an explicit ellipsis marker. */
export declare function truncate(text: string, max: number): string;
/** Recursively freeze a plain value (message/options safety). */
export declare function deepFreeze<T>(value: T): T;
/** The summarizer system prompt (stable). */
export declare const SUMMARY_SYSTEM: string;
//# sourceMappingURL=digest.d.ts.map