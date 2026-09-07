/** Browser settings page for the Comem compression model. */
import { createElement, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

const LOCALE_NAMESPACE = 'comem.settings'
const locales = {
  zh: {
    nav: 'Comem',
    title: 'Comem 多层压缩模型',
    description:
      '选择 Comem 生成层级摘要和压缩结果时使用的 provider 与 model。',
    source: '压缩使用的模型',
    session: '使用当前会话模型',
    configured: '使用单独配置的模型',
    sessionDescription: '跟随当前会话最近一次请求所使用的模型。',
    configuredDescription: '使用下面单独配置的 provider 和 model。',
    fallbackAttempts: '当前会话失败次数后回退',
    provider: 'Provider',
    model: 'Model',
    providerPlaceholder: '例如 deepseek 或 pi-ai',
    modelPlaceholder: '例如 deepseek-chat',
    save: '保存',
    saving: '保存中…',
    saved: '已保存',
    unavailable: '设置持久化不可用。',
  },
  en: {
    nav: 'Comem',
    title: 'Comem multi-layer compression model',
    description:
      'Choose the provider and model Comem uses for hierarchical summaries and compression.',
    source: 'Compression model source',
    session: 'Use the current session model',
    configured: 'Use a separately configured model',
    sessionDescription:
      "Follow the model used by the current session's latest request.",
    configuredDescription:
      'Use the separately configured provider and model below.',
    fallbackAttempts: 'Session failures before fallback',
    provider: 'Provider',
    model: 'Model',
    providerPlaceholder: 'For example, deepseek or pi-ai',
    modelPlaceholder: 'For example, deepseek-chat',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    unavailable: 'Settings persistence is unavailable.',
  },
} as const

export type ModelSource = 'session' | 'configured'
export interface ModelSettings {
  source: ModelSource
  fallbackAttempts: number
  provider: string
  model: string
}
interface SettingsScopeSnapshot<T> {
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
    bind(namespace: string): (key: keyof typeof locales.en) => string
    register(namespace: string, dictionaries: typeof locales): () => void
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
          t: (key: keyof typeof locales.en) => string
        }
      },
      component: (props: {
        scope: SettingsScope<ModelSettings>
        t: (key: keyof typeof locales.en) => string
      }) => ReactNode,
    ): () => void
  }
}

function ComemSettingsPage({
  scope,
  t,
}: {
  scope: SettingsScope<ModelSettings>
  t: (key: keyof typeof locales.en) => string
}): ReactNode {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const resolved = snapshot.value ?? {
    source: 'session' as const,
    fallbackAttempts: 1,
    provider: '',
    model: '',
  }
  const [source, setSource] = useState<ModelSource>(resolved.source)
  const [fallbackAttempts, setFallbackAttempts] = useState(
    resolved.fallbackAttempts,
  )
  const [provider, setProvider] = useState(resolved.provider)
  const [model, setModel] = useState(resolved.model)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    setSource(resolved.source)
    setFallbackAttempts(resolved.fallbackAttempts)
    setProvider(resolved.provider)
    setModel(resolved.model)
  }, [
    resolved.source,
    resolved.fallbackAttempts,
    resolved.provider,
    resolved.model,
  ])
  const disabled = saving || snapshot.status !== 'ready' || !snapshot.writable
  const configured = source === 'configured'
  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      await scope.mutate([
        { op: 'set', path: ['source'], value: source },
        {
          op: 'set',
          path: ['fallbackAttempts'],
          value: Math.max(0, Math.floor(fallbackAttempts)),
        },
        { op: 'set', path: ['provider'], value: provider.trim() },
        { op: 'set', path: ['model'], value: model.trim() },
      ])
      setMessage(t('saved'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return createElement(
    'section',
    { style: { maxWidth: 680, padding: '8px 0' } },
    createElement('h2', null, t('title')),
    createElement('p', { style: { opacity: 0.72 } }, t('description')),
    createElement(
      'label',
      { style: { display: 'block', marginTop: 16 } },
      createElement(
        'span',
        { style: { display: 'block', marginBottom: 6 } },
        t('source'),
      ),
      createElement(
        'select',
        {
          value: source,
          disabled,
          onChange: (event: { target: { value: ModelSource } }) =>
            setSource(event.target.value),
          style: { width: '100%', boxSizing: 'border-box', padding: 8 },
        },
        createElement('option', { value: 'session' }, t('session')),
        createElement('option', { value: 'configured' }, t('configured')),
      ),
      createElement(
        'span',
        { style: { display: 'block', marginTop: 6, opacity: 0.72 } },
        configured ? t('configuredDescription') : t('sessionDescription'),
      ),
    ),
    createElement(
      'label',
      { style: { display: 'block', marginTop: 16 } },
      createElement(
        'span',
        { style: { display: 'block', marginBottom: 6 } },
        t('fallbackAttempts'),
      ),
      createElement('input', {
        type: 'number',
        min: 0,
        step: 1,
        value: fallbackAttempts,
        disabled,
        onChange: (event: { target: { value: string } }) =>
          setFallbackAttempts(Number(event.target.value)),
        style: { width: '100%', boxSizing: 'border-box', padding: 8 },
      }),
    ),
    createElement(
      'label',
      { style: { display: 'block', marginTop: 16 } },
      createElement(
        'span',
        { style: { display: 'block', marginBottom: 6 } },
        t('provider'),
      ),
      createElement('input', {
        value: provider,
        disabled: disabled || !configured,
        placeholder: t('providerPlaceholder'),
        onChange: (event: { target: { value: string } }) =>
          setProvider(event.target.value),
        style: { width: '100%', boxSizing: 'border-box', padding: 8 },
      }),
    ),
    createElement(
      'label',
      { style: { display: 'block', marginTop: 16 } },
      createElement(
        'span',
        { style: { display: 'block', marginBottom: 6 } },
        t('model'),
      ),
      createElement('input', {
        value: model,
        disabled: disabled || !configured,
        placeholder: t('modelPlaceholder'),
        onChange: (event: { target: { value: string } }) =>
          setModel(event.target.value),
        style: { width: '100%', boxSizing: 'border-box', padding: 8 },
      }),
    ),
    createElement(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginTop: 20,
        },
      },
      createElement(
        'button',
        { type: 'button', disabled, onClick: () => void save() },
        saving ? t('saving') : t('save'),
      ),
      createElement('span', { role: 'status', 'aria-live': 'polite' }, message),
    ),
    snapshot.status === 'unavailable'
      ? createElement('p', { style: { opacity: 0.72 } }, t('unavailable'))
      : null,
  )
}

export const name = 'comem'
export const inject = ['locale', 'settingsScope', 'slots']
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, locales),
    'comem: settings dictionaries',
  )
  const scope = ctx.settingsScope.bind({ namespace: 'comem' })
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'comem',
        order: 20,
        label: () => t('nav'),
        inject: () => ({ scope, t }),
      },
      ComemSettingsPage,
    ),
  )
}
