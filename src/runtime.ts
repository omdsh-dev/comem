/** Cordis activation and the fakeable host adapter for comem. */
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'session/event': (...args: unknown[]) => void
    'session/archive': (...args: unknown[]) => void
  }
}

import { ComemModelSettings, resolveConfig } from './config.ts'
import type { ConfigShape as Config } from './config.ts'
import type {
  ComemModel,
  ComemModelRequest,
  ComemModelResult,
} from './model.ts'
import { DomainComemStore } from './storage.ts'
import type { ComemDomain } from './storage.ts'
import { ComemEngine } from './tree.ts'
import type { ComemEngineOptions } from './tree.ts'

export interface ComemRuntime {
  readonly engine: ComemEngine
  readonly close: () => Promise<void>
}
interface ToolRuntime {
  register?: (definition: Record<string, unknown>) => () => void
}
export interface ComemArchiveResult {
  readonly workspaceId: string
  readonly content: string
  readonly coverage?: readonly string[]
}
export interface ComemArchiveProvider {
  compactSession: (sessionId: string) => Promise<ComemArchiveResult | undefined>
}
interface PromptRuntime {
  section?: (definition: {
    name: string
    order: number
    text: string
  }) => () => void
}
type ComemContext = Context

interface StorageDomainFacility {
  open: (spec: unknown) => unknown
}
interface ModelSelection {
  provider: string
  model: string
}
interface SettingsScope<T> {
  get: () => T
}
interface SettingsFacility {
  register: (
    namespace: string,
    schema: unknown,
    options?: { base?: Partial<ModelSelection>; applies?: 'live' | 'restart' },
  ) => SettingsScope<ModelSelection>
}
const comemDomainSpec = {
  name: 'comem',
  version: 1,
  layout: 'per-record' as const,
  tables: { events: { valueSchema: { parse: (value: unknown) => value } } },
}
async function openStorageDomain(ctx: Context): Promise<ComemDomain> {
  const candidate =
    typeof ctx.get === 'function' ? ctx.get('storageDomain', false) : undefined
  if (!isStorageDomainFacility(candidate)) {
    throw new Error(
      'comem requires the DSH storageDomain service and cannot start without it',
    )
  }
  let domain: unknown
  try {
    domain = await candidate.open(comemDomainSpec)
  } catch (error) {
    throw new Error(
      "comem could not open the DSH storageDomain 'comem' domain: "
        + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    )
  }
  if (!isDomain(domain)) {
    throw new Error('comem storageDomain.open() did not return a usable domain')
  }
  return domain
}
function isStorageDomainFacility(
  value: unknown,
): value is StorageDomainFacility {
  return isRecord(value) && typeof value.open === 'function'
}
function isSettingsFacility(value: unknown): value is SettingsFacility {
  return isRecord(value) && typeof value.register === 'function'
}

export async function createComemRuntime(
  ctx: Context,
  config: Config,
  options: Omit<Partial<ComemEngineOptions>, 'store'> = {},
): Promise<ComemRuntime> {
  const resolved = resolveConfig(config)
  const domain = await openStorageDomain(ctx)
  try {
    const modelSettings = registerModelSettings(ctx, resolved)
    const store = new DomainComemStore(domain)
    const model = options.model ?? createHostModel(ctx, resolved, modelSettings)
    const engine = new ComemEngine({
      ...options,
      store,
      model,
      logicalLayerCap: options.logicalLayerCap ?? resolved.logicalLayerCap,
      physicalCallBudget:
        options.physicalCallBudget ?? resolved.physicalCallBudget,
    })
    let closePromise: Promise<void> | undefined
    return {
      engine,
      close(): Promise<void> {
        closePromise ??= (async () => {
          try {
            await engine.waitReady()
          } finally {
            if (domain.close !== undefined) await domain.close()
          }
        })()
        return closePromise
      },
    }
  } catch (error) {
    try {
      if (domain.close !== undefined) await domain.close()
    } catch {
      // Preserve the original runtime construction error.
    }
    throw error
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtime = await createComemRuntime(ctx, config)
  try {
    await runtime.engine.waitReady()
  } catch (error) {
    try {
      await runtime.close()
    } catch {
      // Preserve the engine startup error; close() already attempted domain cleanup.
    }
    throw error
  }
  const host: ComemContext = ctx
  const removeService = host.provide('comem', runtime.engine)
  const disposers: (() => void)[] = []
  if (typeof removeService === 'function') {
    disposers.push(removeService)
  }
  const prompt = safeGet(host, 'systemPrompt')
  if (isPromptRuntime(prompt) && prompt.section !== undefined) {
    const result = prompt.section({
      name: 'comem',
      order: 90,
      text: 'comem_open 默认返回 abs；需要细节时使用 expand。comem_note 只保存跨 workspace 的明确笔记，不会自动共享 workspace 记忆。',
    })
    if (typeof result === 'function') {
      disposers.push(result)
    }
  }
  const tools = safeGet(host, 'tools')
  if (isToolRuntime(tools)) {
    disposers.push(...registerTools(tools, runtime.engine))
  }
  const nativeDispose = installNativeObserver(host, runtime.engine)
  if (nativeDispose !== undefined) {
    disposers.push(nativeDispose)
  }
  ctx.effect(
    () => async () => {
      try {
        for (const dispose of disposers.splice(0).toReversed()) {
          dispose()
        }
      } finally {
        await runtime.close()
      }
    },
    'comem.dispose',
  )
}

function unavailable(): Promise<ComemModelResult> {
  return Promise.reject(
    new Error(
      'comem requires a compression provider and model; configure Settings > Comem',
    ),
  )
}

function registerModelSettings(
  ctx: Context,
  config: { provider: string; model: string },
): SettingsScope<ModelSelection> | undefined {
  const candidate = safeGet(ctx, 'settings')
  if (!isSettingsFacility(candidate)) return undefined
  return candidate.register('comem', ComemModelSettings, {
    base: { provider: config.provider, model: config.model },
    applies: 'live',
  })
}
function createHostModel(
  ctx: Context,
  config: { provider: string; model: string },
  settings: SettingsScope<ModelSelection> | undefined,
): ComemModel {
  let messageId = 0
  const call = async (
    request: ComemModelRequest,
  ): Promise<ComemModelResult> => {
    const service = safeGet(ctx, 'llm')
    if (!isHostLlm(service)) return unavailable()
    const configured = settings?.get() ?? config
    const provider =
      configured.provider || stringField(service, 'provider') || ''
    const model = configured.model || stringField(service, 'model') || ''
    if (provider.length === 0 || model.length === 0) return unavailable()
    const text = [request.background, request.target, request.instruction]
      .filter((value) => value.length > 0)
      .join('\n\n')
    const options = {
      provider,
      model,
      purpose: 'compaction' as const,
      messages: [
        {
          id: 'comem-' + String(messageId++),
          role: 'user' as const,
          content: [{ type: 'text' as const, text }],
          source: { kind: 'plugin' as const, plugin: 'comem' },
        },
      ],
    }
    const chunks: string[] = []
    let usage: Record<string, number> | undefined
    for await (const chunk of service.stream(options)) {
      if (!isRecord(chunk) || typeof chunk.type !== 'string') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
        chunks.push(chunk.text)
      if (
        chunk.type === 'block-end'
        && isRecord(chunk.block)
        && typeof chunk.block.text === 'string'
      )
        chunks.push(chunk.block.text)
      if (chunk.type === 'usage') usage = numericRecord(chunk.usage)
      if (
        chunk.type === 'finish'
        && isRecord(chunk.reason)
        && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
      )
        throw new Error('comem model stream failed: ' + chunk.reason.kind)
    }
    const content = chunks.join('')
    if (content.trim().length === 0)
      throw new Error('comem model produced no text content')
    return {
      content,
      provider,
      model,
      ...(usage === undefined ? {} : { usage }),
    }
  }
  return { compact: call, summarize: call }
}
interface HostLlm {
  stream: (options: unknown) => AsyncIterable<unknown>
  provider?: string
  model?: string
}
function numericRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, number> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = item
  }
  return Object.keys(result).length === 0 ? undefined : result
}
function isHostLlm(value: unknown): value is HostLlm {
  return (
    isRecord(value) && 'stream' in value && typeof value.stream === 'function'
  )
}

function registerTools(
  tools: ToolRuntime,
  engine: ComemEngine,
): (() => void)[] {
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args: unknown, value: unknown) => [
      { type: 'text', text: JSON.stringify(value) },
    ],
  }
  const register = tools.register!.bind(tools)
  return [
    register({
      name: 'comem_search',
      description: 'Search comem summaries and explicit shared notes.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, scope: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      output,
      execute: async (args: { query: string; scope?: string }) =>
        engine.search(args.query, args.scope),
    }),
    register({
      name: 'comem_open',
      description: 'Open a comem node summary or expand its details.',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          mode: { type: 'string', enum: ['default', 'expand', 'source'] },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      output,
      execute: async (args: {
        nodeId: string
        mode?: 'default' | 'expand' | 'source'
      }) => engine.open(args.nodeId, args.mode ?? 'default'),
    }),
    register({
      name: 'comem_note',
      description: 'Save an explicit cross-workspace comem note.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspaceId: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['id', 'workspaceId', 'content'],
        additionalProperties: false,
      },
      output,
      execute: async (args: {
        id: string
        workspaceId: string
        content: string
      }) => {
        await engine.note(args)
        return { ok: true, id: args.id }
      },
    }),
  ]
}

interface PendingNative {
  readonly workspaceId: string
  readonly sessionId?: string
  summary?: string | undefined
  summarySeq?: number | undefined
  checkpointSeq?: number | undefined
  coverage?: readonly string[] | undefined
  provider?: string | undefined
  model?: string | undefined
  usage?: Record<string, number> | undefined
  endSeq?: number | undefined
  checkpoint: boolean
  ended: boolean
}
export async function archiveSession(
  ctx: Context,
  engine: ComemEngine,
  sessionId: string,
): Promise<unknown> {
  const registry = safeGet(ctx, 'workspaceRegistry')
  if (isWorkspaceRegistry(registry)) await registry.archiveSession(sessionId)
  const injectedProvider = ctx.get('comemArchiveProvider', false)
  const provider = isArchiveProvider(injectedProvider)
    ? injectedProvider
    : createSessionArchiveProvider(ctx)
  if (provider === undefined) return undefined
  const result = await provider.compactSession(sessionId)
  if (result === undefined) return undefined
  return engine.archiveCompact({
    operationId: 'archive:' + sessionId,
    sessionId,
    ...result,
  })
}
interface WorkspaceRegistry {
  archiveSession: (sessionId: string) => Promise<void>
}
function isWorkspaceRegistry(value: unknown): value is WorkspaceRegistry {
  return isRecord(value) && typeof value.archiveSession === 'function'
}
function createSessionArchiveProvider(
  ctx: Context,
): ComemArchiveProvider | undefined {
  const sessions = safeGet(ctx, 'sessions')
  if (!isSessionStore(sessions)) return undefined
  return {
    compactSession: async (sessionId) => {
      const session = sessions.get(sessionId)
      if (session === undefined) return undefined
      const messages = session.deriveMessages()
      const content = messages
        .map((message) => messageText(message))
        .filter((value) => value.length > 0)
        .join('\n')
      if (content.length === 0) return undefined
      return { workspaceId: sessionWorkspace(session), content }
    },
  }
}
interface SessionStoreLike {
  get: (sessionId: string) => LiveSessionLike | undefined
}
interface LiveSessionLike {
  deriveMessages: () => readonly unknown[]
  header?: Record<string, unknown>
}
function isSessionStore(value: unknown): value is SessionStoreLike {
  return isRecord(value) && typeof value.get === 'function'
}
function sessionWorkspace(session: LiveSessionLike): string {
  return typeof session.header?.cwd === 'string'
    ? session.header.cwd
    : 'default'
}
function messageText(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  return textFromBlocks(content)
}
function isArchiveProvider(value: unknown): value is ComemArchiveProvider {
  return (
    isRecord(value)
    && 'compactSession' in value
    && typeof value.compactSession === 'function'
  )
}

function installNativeObserver(
  ctx: ComemContext,
  engine: ComemEngine,
): (() => void) | undefined {
  if (typeof ctx.on !== 'function') {
    return undefined
  }
  const pending = new Map<string, PendingNative>()
  return ctx.on('session/event', (...args: unknown[]) => {
    const session = args[0]
    const event = args[1]
    if (!isRecord(event)) {
      return
    }
    const type = stringField(event, 'type')
    const data = recordField(event, 'data') ?? event
    const source = recordField(data, 'source')
    const isSummary = type === 'compaction/summary'
    const surfaceOp = recordField(event, 'surfaceOp')
    const sourceEventSeqs = unknownField(event, 'sourceEventSeqs')
    const isReplacement =
      type === 'user/message'
      && source !== undefined
      && stringField(source, 'kind') === 'plugin'
      && stringField(source, 'plugin') === 'compact'
      && stringField(surfaceOp, 'op') === 'replace'
      && Array.isArray(sourceEventSeqs)
    if (!isSummary && type !== 'compaction/end' && !isReplacement) return
    const compactionId =
      stringField(data, 'compactionId') ?? stringField(source, 'compactionId')
    if (compactionId === undefined) return
    const sessionId = stringField(session, 'id')
    const workspaceId =
      stringField(session, 'workspaceId')
      ?? stringField(session, 'cwd')
      ?? 'default'
    const existing = pending.get(compactionId)
    let item: PendingNative = existing ?? {
      workspaceId,
      ...(sessionId === undefined ? {} : { sessionId }),
      checkpoint: false,
      ended: false,
    }
    const sequence = numberField(event, 'seq') ?? numberField(data, 'seq')
    if (isSummary) {
      const summary = textFromBlocks(data.summary)
      if (summary.length === 0) return
      item = {
        ...item,
        summary,
        ...(sequence === undefined ? {} : { summarySeq: sequence }),
        ...(stringField(data, 'provider') === undefined
          ? {}
          : { provider: stringField(data, 'provider') }),
        ...(stringField(data, 'model') === undefined
          ? {}
          : { model: stringField(data, 'model') }),
        ...(numericRecord(data.usage) === undefined
          ? {}
          : { usage: numericRecord(data.usage) }),
        ...(stringArray(data.shadowedSeqs) === undefined
          ? {}
          : { coverage: stringArray(data.shadowedSeqs) }),
      }
    }
    if (isReplacement) {
      item = {
        ...item,
        checkpoint: true,
        ...(sequence === undefined ? {} : { checkpointSeq: sequence }),
      }
    }
    if (type === 'compaction/end') {
      item = {
        ...item,
        ended: stringField(data, 'error') === undefined,
        ...(sequence === undefined ? {} : { endSeq: sequence }),
      }
    }
    pending.set(compactionId, item)
    const observationStatus =
      type === 'compaction/end' && stringField(data, 'error') !== undefined
        ? 'failed'
        : item.summary !== undefined && item.checkpoint && item.ended
          ? 'complete'
          : 'pending'
    void engine
      .observeNative({
        id: `native-observation:${compactionId}`,
        compactionId,
        workspaceId: item.workspaceId,
        status: observationStatus,
        ...(sequence === undefined ? {} : { sequence }),
        ...(stringField(data, 'error') === undefined
          ? {}
          : { error: stringField(data, 'error') }),
      })
      .catch(() => {})
    if (item.summary !== undefined && item.checkpoint && item.ended) {
      pending.delete(compactionId)
      void engine
        .recordCompact({
          operationId: `native:${compactionId}`,
          workspaceId: item.workspaceId,
          ...(item.sessionId === undefined
            ? {}
            : { sessionId: item.sessionId }),
          content: item.summary,
          kind: 'native',
          ...(item.summarySeq === undefined
            ? {}
            : { summarySeq: item.summarySeq }),
          ...(item.checkpointSeq === undefined
            ? {}
            : { checkpointSeq: item.checkpointSeq }),
          ...(item.endSeq === undefined ? {} : { endSeq: item.endSeq }),
          ...(item.coverage === undefined ? {} : { coverage: item.coverage }),
          ...(item.provider === undefined ? {} : { provider: item.provider }),
          ...(item.model === undefined ? {} : { model: item.model }),
          ...(item.usage === undefined ? {} : { usage: item.usage }),
        })
        .catch(() => {})
    }
  })
}
function textFromBlocks(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((item) =>
      isRecord(item) && typeof item.text === 'string' ? item.text : '',
    )
    .filter((item) => item.length > 0)
    .join('\n')
}
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value
    .filter(
      (item): item is string | number =>
        typeof item === 'string' || typeof item === 'number',
    )
    .map(String)
  return result.length === 0 ? undefined : result
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function unknownField(value: Record<string, unknown>, key: string): unknown {
  return value[key]
}
function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const result = value[key]
  return isRecord(result) ? result : undefined
}
function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const result = value[key]
  return typeof result === 'number' ? result : undefined
}
function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const result = value[key]
  return typeof result === 'string' ? result : undefined
}
function safeGet(ctx: ComemContext, name: string): unknown {
  return typeof ctx.get === 'function' ? ctx.get(name, false) : undefined
}
function isPromptRuntime(value: unknown): value is PromptRuntime {
  return (
    typeof value === 'object'
    && value !== null
    && 'section' in value
    && typeof value.section === 'function'
  )
}
function isToolRuntime(value: unknown): value is ToolRuntime {
  return (
    typeof value === 'object'
    && value !== null
    && 'register' in value
    && typeof value.register === 'function'
  )
}
function isDomain(value: unknown): value is ComemDomain {
  return (
    typeof value === 'object'
    && value !== null
    && 'table' in value
    && typeof value.table === 'function'
  )
}
