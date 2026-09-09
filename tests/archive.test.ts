import { Context } from 'cordis'
import { expect, it, vi } from 'vitest'

import {
  ComemEngine,
  Config,
  MemoryComemStore,
  apply,
  archiveSession,
  inject,
  name,
} from '#src/index'

import { createTestStorageDomain } from './harness.ts'

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

it('writes no observation marker for a completed compaction', async () => {
  const store = new MemoryComemStore()
  const engine = new ComemEngine({ store })
  await engine.observeNative({
    id: 'native-observation:c-2',
    compactionId: 'c-2',
    workspaceId: 'ws',
    status: 'complete',
  })
  expect(engine.snapshot().observations).toStrictEqual([])
  expect(
    (await store.read()).some((event) => event.type === 'observation'),
  ).toBe(false)
})

it('prunes a settled compaction observation from storage', async () => {
  const store = new MemoryComemStore()
  const engine = new ComemEngine({ store })
  await engine.observeNative({
    id: 'native-observation:c-3',
    compactionId: 'c-3',
    workspaceId: 'ws',
    status: 'pending',
    sequence: 7,
  })
  expect(engine.snapshot().observations).toHaveLength(1)
  await engine.pruneObservation('native-observation:c-3')
  expect(engine.snapshot().observations).toStrictEqual([])
  expect(
    (await store.read()).some((event) => event.type === 'observation'),
  ).toBe(false)
})

it('compacts a session when the workspace registry archives it', async () => {
  const ctx = new Context()
  ctx.provide('storageDomain', createTestStorageDomain().service)
  const archiveCalls: string[] = []
  ctx.provide('workspaceRegistry', {
    archivedSessionIds: [] as readonly string[],
    archiveSession: (id: string) => {
      archiveCalls.push(id)
      return Promise.resolve()
    },
  })
  ctx.provide('sessions', {
    get: (id: string) =>
      id === 'session-archived-1'
        ? {
            header: { cwd: 'ws' },
            requestHeader: () => ({
              config: { provider: 'test', model: 'test-model' },
            }),
            deriveMessages: () => [
              { role: 'user', content: 'archived conversation body' },
            ],
          }
        : undefined,
  })
  ctx.provide('llm', {
    stream: async function* () {
      yield { type: 'text-delta', text: 'archived summary' }
    },
  })

  await ctx.plugin({ Config, apply, inject, name })
  const engine = ctx.get('comem')
  if (engine === undefined) throw new Error('comem engine service is missing')
  ctx.emit('domain/changed', {
    domain: 'workspace',
    table: '',
    key: '',
    operation: 'put',
    value: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: ['session-archived-1'],
    },
  })

  await vi.waitFor(async () => {
    expect((await engine.search('archived summary')).length).toBeGreaterThan(0)
  })
  expect(archiveCalls).toStrictEqual(['session-archived-1'])
})

it('drops legacy completed observation records on restart', async () => {
  const store = new MemoryComemStore()
  await store.append({
    type: 'observation',
    observation: {
      id: 'native-observation:c-4',
      compactionId: 'c-4',
      workspaceId: 'ws',
      status: 'complete',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  })
  const reopened = new ComemEngine({ store })
  await reopened.waitReady()
  expect(reopened.snapshot().observations).toStrictEqual([])
  expect(
    (await store.read()).some((event) => event.type === 'observation'),
  ).toBe(false)
})
