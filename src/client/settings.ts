import type { ReactNode } from 'react'

export type ModelSource = 'session' | 'configured'

export interface ModelSettings {
  source: ModelSource
  fallbackAttempts: number
  provider: string
  model: string
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  source: 'session',
  fallbackAttempts: 1,
  provider: '',
  model: '',
}

export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  writable: boolean
}

/** One queued namespace field operation (the host wire shape). */
export interface SettingsPathOp {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

/**
 * The host settings scope bound to this plugin's namespace. Methods keep their
 * receiver: the host controller reads its own state through `this`, so a bare
 * method reference loses the instance.
 */
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsPathOp[]): Promise<void>
}

/**
 * Receiver-safe observable face of one settings scope. React reads
 * `getSnapshot`/`subscribe` as bare callbacks (`useSyncExternalStore`), so the
 * page never hands the host scope's instance methods over unbound.
 */
export interface SettingsScopeSource<T> {
  readonly getSnapshot: () => SettingsScopeSnapshot<T>
  readonly subscribe: (listener: () => void) => () => void
}

export function settingsScopeSource<T>(
  scope: SettingsScope<T>,
): SettingsScopeSource<T> {
  return {
    getSnapshot: () => scope.getSnapshot(),
    subscribe: (listener) => scope.subscribe(listener),
  }
}

export interface ClientContext {
  locale: {
    bind(namespace: string): (key: string) => string
    register(namespace: string, dictionaries: unknown): () => void
  }
  settingsScope: {
    bind(spec: { namespace: string }): SettingsScope<ModelSettings>
  }
  effect(callback: () => () => void, name: string): void
  slots: {
    inject(name: string, callback: () => () => void): unknown
    register(
      options: {
        name: string
        id: string
        order: number
        label: () => string
        inject: () => {
          scope: SettingsScope<ModelSettings>
          t: (key: string) => string
        }
      },
      component: (props: {
        scope: SettingsScope<ModelSettings>
        t: (key: string) => string
      }) => ReactNode,
    ): () => void
  }
}

export function normalizedSettings(
  value: ModelSettings | undefined,
): ModelSettings {
  return {
    source: value?.source === 'configured' ? 'configured' : 'session',
    fallbackAttempts:
      Number.isSafeInteger(value?.fallbackAttempts)
      && (value?.fallbackAttempts ?? 0) >= 0
        ? value!.fallbackAttempts
        : DEFAULT_MODEL_SETTINGS.fallbackAttempts,
    provider: value?.provider ?? '',
    model: value?.model ?? '',
  }
}
