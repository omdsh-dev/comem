import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'

import { createComemRuntime } from '#src/index'

import { createTestStorageDomain } from './harness.ts'

describe('comem model source', () => {
  it('uses the current session model when session mode is selected', async () => {
    const ctx = new Context()
    const storage = createTestStorageDomain()
    const requests: { provider?: string; model?: string }[] = []
    const settings = {
      register: vi.fn<
        () => {
          get: () => { source: 'session'; provider: string; model: string }
        }
      >(() => ({
        get: () => ({ source: 'session', provider: '', model: '' }),
      })),
    }
    ctx.provide('storageDomain', storage.service)
    ctx.provide('settings', settings)
    ctx.provide('sessions', {
      get: (sessionId: string) =>
        sessionId === 'session-1'
          ? {
              requestHeader: () => ({
                config: {
                  provider: 'session-provider',
                  model: 'session-model',
                },
              }),
            }
          : undefined,
    })
    ctx.provide('llm', {
      stream: async function* (options: { provider?: string; model?: string }) {
        requests.push(options)
        yield { type: 'text-delta', text: 'compressed' }
      },
    })
    const runtime = await createComemRuntime(ctx, {}, { logicalLayerCap: 1 })
    await runtime.engine.recordCompact({
      operationId: 'session-layer',
      workspaceId: 'ws',
      sessionId: 'session-1',
      content: 'content',
    })
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'session-provider',
          model: 'session-model',
        }),
      ]),
    )
    await runtime.close()
  })
})
