import { describe, expect, it } from 'vitest'

import { ComemEngine, DomainComemStore } from '#src/index'
import type { ComemEvent } from '#src/index'
import type { ComemDomain, ComemDomainTable } from '#src/storage'

function domainFrom(
  values: Map<string, ComemEvent>,
  put?: ComemDomainTable['put'],
  observations = new Map<string, ComemEvent>(),
): ComemDomain {
  const tableFor = (name: string): ComemDomainTable => {
    const records = name === 'events' ? values : observations
    return {
      get: (key: string) => records.get(key),
      entries: () => records.entries(),
      put:
        put !== undefined && name === 'events'
          ? put
          : (key: string, value: ComemEvent) => {
              records.set(key, value)
              return Promise.resolve()
            },
      delete: (key: string) => Promise.resolve(records.delete(key)),
    }
  }
  return { table: tableFor }
}

const observationMarker = (status: 'pending' | 'failed'): ComemEvent => ({
  type: 'observation',
  observation: {
    id: 'native-observation:c-9',
    compactionId: 'c-9',
    workspaceId: 'ws',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
})

const nodeEvent = (
  id: string,
  workspaceId: string,
  children: string[] = [],
): ComemEvent => ({
  type: 'node',
  node: {
    id,
    workspaceId,
    layer: 'L1',
    status: 'active',
    children,
    records: [],
    memRevisionIds: [],
    absRevisionIds: [],
    logicalCap: 100,
    physicalBudget: 0,
  },
})

describe('comem durable stores', () => {
  it('keeps multiple revisions for one node and reopens an identical engine snapshot', async () => {
    const values = new Map<string, ComemEvent>()
    const firstStore = new DomainComemStore(domainFrom(values))
    const first = new ComemEngine({ store: firstStore })
    await first.recordCompact({
      operationId: 'one',
      workspaceId: 'ws',
      content: 'first',
    })
    await first.recordCompact({
      operationId: 'two',
      workspaceId: 'ws',
      content: 'second',
    })
    const snapshot = first.snapshot()

    const reopened = new ComemEngine({
      store: new DomainComemStore(domainFrom(values)),
    })
    await reopened.waitReady()
    expect(reopened.snapshot()).toStrictEqual(snapshot)
    expect(
      (await firstStore.read()).filter((event) => event.type === 'node').length,
    ).toBeGreaterThan(2)
  })

  it('serializes concurrent domain appends in call order', async () => {
    const values = new Map<string, ComemEvent>()
    let active = 0
    let maximum = 0
    const store = new DomainComemStore(
      domainFrom(values, async (key: string, value: ComemEvent) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        values.set(key, value)
        active -= 1
      }),
    )
    await Promise.all([
      store.append(nodeEvent('a', 'ws')),
      store.append(nodeEvent('b', 'ws')),
      store.append(nodeEvent('c', 'ws')),
    ])
    expect(maximum).toBe(1)
    expect(
      (await store.read()).map((event) =>
        event.type === 'node' ? event.node.id : '',
      ),
    ).toEqual(['a', 'b', 'c'])
    expect([...values.keys()]).toEqual([
      'event-00000000000000000001',
      'event-00000000000000000002',
      'event-00000000000000000003',
    ])
  })

  it('propagates write failures and continues after a failed domain write', async () => {
    const values = new Map<string, ComemEvent>()
    let fail = true
    const store = new DomainComemStore(
      domainFrom(values, async (key: string, value: ComemEvent) => {
        if (fail) {
          fail = false
          throw new Error('disk full')
        }
        values.set(key, value)
      }),
    )
    await expect(store.append(nodeEvent('failed', 'ws'))).rejects.toThrow(
      'disk full',
    )
    await expect(store.append(nodeEvent('ok', 'ws'))).resolves.toBeUndefined()
    expect(
      (await store.read()).map((event) =>
        event.type === 'node' ? event.node.id : '',
      ),
    ).toEqual(['ok'])
  })

  it('keeps compaction markers in their own table, one document per compaction', async () => {
    const values = new Map<string, ComemEvent>()
    const observations = new Map<string, ComemEvent>()
    const store = new DomainComemStore(
      domainFrom(values, undefined, observations),
    )
    await store.append(observationMarker('pending'))
    await store.append(observationMarker('failed'))
    // The marker never enters the tree table, and repeated updates overwrite
    // one path-safe document instead of appending a new one.
    expect(values.size).toBe(0)
    expect([...observations.keys()]).toStrictEqual(['native-observation_c-9'])
    await store.removeObservations('native-observation:c-9')
    expect(observations.size).toBe(0)
    expect(
      (await store.read()).filter((event) => event.type === 'observation'),
    ).toHaveLength(0)
  })

  it('reads and prunes legacy markers that still live in the events table', async () => {
    const values = new Map<string, ComemEvent>([
      [
        'event-00000000000000000001',
        {
          type: 'observation',
          observation: {
            id: 'native-observation:c-8',
            compactionId: 'c-8',
            workspaceId: 'ws',
            status: 'failed',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    ])
    const store = new DomainComemStore(domainFrom(values))
    expect(
      (await store.read()).filter((event) => event.type === 'observation'),
    ).toHaveLength(1)
    await store.removeObservations('native-observation:c-8')
    expect(values.size).toBe(0)
  })
})
