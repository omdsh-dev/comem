import { describe, expect, it, vi } from 'vitest'

import { apply, inject, name } from '#src/client/index'
import type {
  ClientContext,
  ModelSettings,
  SettingsScope,
} from '#src/client/index'

describe('Comem client settings page', () => {
  it('registers a settings section through the slot lifecycle', () => {
    const disposer = vi.fn<() => void>(() => {})
    const scope: SettingsScope<ModelSettings> = {
      getSnapshot: () => ({
        status: 'ready',
        value: {
          source: 'session',
          fallbackAttempts: 1,
          provider: '',
          model: '',
        },
        writable: true,
      }),
      subscribe: () => () => {},
      mutate: vi.fn<SettingsScope<ModelSettings>['mutate']>(async () => {}),
    }
    const register = vi.fn<ClientContext['slots']['register']>(() => disposer)
    const slotInject = vi.fn<ClientContext['slots']['inject']>(
      (_name, callback) => callback(),
    )
    const localeRegister = vi.fn<ClientContext['locale']['register']>(
      () => disposer,
    )
    const ctx: ClientContext = {
      locale: { bind: () => (key) => key, register: localeRegister },
      settingsScope: { bind: () => scope },
      effect: (callback) => {
        callback()
      },
      slots: { inject: slotInject, register },
    }

    apply(ctx)

    expect(name).toBe('comem')
    expect(inject).toStrictEqual(['locale', 'settingsScope', 'slots'])
    expect(slotInject).toHaveBeenCalledWith(
      'settings.section',
      expect.any(Function),
    )
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'settings.section',
        id: 'comem',
        order: 20,
      }),
      expect.any(Function),
    )
    disposer()
    expect(disposer).toHaveBeenCalledTimes(1)
  })
})
