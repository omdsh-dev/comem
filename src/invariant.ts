/** Invariant companion for durable comem records and edges. */
import type { Context } from 'cordis'

import { ComemEngine } from './tree.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-comem'
type InvariantFailure = (message: string) => never
type InvariantInstaller = (
  ctx: Context,
  fail: InvariantFailure,
) => void | Promise<void>
interface InvariantRegistry {
  register: (packageName: string, installer: InvariantInstaller) => () => void
}
type InvariantContext = Context & {
  get: (name: 'invariants', strict?: boolean) => unknown
}
const name = 'comem-invariant'
const inject = ['invariants']
const install: InvariantInstaller = (ctx, fail) => {
  const engine: unknown = ctx.get('comem', false)
  if (!(engine instanceof ComemEngine)) {
    return
  }
  const snapshot = engine.snapshot()
  const nodes = new Map(snapshot.nodes.map((item) => [item.id, item]))
  const mem = new Map(snapshot.mem.map((item) => [item.id, item]))
  const edges = new Map(snapshot.edges.map((item) => [item.recordId, item]))
  const orders = new Map<string, Set<number>>()
  for (const item of snapshot.records) {
    if (item.content.length === 0 || item.tokenCount < 0) {
      fail(`comem Record content/token count is invalid: ${item.id}`)
    }
    const edge = edges.get(item.id)
    if (
      edge === undefined
      || edge.parentNodeId !== item.parentNodeId
      || edge.childNodeId !== item.childNodeId
      || edge.order !== item.order
    ) {
      fail(`comem Record edge mismatch: ${item.id}`)
    }
    const parentOrders = orders.get(item.parentNodeId) ?? new Set<number>()
    if (parentOrders.has(item.order))
      fail(`comem Record order is duplicated: ${item.id}`)
    parentOrders.add(item.order)
    orders.set(item.parentNodeId, parentOrders)
    const child = nodes.get(item.childNodeId)
    const childMem = mem.get(item.childMemRevisionId)
    if (
      child === undefined
      || childMem === undefined
      || childMem.nodeId !== child.id
    ) {
      fail(`comem Record child mem reference is invalid: ${item.id}`)
    }
  }
}
function isInvariantRegistry(value: unknown): value is InvariantRegistry {
  return (
    typeof value === 'object'
    && value !== null
    && 'register' in value
    && typeof value.register === 'function'
  )
}
function getRegistry(ctx: InvariantContext): InvariantRegistry {
  const value = ctx.get('invariants')
  if (!isInvariantRegistry(value)) {
    throw new Error('comem invariant requires the invariants service')
  }
  return value
}
function apply(ctx: Context): () => void {
  return getRegistry(ctx).register(PACKAGE_NAME, install)
}
export { apply, inject, name }
