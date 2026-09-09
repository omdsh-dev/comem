/** Durable comem tree, append records, and replayable state transitions. */

import type { ComemModel } from './model.ts'
import { localComemModel } from './model.ts'
import type { ComemStore } from './storage.ts'

export type ComemLayer = 'L1' | 'L2' | 'L3' | `L${number}`
export type NodeStatus = 'active' | 'sealed'
export type ComemSourceKind = 'native' | 'archive' | 'note'

export interface ComemSource {
  readonly kind: ComemSourceKind
  readonly operationId: string
  readonly workspaceId: string
  readonly sessionId?: string
  readonly coverage?: readonly string[]
  readonly provider?: string
  readonly model?: string
  readonly promptVersion?: string
  readonly formatVersion?: string
  readonly summarySeq?: number
  readonly checkpointSeq?: number
  readonly endSeq?: number
  readonly usage?: Record<string, number>
}
export interface MemRevision {
  readonly id: string
  readonly nodeId: string
  readonly revision: number
  readonly content: string
  readonly tokenCount: number
  readonly source: ComemSource
  readonly status: 'complete' | 'pending' | 'failed'
  readonly createdAt: string
  readonly provider?: string
  readonly model?: string
}
export interface ComemRecord {
  readonly id: string
  readonly parentNodeId: string
  readonly childNodeId: string
  readonly childMemRevisionId: string
  readonly order: number
  readonly content: string
  readonly tokenCount: number
  readonly backgroundKind: 'empty' | 'records' | 'rollover'
  readonly backgroundRecordOrder?: number
  readonly backgroundDigest: string
  readonly backgroundMemRef?: string
  readonly source: ComemSource
  readonly createdAt: string
}
export interface AbsRevision {
  readonly id: string
  readonly nodeId: string
  readonly revision: number
  readonly content: string
  readonly tokenCount: number
  readonly memRevisionId: string
  readonly recordId?: string
  readonly status: 'complete' | 'pending' | 'failed'
  readonly createdAt: string
}
export interface ComemEdge {
  readonly parentNodeId: string
  readonly childNodeId: string
  readonly order: number
  readonly recordId: string
}
export interface ComemObservation {
  readonly id: string
  readonly compactionId: string
  readonly workspaceId: string
  readonly status: 'pending' | 'complete' | 'failed'
  readonly sequence?: number | undefined
  readonly error?: string | undefined
  readonly createdAt: string
}
export interface ComemNode {
  readonly id: string
  readonly workspaceId: string
  readonly layer: ComemLayer
  readonly status: NodeStatus
  readonly children: readonly string[]
  readonly records: readonly string[]
  readonly memRevisionIds: readonly string[]
  readonly absRevisionIds: readonly string[]
  readonly logicalCap: number
  readonly physicalBudget: number
  readonly rolloverMemRef?: string
}

export type ComemEvent =
  | { readonly type: 'node'; readonly node: ComemNode }
  | { readonly type: 'mem'; readonly revision: MemRevision }
  | { readonly type: 'record'; readonly record: ComemRecord }
  | { readonly type: 'abs'; readonly revision: AbsRevision }
  | { readonly type: 'edge'; readonly edge: ComemEdge }
  | {
      readonly type: 'note'
      readonly source: ComemSource
      readonly content: string
      readonly id: string
      readonly createdAt: string
    }
  | {
      readonly type: 'operation'
      readonly operationId: string
      readonly nodeId: string
    }
  | { readonly type: 'observation'; readonly observation: ComemObservation }

export interface ComemSearchHit {
  readonly nodeId: string
  readonly layer?: ComemLayer
  readonly contentType: 'abs' | 'mem' | 'note'
  readonly content: string
  readonly revision?: number
  readonly source?: ComemSource
}
export interface ComemOpenResult {
  readonly nodeId: string
  readonly contentType: 'abs' | 'mem' | 'pending'
  readonly abs?: AbsRevision
  readonly mem?: MemRevision
  readonly records?: readonly ComemRecord[]
  readonly children?: readonly ComemNode[]
  readonly source?: readonly ComemSource[]
}
export interface ComemEngineOptions {
  readonly store: ComemStore
  readonly model?: ComemModel
  readonly logicalLayerCap?: number
  readonly physicalCallBudget?: number
  readonly tokenEstimator?: (content: string) => number
  readonly now?: () => string
}

interface State {
  readonly nodes: Map<string, ComemNode>
  readonly mem: Map<string, MemRevision>
  readonly records: Map<string, ComemRecord>
  readonly edges: Map<string, ComemEdge>
  readonly abs: Map<string, AbsRevision>
  readonly notes: Map<string, Extract<ComemEvent, { type: 'note' }>>
  readonly operations: Map<string, string>
  readonly observations: Map<string, ComemObservation>
  readonly nextByLayer: Map<string, number>
}
const emptyState = (): State => ({
  nodes: new Map(),
  mem: new Map(),
  records: new Map(),
  edges: new Map(),
  abs: new Map(),
  notes: new Map(),
  operations: new Map(),
  observations: new Map(),
  nextByLayer: new Map(),
})
const DEFAULT_CAP = 102_400

export class ComemEngine {
  private readonly state = emptyState()
  private readonly model: ComemModel
  private readonly cap: number
  private readonly physicalBudget: number
  private readonly estimateTokens: (content: string) => number
  private readonly now: () => string
  private queue: Promise<unknown> = Promise.resolve()
  private readonly ready: Promise<void>

  constructor(private readonly options: ComemEngineOptions) {
    this.model = options.model ?? localComemModel
    this.cap = options.logicalLayerCap ?? DEFAULT_CAP
    this.physicalBudget = options.physicalCallBudget ?? 0
    this.estimateTokens =
      options.tokenEstimator ?? ((content) => Math.ceil(content.length / 4))
    this.now = options.now ?? (() => new Date().toISOString())
    this.ready = this.restore()
  }
  async waitReady(): Promise<void> {
    await this.ready
  }

  async recordCompact(input: {
    operationId: string
    workspaceId: string
    sessionId?: string
    content: string
    kind?: 'native' | 'archive'
    coverage?: readonly string[]
    provider?: string
    model?: string
    promptVersion?: string
    formatVersion?: string
    summarySeq?: number
    checkpointSeq?: number
    endSeq?: number
  }): Promise<ComemNode> {
    return this.serial(async () => {
      await this.waitReady()
      const existing = this.state.operations.get(input.operationId)
      const existingNode =
        existing === undefined ? undefined : this.requireNode(existing)
      const existingRecord =
        existingNode === undefined
          ? undefined
          : [...this.state.records.values()].find(
              (record) => record.childNodeId === existingNode.id,
            )
      if (existingNode !== undefined && existingRecord !== undefined) {
        const existingMem = this.latestMem(existingNode)
        if (
          existingMem !== undefined
          && this.latestAbs(existingNode) === undefined
        )
          await this.writeAbs(
            existingNode,
            existingMem,
            existingRecord,
            existingRecord.source.sessionId,
          )
        return this.requireNode(existingNode.id)
      }
      const source: ComemSource = {
        kind: input.kind ?? 'native',
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.promptVersion === undefined
          ? {}
          : { promptVersion: input.promptVersion }),
        ...(input.formatVersion === undefined
          ? {}
          : { formatVersion: input.formatVersion }),
        ...(input.summarySeq === undefined
          ? {}
          : { summarySeq: input.summarySeq }),
        ...(input.checkpointSeq === undefined
          ? {}
          : { checkpointSeq: input.checkpointSeq }),
        ...(input.endSeq === undefined ? {} : { endSeq: input.endSeq }),
      }
      const child =
        existingNode ?? (await this.createNode('L1', input.workspaceId))
      if (existingNode === undefined) {
        const claim: ComemEvent = {
          type: 'operation',
          operationId: input.operationId,
          nodeId: child.id,
        }
        await this.options.store.append(claim)
        this.apply(claim)
      }
      const mem =
        this.latestMem(child)
        ?? (await this.writeMem(child, input.content, source, input))
      await this.appendToParent(child, mem, input.workspaceId, input.sessionId)
      return this.requireNode(child.id)
    })
  }
  async archiveCompact(input: {
    operationId: string
    workspaceId: string
    sessionId?: string
    content: string
    coverage?: readonly string[]
  }): Promise<ComemNode> {
    return this.recordCompact({ ...input, kind: 'archive' })
  }

  async note(input: {
    id: string
    workspaceId: string
    content: string
  }): Promise<void> {
    return this.serial(async () => {
      await this.waitReady()
      if (this.state.notes.has(input.id)) {
        return
      }
      const source: ComemSource = {
        kind: 'note',
        operationId: input.id,
        workspaceId: input.workspaceId,
      }
      const event: ComemEvent = {
        type: 'note',
        id: input.id,
        content: input.content,
        source,
        createdAt: this.now(),
      }
      await this.options.store.append(event)
      this.apply(event)
    })
  }

  async open(
    nodeId: string,
    mode: 'default' | 'expand' | 'source' = 'default',
  ): Promise<ComemOpenResult> {
    await this.ready
    const node = this.requireNode(nodeId)
    const abs = this.latestAbs(node)
    const mem = this.latestMem(node)
    if (mode === 'default') {
      return abs === undefined
        ? { nodeId, contentType: 'pending' }
        : { nodeId, contentType: 'abs', abs }
    }
    const records = node.records
      .map((id) => this.state.records.get(id))
      .filter((item): item is ComemRecord => item !== undefined)
    const children = node.children
      .map((id) => this.state.nodes.get(id))
      .filter((item): item is ComemNode => item !== undefined)
    const result: ComemOpenResult =
      mem === undefined
        ? { nodeId, contentType: 'pending', records, children }
        : { nodeId, contentType: 'mem', mem, records, children }
    if (mode === 'source') {
      return {
        ...result,
        source: [
          mem?.source,
          ...node.records.map((id) => this.state.records.get(id)?.source),
        ].filter((item): item is ComemSource => item !== undefined),
      }
    }
    return result
  }

  async search(query: string, workspaceId?: string): Promise<ComemSearchHit[]> {
    await this.ready
    const needle = query.toLocaleLowerCase()
    const hits: ComemSearchHit[] = []
    for (const node of this.state.nodes.values()) {
      if (workspaceId !== undefined && node.workspaceId !== workspaceId) {
        continue
      }
      const abs = this.latestAbs(node)
      if (
        abs !== undefined
        && abs.content.toLocaleLowerCase().includes(needle)
      ) {
        hits.push({
          nodeId: node.id,
          layer: node.layer,
          contentType: 'abs',
          content: abs.content,
          revision: abs.revision,
        })
      }
    }
    for (const note of this.state.notes.values()) {
      if (
        (workspaceId === undefined || note.source.workspaceId === workspaceId)
        && note.content.toLocaleLowerCase().includes(needle)
      )
        hits.push({
          nodeId: note.id,
          contentType: 'note',
          content: note.content,
          source: note.source,
        })
    }
    return hits
  }
  snapshot(): {
    nodes: ComemNode[]
    mem: MemRevision[]
    records: ComemRecord[]
    edges: ComemEdge[]
    observations: ComemObservation[]
    abs: AbsRevision[]
  } {
    return {
      nodes: [...this.state.nodes.values()],
      mem: [...this.state.mem.values()],
      records: [...this.state.records.values()],
      edges: [...this.state.edges.values()],
      observations: [...this.state.observations.values()],
      abs: [...this.state.abs.values()],
    }
  }

  /**
   * Persist one native-compaction observation. Completed compactions are not
   * written: their L1 node, mem revision, and operation record already carry
   * the result, so the marker would only live until {@link pruneObservation}
   * removes it. Pending and failed records stay durable for recovery and
   * diagnosis.
   *
   * @param input - Observation identity, scope, status, and event sequence.
   */
  async observeNative(input: {
    id: string
    compactionId: string
    workspaceId: string
    status: ComemObservation['status']
    sequence?: number
    error?: string | undefined
  }): Promise<void> {
    if (input.status === 'complete') return
    await this.serial(async () => {
      const observation: ComemObservation = { ...input, createdAt: this.now() }
      const event: ComemEvent = { type: 'observation', observation }
      await this.options.store.append(event)
      this.apply(event)
    })
  }

  /**
   * Drop one compaction's observation records once its L1 node is durable. The
   * operation record keeps replayed events idempotent, so the marker is only
   * needed while the compaction is incomplete.
   *
   * @param id - Observation id (`native-observation:<compactionId>`).
   */
  async pruneObservation(id: string): Promise<void> {
    await this.serial(async () => {
      await this.options.store.removeObservations?.(id)
      this.state.observations.delete(id)
    })
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  private async restore(): Promise<void> {
    for (const event of await this.options.store.read()) {
      this.apply(event)
    }
    // Completed markers written before the pruning contract carry no reader
    // either; drop them so the store only keeps incomplete compactions.
    const legacy = [...this.state.observations.values()]
      .filter((observation) => observation.status === 'complete')
      .map((observation) => observation.id)
    await Promise.all(legacy.map((id) => this.pruneObservation(id)))
  }
  private apply(event: ComemEvent): void {
    if (event.type === 'node') {
      this.state.nodes.set(event.node.id, event.node)
      const ordinal = Number(event.node.id.split('-')[1] ?? 0)
      this.state.nextByLayer.set(
        event.node.layer,
        Math.max(
          this.state.nextByLayer.get(event.node.layer) ?? 1,
          ordinal + 1,
        ),
      )
      return
    }
    if (event.type === 'mem') {
      this.state.mem.set(event.revision.id, event.revision)
      return
    }
    if (event.type === 'record') {
      this.state.records.set(event.record.id, event.record)
      return
    }
    if (event.type === 'abs') {
      this.state.abs.set(event.revision.id, event.revision)
      return
    }
    if (event.type === 'note') {
      this.state.notes.set(event.id, event)
      return
    }
    if (event.type === 'operation') {
      this.state.operations.set(event.operationId, event.nodeId)
      return
    }
    if (event.type === 'observation') {
      this.state.observations.set(event.observation.id, event.observation)
      return
    }
    if (event.type !== 'edge') return
    this.state.edges.set(event.edge.recordId, event.edge)
    const parent = this.state.nodes.get(event.edge.parentNodeId)
    if (
      parent === undefined
      || parent.children.includes(event.edge.childNodeId)
    ) {
      return
    }
    this.state.nodes.set(parent.id, {
      ...parent,
      children: [...parent.children, event.edge.childNodeId],
      records: parent.records.includes(event.edge.recordId)
        ? parent.records
        : [...parent.records, event.edge.recordId],
    })
  }
  private async createNode(
    layer: ComemLayer,
    workspaceId: string,
    rolloverMemRef?: string,
  ): Promise<ComemNode> {
    const ordinal = this.state.nextByLayer.get(layer) ?? 1
    const node: ComemNode = {
      id: `${layer}-${ordinal}`,
      workspaceId,
      layer,
      status: 'active',
      children: [],
      records: [],
      memRevisionIds: [],
      absRevisionIds: [],
      logicalCap: this.cap,
      physicalBudget: this.physicalBudget,
      ...(rolloverMemRef === undefined ? {} : { rolloverMemRef }),
    }
    const event: ComemEvent = { type: 'node', node }
    await this.options.store.append(event)
    this.apply(event)
    return node
  }
  private async writeMem(
    node: ComemNode,
    content: string,
    source: ComemSource,
    metadata: { provider?: string; model?: string } = {},
  ): Promise<MemRevision> {
    const revision: MemRevision = {
      id: `${node.id}:mem:${node.memRevisionIds.length + 1}`,
      nodeId: node.id,
      revision: node.memRevisionIds.length + 1,
      content,
      tokenCount: this.estimateTokens(content),
      source,
      status: 'complete',
      createdAt: this.now(),
      ...(metadata.provider === undefined
        ? {}
        : { provider: metadata.provider }),
      ...(metadata.model === undefined ? {} : { model: metadata.model }),
    }
    const event: ComemEvent = { type: 'mem', revision }
    await this.options.store.append(event)
    this.apply(event)
    const updated: ComemNode = {
      ...this.requireNode(node.id),
      memRevisionIds: [...node.memRevisionIds, revision.id],
    }
    const nodeEvent: ComemEvent = { type: 'node', node: updated }
    await this.options.store.append(nodeEvent)
    this.apply(nodeEvent)
    return revision
  }
  private async appendToParent(
    child: ComemNode,
    childMem: MemRevision,
    workspaceId: string,
    sessionId?: string,
  ): Promise<void> {
    const layer: ComemLayer = `L${Number(child.layer.slice(1)) + 1}`
    let parent = this.activeNode(layer, workspaceId)
    if (parent === undefined) {
      const previous = this.latestSealed(layer, workspaceId)
      parent = await this.createNode(
        layer,
        workspaceId,
        previous === undefined ? undefined : this.latestMem(previous)?.id,
      )
    }
    const records = parent.records
      .map((id) => this.state.records.get(id))
      .filter((item): item is ComemRecord => item !== undefined)
      .toSorted((a, b) => a.order - b.order)
    const background =
      records.length > 0
        ? records.map((item) => item.content).join('\n')
        : parent.rolloverMemRef === undefined
          ? ''
          : (this.state.mem.get(parent.rolloverMemRef)?.content ?? '')
    const backgroundKind: ComemRecord['backgroundKind'] =
      records.length > 0
        ? 'records'
        : parent.rolloverMemRef === undefined
          ? 'empty'
          : 'rollover'
    const result = await this.compactWithBudget({
      kind: 'append',
      background,
      target: childMem.content,
      instruction:
        '只输出当前 child node mem 的压缩内容，不重写已有父节点内容。',
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(this.physicalBudget > 0
        ? { physicalBudget: this.physicalBudget }
        : {}),
    })
    const order = parent.children.length
    const optionalBackgroundOrder = records.at(-1)?.order
    const record: ComemRecord = {
      id: `${parent.id}:record:${order + 1}`,
      parentNodeId: parent.id,
      childNodeId: child.id,
      childMemRevisionId: childMem.id,
      order,
      content: result.content,
      tokenCount: this.estimateTokens(result.content),
      backgroundKind,
      backgroundDigest: digest(background),
      source: childMem.source,
      createdAt: this.now(),
      ...(optionalBackgroundOrder === undefined
        ? {}
        : { backgroundRecordOrder: optionalBackgroundOrder }),
      ...(backgroundKind === 'rollover' && parent.rolloverMemRef !== undefined
        ? { backgroundMemRef: parent.rolloverMemRef }
        : {}),
    }
    const recordEvent: ComemEvent = { type: 'record', record }
    await this.options.store.append(recordEvent)
    this.apply(recordEvent)
    const edge: ComemEvent = {
      type: 'edge',
      edge: {
        parentNodeId: parent.id,
        childNodeId: child.id,
        order,
        recordId: record.id,
      },
    }
    await this.options.store.append(edge)
    this.apply(edge)
    await this.writeAbs(child, childMem, record, sessionId)
    const updated = this.requireNode(parent.id)
    const estimate = updated.records.reduce(
      (total, id) => total + (this.state.records.get(id)?.tokenCount ?? 0),
      0,
    )
    if (estimate >= this.cap) {
      await this.sealParent(updated, workspaceId, sessionId)
    }
  }
  private async sealParent(
    parent: ComemNode,
    workspaceId: string,
    sessionId?: string,
  ): Promise<void> {
    const records = parent.records
      .map((id) => this.state.records.get(id))
      .filter((item): item is ComemRecord => item !== undefined)
      .toSorted((a, b) => a.order - b.order)
    const input = records.map((item) => item.content).join('\n')
    const result = await this.compactWithBudget({
      kind: 'layer',
      background: '',
      target: input,
      instruction:
        '压缩当前节点 Records 的重放输入，并把结果写回当前节点 mem。',
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(this.physicalBudget > 0
        ? { physicalBudget: this.physicalBudget }
        : {}),
    })
    await this.writeMem(
      parent,
      result.content,
      {
        kind: 'native',
        operationId: `${parent.id}:layer:${parent.memRevisionIds.length + 1}`,
        workspaceId,
      },
      result,
    )
    const sealed: ComemNode = {
      ...this.requireNode(parent.id),
      status: 'sealed',
    }
    const event: ComemEvent = { type: 'node', node: sealed }
    await this.options.store.append(event)
    this.apply(event)
    const sealedMem = this.latestMem(sealed)
    const layerNumber = Number(parent.layer.slice(1))
    if (
      sealedMem !== undefined
      && (layerNumber < 3 || sealedMem.tokenCount < this.cap)
    ) {
      await this.appendToParent(sealed, sealedMem, workspaceId, sessionId)
    }
  }
  private async compactWithBudget(
    request: Parameters<ComemModel['compact']>[0],
  ): Promise<Awaited<ReturnType<ComemModel['compact']>>> {
    if (
      this.physicalBudget <= 0
      || this.estimateTokens(
        request.background + request.target + request.instruction,
      ) <= this.physicalBudget
    )
      return this.model.compact({ ...request })
    const available =
      this.physicalBudget
      - this.estimateTokens(request.target + request.instruction)
    if (available <= 0)
      throw new Error('comem physical budget cannot fit target and instruction')
    const chunks = splitWithinBudget(
      request.background,
      available,
      this.estimateTokens,
    )
    if (chunks.length === 0)
      throw new Error('comem physical budget cannot fit background')
    const results = await Promise.all(
      chunks.map((background) =>
        this.model.compact({
          ...request,
          background,
          physicalBudget: this.physicalBudget,
        }),
      ),
    )
    const last = results.at(-1)
    return {
      content: results.map((result) => result.content).join('\n'),
      ...(last?.provider === undefined ? {} : { provider: last.provider }),
      ...(last?.model === undefined ? {} : { model: last.model }),
      ...(last?.usage === undefined ? {} : { usage: last.usage }),
    }
  }

  private async writeAbs(
    child: ComemNode,
    mem: MemRevision,
    record: ComemRecord,
    sessionId?: string,
  ): Promise<void> {
    try {
      const result = await this.model.summarize({
        kind: 'abs',
        background: record.content,
        target: mem.content,
        instruction:
          '只生成当前 child node 的默认摘要，不把父节点事实写成 child 事实。',
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      const revision: AbsRevision = {
        id: `${child.id}:abs:${child.absRevisionIds.length + 1}`,
        nodeId: child.id,
        revision: child.absRevisionIds.length + 1,
        content: result.content,
        tokenCount: this.estimateTokens(result.content),
        memRevisionId: mem.id,
        recordId: record.id,
        status: 'complete',
        createdAt: this.now(),
      }
      const absEvent: ComemEvent = { type: 'abs', revision }
      await this.options.store.append(absEvent)
      this.apply(absEvent)
      const updated: ComemNode = {
        ...this.requireNode(child.id),
        absRevisionIds: [...child.absRevisionIds, revision.id],
      }
      const nodeEvent: ComemEvent = { type: 'node', node: updated }
      await this.options.store.append(nodeEvent)
      this.apply(nodeEvent)
    } catch {
      /* Mem and Record remain durable; open reports pending. */
    }
  }
  private activeNode(
    layer: ComemLayer,
    workspaceId: string,
  ): ComemNode | undefined {
    return [...this.state.nodes.values()].find(
      (node) =>
        node.layer === layer
        && node.workspaceId === workspaceId
        && node.status === 'active',
    )
  }
  private latestSealed(
    layer: ComemLayer,
    workspaceId: string,
  ): ComemNode | undefined {
    return [...this.state.nodes.values()]
      .filter(
        (node) =>
          node.layer === layer
          && node.workspaceId === workspaceId
          && node.status === 'sealed',
      )
      .toSorted((a, b) => b.id.localeCompare(a.id))[0]
  }
  private latestMem(node: ComemNode): MemRevision | undefined {
    const id = node.memRevisionIds.at(-1)
    return id === undefined ? undefined : this.state.mem.get(id)
  }
  private latestAbs(node: ComemNode): AbsRevision | undefined {
    const id = node.absRevisionIds.at(-1)
    return id === undefined ? undefined : this.state.abs.get(id)
  }
  private requireNode(nodeId: string): ComemNode {
    const node = this.state.nodes.get(nodeId)
    if (node === undefined) {
      throw new Error('unknown comem node: ' + nodeId)
    }
    return node
  }
}
function splitWithinBudget(
  content: string,
  budget: number,
  estimate: (value: string) => number,
): string[] {
  const chunks: string[] = []
  let current = ''
  for (const line of content.split('\n')) {
    const candidate = current === '' ? line : current + '\n' + line
    if (estimate(candidate) > budget) {
      if (current === '')
        throw new Error(
          'comem physical budget cannot fit one indivisible background line',
        )
      chunks.push(current)
      current = line
      if (estimate(current) > budget)
        throw new Error(
          'comem physical budget cannot fit one indivisible background line',
        )
    } else current = candidate
  }
  if (current !== '') chunks.push(current)
  return chunks
}

function digest(content: string): string {
  let hash = 2_166_136_261
  for (const char of content) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  }
  return (hash >>> 0).toString(16)
}
