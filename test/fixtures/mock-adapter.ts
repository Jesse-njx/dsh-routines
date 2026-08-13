/**
 * E2E mock LLM adapter — registered into a real headless profile so a
 * routine run completes offline against a scripted model. The adapter is a
 * plain object (no `@deepseek-ai` imports), so this fixture is importable by
 * the dsh loader from any profile via absolute path.
 *
 * @module dsh-routines-e2e-mock-adapter
 */

/** Stable Cordis plugin name. */
export const name = 'e2e-mock-adapter'

/** Services required before the adapter can register. */
export const inject = ['llm']

/** Register the `mock` provider adapter. */
export function apply(ctx: { llm: { registerAdapter(providers: string[], adapter: unknown): unknown } }): void {
  const adapter = {
    providerInfo: (provider: string) => ({ id: provider, name: 'E2E Mock' }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [{ provider: 'mock', id: 'mock-model', name: 'Mock Model' }],
    resolveModel: async (provider: string, model: string) => ({
      provider,
      id: model,
      name: 'Mock Model',
      context: { contextWindow: 65536 },
      defaultMaxTokens: 512,
    }),
    async *stream(options: { messages: { content?: { type: string; text?: string }[] }[] }): AsyncGenerator<Record<string, unknown>> {
      const texts = options.messages.flatMap((m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? ''))
      const prompt = texts.join(' ').slice(0, 60)
      const answer = `E2E OK: ${prompt}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
      yield { type: 'finish', reason: 'completed' }
    },
  }
  ctx.llm.registerAdapter(['mock'], adapter)
}
