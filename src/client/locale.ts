export const LOCALE_NAMESPACE = 'comem.settings'

export const locales = {
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
    fallbackAttempts: '当前会话失败次数后回退到自定义模型',
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
    fallbackAttempts: 'Session failures before custom-model fallback',
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

export type LocaleKey = keyof typeof locales.en
