import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ComemEngine, DomainComemStore, JsonlComemStore } from '#src/index'
import type { ComemEvent } from '#src/index'
import type { ComemDomain, ComemDomainTable } from '#src/storage'

function domainFrom(
  values: Map<string, ComemEvent>,
  put?: ComemDomainTable['put'],
): ComemDomain {
  const table: ComemDomainTable = {
    get: (key: string) => values.get(key),
    entries: () => values.entries(),
    put:
      put
      ?? ((key: string, value: ComemEvent) => {
        values.set(key, value)
        return Promise.resolve()
      }),
  }
  return { table: () => table }
}

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
  })

  it('rejects invalid and truncated JSONL records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comem-storage-'))
    try {
      const path = join(directory, 'events.jsonl')
      await writeFile(
        path,
        JSON.stringify({ type: 'node', node: { id: 'broken' } }) + '\n',
        'utf8',
      )
      await expect(new JsonlComemStore(path).read()).rejects.toThrow(
        /invalid comem JSONL record/,
      )
      await writeFile(path, '{"type":"node"', 'utf8')
      await expect(new JsonlComemStore(path).read()).rejects.toThrow(
        /invalid comem JSONL record/,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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

  it('propagates JSONL write failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comem-storage-'))
    try {
      await expect(
        new JsonlComemStore(directory).append(nodeEvent('x', 'ws')),
      ).rejects.toBeTruthy()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
