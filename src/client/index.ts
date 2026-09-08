import { ComemSettingsPage } from './ComemSettingsPage.tsx'
import { LOCALE_NAMESPACE, locales } from './locale.ts'
import type { ClientContext } from './settings.ts'

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

export type {
  ClientContext,
  ModelSettings,
  SettingsPathOp,
  SettingsScope,
  SettingsScopeSnapshot,
  SettingsScopeSource,
} from './settings.ts'
export { settingsScopeSource } from './settings.ts'
