import { Context } from 'cordis'
import { expect, it } from 'vitest'

import { ComemEngine, MemoryComemStore, archiveSession } from '#src/index'

it('archives through the real workspace registry seam before compacting', async () => {
  const ctx = new Context()
  const archived: string[] = []
  ctx.provide('workspaceRegistry', {
    archiveSession: (id: string) => {
      archived.push(id)
      return Promise.resolve()
    },
  })
  ctx.provide('comemArchiveProvider', {
    compactSession: () =>
      Promise.resolve({ workspaceId: 'ws', content: 'archived' }),
  })
  const engine = new ComemEngine({ store: new MemoryComemStore() })
  await archiveSession(ctx, engine, 'session-1')
  expect(archived).toStrictEqual(['session-1'])
  expect(
    engine.snapshot().mem.some((item) => item.source.kind === 'archive'),
  ).toBeTruthy()
})

it('persists native failed observations for restart recovery', async () => {
  const store = new MemoryComemStore()
  const engine = new ComemEngine({ store })
  await engine.observeNative({
    id: 'native-observation:c-1',
    compactionId: 'c-1',
    workspaceId: 'ws',
    status: 'failed',
    error: 'provider failed',
  })
  const reopened = new ComemEngine({ store })
  await reopened.waitReady()
  expect(reopened.snapshot().observations).toMatchObject([
    { compactionId: 'c-1', status: 'failed', error: 'provider failed' },
  ])
})
