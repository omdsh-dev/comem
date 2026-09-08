import * as React from 'react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import {
  type ModelSettings,
  type SettingsScope,
  normalizedSettings,
  settingsScopeSource,
} from './settings.ts'

interface Props {
  scope: SettingsScope<ModelSettings>
  t: (key: string) => string
}

function isModelSource(value: string): value is ModelSettings['source'] {
  return value === 'session' || value === 'configured'
}

export function ComemSettingsPage({ scope, t }: Props): ReactNode {
  // Bind the scope's methods to the instance: React invokes the observable
  // callbacks as bare functions and the host controller's methods need `this`.
  const source = useMemo(() => settingsScopeSource(scope), [scope])
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const resolved = normalizedSettings(snapshot.value)
  const [draft, setDraft] = useState<ModelSettings>(resolved)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    setDraft(resolved)
  }, [
    resolved.source,
    resolved.fallbackAttempts,
    resolved.provider,
    resolved.model,
  ])

  const disabled = saving || snapshot.status !== 'ready' || !snapshot.writable
  const configured = draft.source === 'configured'
  const update = <K extends keyof ModelSettings>(
    key: K,
    value: ModelSettings[K],
  ) => setDraft((current) => ({ ...current, [key]: value }))

  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      await scope.mutate([
        { op: 'set', path: ['source'], value: draft.source },
        {
          op: 'set',
          path: ['fallbackAttempts'],
          value: draft.fallbackAttempts,
        },
        { op: 'set', path: ['provider'], value: draft.provider.trim() },
        { op: 'set', path: ['model'], value: draft.model.trim() },
      ])
      setMessage(t('saved'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const numberChange = (event: { target: { value: string } }) => {
    const value = Number.parseInt(event.target.value, 10)
    update(
      'fallbackAttempts',
      Number.isSafeInteger(value) && value >= 0 ? value : 0,
    )
  }

  return (
    <section style={{ maxWidth: 680, padding: '8px 0' }}>
      <h2>{t('title')}</h2>
      <p style={{ opacity: 0.72 }}>{t('description')}</p>

      <label style={{ display: 'block', marginTop: 16 }}>
        <span style={{ display: 'block', marginBottom: 6 }}>{t('source')}</span>
        <select
          value={draft.source}
          disabled={disabled}
          onChange={(event) => {
            if (isModelSource(event.target.value))
              update('source', event.target.value)
          }}
          style={{ width: '100%', boxSizing: 'border-box', padding: 8 }}
        >
          <option value='session'>{t('session')}</option>
          <option value='configured'>{t('configured')}</option>
        </select>
        <span style={{ display: 'block', marginTop: 6, opacity: 0.72 }}>
          {t(configured ? 'configuredDescription' : 'sessionDescription')}
        </span>
      </label>

      <label style={{ display: 'block', marginTop: 16 }}>
        <span style={{ display: 'block', marginBottom: 6 }}>
          {t('fallbackAttempts')}
        </span>
        <input
          type='number'
          min={0}
          step={1}
          value={draft.fallbackAttempts}
          disabled={disabled || configured}
          onChange={numberChange}
          style={{ width: '100%', boxSizing: 'border-box', padding: 8 }}
        />
      </label>

      <label style={{ display: 'block', marginTop: 16 }}>
        <span style={{ display: 'block', marginBottom: 6 }}>
          {t('provider')}
        </span>
        <input
          value={draft.provider}
          disabled={disabled || !configured}
          placeholder={t('providerPlaceholder')}
          onChange={(event) => update('provider', event.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', padding: 8 }}
        />
      </label>

      <label style={{ display: 'block', marginTop: 16 }}>
        <span style={{ display: 'block', marginBottom: 6 }}>{t('model')}</span>
        <input
          value={draft.model}
          disabled={disabled || !configured}
          placeholder={t('modelPlaceholder')}
          onChange={(event) => update('model', event.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', padding: 8 }}
        />
      </label>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginTop: 20,
        }}
      >
        <button type='button' disabled={disabled} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </button>
        <span role='status' aria-live='polite'>
          {message}
        </span>
      </div>
      {snapshot.status === 'unavailable' && (
        <p style={{ opacity: 0.72 }}>{t('unavailable')}</p>
      )}
    </section>
  )
}
