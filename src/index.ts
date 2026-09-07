/** DSH comem memory-tree plugin. */
const name = 'comem'
const inject: string[] = ['storageDomain']
export { Config, resolveConfig } from './config.ts'
export type { ConfigShape as ComemConfig, ResolvedConfig } from './config.ts'
export { apply, archiveSession, createComemRuntime } from './runtime.ts'
export type {
  ComemArchiveProvider,
  ComemArchiveResult,
  ComemRuntime,
} from './runtime.ts'
export { ComemEngine } from './tree.ts'
export type * from './tree.ts'
export { DomainComemStore, MemoryComemStore } from './storage.ts'
export type {
  ComemModel,
  ComemModelRequest,
  ComemModelResult,
} from './model.ts'
export { inject, name }
