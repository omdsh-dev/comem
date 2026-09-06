/** Append-only persistence used by the comem state machine. */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ComemEvent, ComemNode, ComemRecord, ComemSource } from './tree.ts'

export interface ComemStore {
  append(event: ComemEvent): Promise<void>
  read(): Promise<ComemEvent[]>
}
export interface ComemDomainTable {
  get(key: string): ComemEvent | undefined
  entries(): IterableIterator<[string, ComemEvent]>
  put(key: string, value: ComemEvent): Promise<void>
}
export interface ComemDomain {
  table(name: string): ComemDomainTable
  close?: () => Promise<void>
}

/** Adapter for an already-open DSH storage-domain table named events. */
export class DomainComemStore implements ComemStore {
  private readonly events: ComemDomainTable
  private nextSequence = 0
  private writes: Promise<void> = Promise.resolve()
  constructor(domain: ComemDomain, tableName = 'events') {
    this.events = domain.table(tableName)
    for (const [key, event] of this.events.entries()) {
      parseEvent(event)
      const match = /^event:(\d+)$/.exec(key)
      if (match !== null)
        this.nextSequence = Math.max(this.nextSequence, Number(match[1]))
    }
  }
  append(event: ComemEvent): Promise<void> {
    const checked = parseEvent(event)
    return this.serialize(async () => {
      let key: string
      do {
        this.nextSequence += 1
        key = 'event:' + String(this.nextSequence).padStart(20, '0')
      } while (this.events.get(key) !== undefined)
      await this.events.put(key, structuredClone(checked))
    })
  }
  read(): Promise<ComemEvent[]> {
    return Promise.resolve(
      [...this.events.entries()].map(([, event]) =>
        structuredClone(parseEvent(event)),
      ),
    )
  }
  private serialize(task: () => Promise<void>): Promise<void> {
    const result = this.writes.then(task, task)
    this.writes = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export class MemoryComemStore implements ComemStore {
  private readonly events: ComemEvent[] = []
  private writes: Promise<void> = Promise.resolve()
  append(event: ComemEvent): Promise<void> {
    const checked = parseEvent(event)
    const result = this.writes.then(() => {
      this.events.push(structuredClone(checked))
      return undefined
    })
    this.writes = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  read(): Promise<ComemEvent[]> {
    return Promise.resolve(
      this.events.map((event) => structuredClone(parseEvent(event))),
    )
  }
}

export class JsonlComemStore implements ComemStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly filePath: string) {}
  append(event: ComemEvent): Promise<void> {
    const checked = parseEvent(event)
    return this.serialize(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, JSON.stringify(checked) + '\n', 'utf8')
    })
  }
  async read(): Promise<ComemEvent[]> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    if (text.length === 0) return []
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines.map((line, index) => {
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
      if (normalized.trim() === '')
        throw new Error('invalid comem JSONL record at line ' + (index + 1))
      try {
        return parseEvent(JSON.parse(normalized))
      } catch (error) {
        throw new Error(
          'invalid comem JSONL record at line '
            + (index + 1)
            + ': '
            + (error instanceof Error ? error.message : String(error)),
          { cause: error },
        )
      }
    })
  }
  private serialize(task: () => Promise<void>): Promise<void> {
    const result = this.writes.then(task, task)
    this.writes = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function parseEvent(value: unknown): ComemEvent {
  if (!isComemEvent(value)) throw new Error('invalid comem event')
  return value
}
function isComemEvent(value: unknown): value is ComemEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'node':
      return isNode(value.node)
    case 'mem':
      return isMemRevision(value.revision)
    case 'record':
      return isRecordRevision(value.record)
    case 'abs':
      return isAbsRevision(value.revision)
    case 'edge':
      return isEdge(value.edge)
    case 'note':
      return (
        isString(value.id)
        && isString(value.content)
        && isSource(value.source)
        && isString(value.createdAt)
      )
    case 'operation':
      return isString(value.operationId) && isString(value.nodeId)
    case 'observation':
      return isObservation(value.observation)
    default:
      return false
  }
}
function isObservation(value: unknown): boolean {
  return (
    isRecord(value)
    && isString(value.id)
    && isString(value.compactionId)
    && isString(value.workspaceId)
    && (value.status === 'pending'
      || value.status === 'complete'
      || value.status === 'failed')
    && (value.sequence === undefined || isFiniteNumber(value.sequence))
    && (value.error === undefined || isString(value.error))
    && isString(value.createdAt)
  )
}
function isEdge(value: unknown): boolean {
  return (
    isRecord(value)
    && isString(value.parentNodeId)
    && isString(value.childNodeId)
    && isFiniteNumber(value.order)
    && isString(value.recordId)
  )
}
function isNode(value: unknown): value is ComemNode {
  return (
    isRecord(value)
    && isString(value.id)
    && isString(value.workspaceId)
    && isString(value.layer)
    && isString(value.status)
    && isStringArray(value.children)
    && isStringArray(value.records)
    && isStringArray(value.memRevisionIds)
    && isStringArray(value.absRevisionIds)
    && isFiniteNumber(value.logicalCap)
    && isFiniteNumber(value.physicalBudget)
    && (value.rolloverMemRef === undefined || isString(value.rolloverMemRef))
  )
}
function isMemRevision(value: unknown): boolean {
  return (
    isRecord(value)
    && isString(value.id)
    && isString(value.nodeId)
    && isFiniteNumber(value.revision)
    && isString(value.content)
    && isFiniteNumber(value.tokenCount)
    && isSource(value.source)
    && isString(value.status)
    && isString(value.createdAt)
    && (value.provider === undefined || isString(value.provider))
    && (value.model === undefined || isString(value.model))
  )
}
function isRecordRevision(value: unknown): value is ComemRecord {
  return (
    isRecord(value)
    && isString(value.id)
    && isString(value.parentNodeId)
    && isString(value.childNodeId)
    && isString(value.childMemRevisionId)
    && isFiniteNumber(value.order)
    && isString(value.content)
    && isFiniteNumber(value.tokenCount)
    && isString(value.backgroundKind)
    && (value.backgroundRecordOrder === undefined
      || isFiniteNumber(value.backgroundRecordOrder))
    && isString(value.backgroundDigest)
    && (value.backgroundMemRef === undefined
      || isString(value.backgroundMemRef))
    && isSource(value.source)
    && isString(value.createdAt)
  )
}
function isAbsRevision(value: unknown): boolean {
  return (
    isRecord(value)
    && isString(value.id)
    && isString(value.nodeId)
    && isFiniteNumber(value.revision)
    && isString(value.content)
    && isFiniteNumber(value.tokenCount)
    && isString(value.memRevisionId)
    && (value.recordId === undefined || isString(value.recordId))
    && isString(value.status)
    && isString(value.createdAt)
  )
}
function isSource(value: unknown): value is ComemSource {
  return (
    isRecord(value)
    && isString(value.kind)
    && isString(value.operationId)
    && isString(value.workspaceId)
    && (value.sessionId === undefined || isString(value.sessionId))
    && (value.coverage === undefined || isStringArray(value.coverage))
    && (value.provider === undefined || isString(value.provider))
    && (value.model === undefined || isString(value.model))
    && (value.summarySeq === undefined || isFiniteNumber(value.summarySeq))
    && (value.checkpointSeq === undefined
      || isFiniteNumber(value.checkpointSeq))
    && (value.endSeq === undefined || isFiniteNumber(value.endSeq))
    && (value.usage === undefined || isNumberRecord(value.usage))
  )
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isString(value: unknown): value is string {
  return typeof value === 'string'
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber)
}
function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
