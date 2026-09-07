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

export interface SettingsScope<T> {
  getSnapshot: () => SettingsScopeSnapshot<T>
  subscribe: (listener: () => void) => () => void
  mutate: (
    ops: readonly {
      op: 'set' | 'unset'
      path: readonly string[]
      value?: unknown
    }[],
  ) => Promise<void>
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
