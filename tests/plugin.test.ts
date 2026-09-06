import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'

import { ComemEngine, DomainComemStore, MemoryComemStore } from '#src/index'
import type { ComemModel, ComemModelRequest } from '#src/index'

class RecordingModel implements ComemModel {
  readonly requests: ComemModelRequest[] = []
  compact(request: ComemModelRequest) {
    this.requests.push(request)
    return Promise.resolve({
      content: request.target,
      provider: 'test',
      model: 'test-model',
    })
  }
  summarize(request: ComemModelRequest) {
    this.requests.push(request)
    return Promise.resolve({ content: request.target.slice(0, 20) })
  }
}

describe('comem tree', () => {
  it('creates independent L1 nodes and preserves mem, Record, edge, and abs', async () => {
    const model = new RecordingModel()
    const engine = new ComemEngine({ store: new MemoryComemStore(), model })
    const first = await engine.recordCompact({
      operationId: 'compact-1',
      workspaceId: 'ws',
      sessionId: 's',
      content: 'first',
    })
    const second = await engine.recordCompact({
      operationId: 'compact-2',
      workspaceId: 'ws',
      sessionId: 's',
      content: 'second',
    })
    expect(first.id).not.toBe(second.id)
    const snapshot = engine.snapshot()
    expect(snapshot.nodes.filter((node) => node.layer === 'L1')).toHaveLength(2)
    expect(snapshot.records).toHaveLength(2)
    expect(snapshot.records[0]?.order).toBe(0)
    expect(snapshot.records[1]?.order).toBe(1)
    expect((await engine.open(first.id)).contentType).toBe('abs')
    expect((await engine.open(first.id, 'expand')).mem?.content).toBe('first')
  })

  it('replays current Records and only uses rollover mem for the first Record', async () => {
    const model = new RecordingModel()
    const engine = new ComemEngine({
      store: new MemoryComemStore(),
      model,
      logicalLayerCap: 2,
      physicalCallBudget: 50,
    })
    await engine.recordCompact({
      operationId: 'a',
      workspaceId: 'ws',
      content: 'a',
    })
    await engine.recordCompact({
      operationId: 'b',
      workspaceId: 'ws',
      content: 'b',
    })
    await engine.recordCompact({
      operationId: 'c',
      workspaceId: 'ws',
      content: 'c',
    })
    await engine.recordCompact({
      operationId: 'd',
      workspaceId: 'ws',
      content: 'd',
    })
    const append = model.requests.filter((request) => request.kind === 'append')
    expect(append.find((request) => request.target === 'a')?.background).toBe(
      '',
    )
    expect(
      append.find((request) => request.target === 'a')?.physicalBudget,
    ).toBe(50)
    expect(
      append.find((request) => request.target === 'b')?.background,
    ).toContain('a')
    expect(
      append.find((request) => request.target === 'c')?.background,
    ).toContain('a')
    expect(
      append.find((request) => request.target === 'd')?.background,
    ).toContain('c')
    expect(
      append.find((request) => request.target === 'd')?.background,
    ).not.toContain('a\n')
    const { records } = engine.snapshot()
    expect(
      records.some((record) => record.backgroundKind === 'rollover'),
    ).toBeTruthy()
    expect(
      records.find((record) => record.content === 'd')?.backgroundKind,
    ).toBe('records')
  })

  it('splits oversized replay backgrounds into one merged Record', async () => {
    const model = new RecordingModel()
    const engine = new ComemEngine({
      store: new MemoryComemStore(),
      model,
      logicalLayerCap: 1_000,
      physicalCallBudget: 100,
      tokenEstimator: (value) => Math.ceil(value.length / 4),
    })
    const content = 'piece '.repeat(10)
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        engine.recordCompact({
          operationId: 'budget-' + index,
          workspaceId: 'ws',
          content,
        }),
      ),
    )
    const requests = model.requests.filter(
      (request) => request.kind === 'append' && request.target === content,
    )
    expect(requests.length).toBeGreaterThan(8)
    expect(
      engine
        .snapshot()
        .records.filter((record) => record.childMemRevisionId.includes('L1-8')),
    ).toHaveLength(1)
  })

  it('is idempotent for repeated operation ids and isolates shared notes', async () => {
    const engine = new ComemEngine({ store: new MemoryComemStore() })
    const first = await engine.recordCompact({
      operationId: 'same',
      workspaceId: 'ws',
      content: 'one',
    })
    const again = await engine.recordCompact({
      operationId: 'same',
      workspaceId: 'ws',
      content: 'changed',
    })
    expect(again.id).toBe(first.id)
    await engine.note({
      id: 'note-1',
      workspaceId: 'shared',
      content: 'portable preference',
    })
    expect((await engine.search('portable'))[0]?.contentType).toBe('note')
  })

  it('records archive compacts as independent L1 provenance', async () => {
    const engine = new ComemEngine({ store: new MemoryComemStore() })
    const node = await engine.archiveCompact({
      operationId: 'archive-1',
      workspaceId: 'ws',
      sessionId: 's',
      content: 'archived summary',
    })
    expect(
      engine.snapshot().mem.find((item) => item.nodeId === node.id)?.source
        .kind,
    ).toBe('archive')
  })

  it('uses a storage-domain table with idempotent event keys', async () => {
    const values = new Map<string, import('#src/index').ComemEvent>()
    const domain = {
      table: () => ({
        get: (key: string) => values.get(key),
        entries: () => values.entries(),
        put: (key: string, value: import('#src/index').ComemEvent) => {
          values.set(key, value)
          return Promise.resolve()
        },
      }),
    }
    const store = new DomainComemStore(domain)
    const engine = new ComemEngine({ store })
    await engine.recordCompact({
      operationId: 'domain-1',
      workspaceId: 'ws',
      content: 'domain durable',
    })
    await engine.recordCompact({
      operationId: 'domain-1',
      workspaceId: 'ws',
      content: 'ignored duplicate',
    })
    expect(values.size).toBeGreaterThan(0)
    expect((await engine.search('domain durable')).length).toBe(1)
  })

  it('restores JSONL events into a new engine', async () => {
    const store = new MemoryComemStore()
    const first = new ComemEngine({ store })
    await first.recordCompact({
      operationId: 'restore',
      workspaceId: 'ws',
      content: 'durable',
    })
    const restored = new ComemEngine({ store })
    await restored.waitReady()
    expect(await restored.search('durable')).toHaveLength(1)
  })
})

describe('comem loader lifecycle', () => {
  it('keeps the named function-plugin namespace and scopes runtime effects', async () => {
    const plugin = await import('#src/index')
    expect('default' in plugin).toBeFalsy()
    expect(plugin.name).toBe('comem')
    expect(plugin.inject).toStrictEqual([])
    const ctx = new Context()
    const provide = vi.spyOn(ctx, 'provide')
    const fiber = await ctx.plugin(plugin, {
      storageDir: '/tmp/comem-test-do-not-use',
    })
    expect(provide).toHaveBeenCalledWith('comem', expect.anything())
    await fiber.dispose()
    expect(ctx.get('comem', false)).toBeUndefined()
  })
})
