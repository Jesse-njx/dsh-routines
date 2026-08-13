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
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DIGEST_MAX_CHARS, DEFAULT_SUMMARY_MAX_CHARS, DEFAULT_SUMMARY_MAX_TOKENS, DEFAULT_SUMMARY_TIMEOUT_MS, SUMMARY_SYSTEM, deepFreeze, deniedApprovalsOf, summarizeEvents, transcriptOf, truncate, } from "./digest.js";
/** Stable Cordis plugin name. */
export const name = 'routines-run';
/** Core services required before the one-shot turn can start. */
export const inject = ['loader', 'agents', 'agentDefaultModel', 'sessions', 'llm', 'headlessStartup'];
/** The process streams the runner writes to; tests substitute captures. */
export const internals = {
    stdout: process.stdout,
    stderr: process.stderr,
};
/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io, error) {
    io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
    io.exit(1);
}
/** Read the scheduler-opened record, tolerating absence. */
function readRecord(path) {
    if (path === undefined)
        return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Atomically update the run record. */
function writeRecordFile(path, record) {
    if (path === undefined)
        return;
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
}
/** Write the human-readable digest file next to the record. */
function writeDigestMd(recordPath, record) {
    if (recordPath === undefined)
        return;
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
    ].join('\n');
    try {
        writeFileSync(`${recordPath.replace(/\.json$/, '')}.md`, md, 'utf8');
    }
    catch {
        // the digest file is a convenience; a failure must not fail the run
    }
}
/** Install the selected provider/model into the agent context (mini installModelSelection). */
function installModelSelection(agentCtx, selection) {
    const selected = { current: selection };
    const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next();
        const current = selected.current;
        if (current === undefined)
            return assembled;
        return {
            ...assembled,
            variables: { ...assembled.variables, provider: current.provider, model: current.model },
        };
    });
    const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next();
        const current = selected.current;
        if (current === undefined)
            return resolved;
        const { reasoningEffort: _inherited, ...without } = resolved;
        return { ...without, provider: current.provider, model: current.model };
    });
    return () => {
        disposeAssembly();
        disposeRequest();
    };
}
/** One-shot summarizer call over the run transcript; `undefined` on any failure. */
async function summarizeTranscript(ctx, transcript, selection, config, sessionId) {
    const llm = ctx.get('llm');
    if (llm === undefined)
        return undefined;
    const timeoutMs = config.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    const options = deepFreeze({
        provider: selection.provider,
        model: selection.model,
        messages: [{
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: transcript }],
                source: { kind: 'plugin', plugin: 'dsh-routines' },
            }],
        system: SUMMARY_SYSTEM,
        maxTokens: config.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
        sessionId,
        signal,
    });
    let text = '';
    try {
        for await (const chunk of llm.stream(options)) {
            signal.throwIfAborted();
            if (chunk.type === 'text-delta')
                text += chunk.text;
        }
    }
    catch {
        return undefined;
    }
    const trimmed = text.trim();
    return trimmed === '' ? undefined : trimmed;
}
/** Run one task through a freshly created Agent, then write the run record. */
async function run(ctx, config, io) {
    await ctx.get('loader')?.await();
    const agents = ctx.get('agents');
    const defaultModel = ctx.get('agentDefaultModel');
    const sessions = ctx.get('sessions');
    if (agents === undefined || defaultModel === undefined || sessions === undefined) {
        throw new Error('routines-run: missing core services (agents, agentDefaultModel, sessions)');
    }
    const recordPath = config.runRecord;
    const existing = readRecord(recordPath);
    const startedAt = existing?.startedAt ?? Date.now();
    const selection = defaultModel.currentSelection();
    let record = {
        runId: config.runId ?? existing?.runId ?? `run-${startedAt}`,
        routine: config.routine ?? existing?.routine ?? '(unknown)',
        profile: existing?.profile ?? '',
        cwd: existing?.cwd ?? process.cwd(),
        status: 'running',
        trigger: existing?.trigger ?? 'manual',
        startedAt,
    };
    const { agent } = await agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
            installModelSelection(agentCtx, selection);
        },
    });
    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(deepFreeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: config.task }],
        source: { kind: 'user' },
    }));
    await agent.whenIdle();
    await sessions.flush(agent.session);
    const outcome = summarizeEvents(agent.session.events, firstSeq);
    const finishedAt = Date.now();
    const completed = outcome.reason?.kind === 'completed';
    const digestMaxChars = config.digestMaxChars ?? DEFAULT_DIGEST_MAX_CHARS;
    let digest;
    let summarized = false;
    if (outcome.text !== '' && outcome.text.length <= digestMaxChars) {
        digest = outcome.text;
    }
    else if (outcome.text !== '') {
        const transcript = transcriptOf(agent.session.events, firstSeq, config.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS);
        const summary = await summarizeTranscript(ctx, transcript, selection, config, agent.session.id);
        if (summary !== undefined) {
            digest = summary;
            summarized = true;
        }
        else {
            digest = `${truncate(outcome.text, digestMaxChars)}\n\n(truncated: the summary call failed, so this is the head of the last assistant message)`;
        }
    }
    else {
        digest = '(no assistant output)';
    }
    const denied = deniedApprovalsOf(agent.session.events);
    record = {
        ...record,
        status: completed ? 'completed' : 'failed',
        finishedAt,
        durationMs: finishedAt - startedAt,
        exitCode: completed ? 0 : 1,
        sessionId: agent.session.id,
        digest,
        denied,
        error: completed ? record.error : outcome.reason?.error?.message ?? 'run ended without completion',
    };
    writeRecordFile(recordPath, record);
    writeDigestMd(recordPath, record);
    io.stdout.write(outcome.text + (summarized ? `\n\n<!-- dsh-routines: summarized -->` : '') + '\n');
    io.exit(completed ? 0 : 1);
}
/**
 * Mount the one-shot run driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated run config.
 */
export function apply(ctx, config) {
    const exit = ctx.get('appExit');
    if (exit === undefined)
        throw new Error('routines-run: the launcher must provide ctx.appExit before the tree mounts');
    const io = { stdout: internals.stdout, stderr: internals.stderr, exit };
    run(ctx, config, io).catch((error) => fail(io, error));
}
//# sourceMappingURL=run.js.map