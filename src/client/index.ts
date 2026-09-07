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

export interface ModelSettings {
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
  const resolved = snapshot.value ?? { provider: '', model: '' }
  const [provider, setProvider] = useState(resolved.provider)
  const [model, setModel] = useState(resolved.model)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    setProvider(resolved.provider)
    setModel(resolved.model)
  }, [resolved.provider, resolved.model])
  const disabled = saving || snapshot.status !== 'ready' || !snapshot.writable
  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      await scope.mutate([
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
        t('provider'),
      ),
      createElement('input', {
        value: provider,
        disabled,
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
        disabled,
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
