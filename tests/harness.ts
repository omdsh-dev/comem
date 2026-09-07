import { Context } from 'cordis'
import { vi } from 'vitest'

import type { ConfigShape as PluginConfig } from '#src/config'
import { Config, apply, inject, name } from '#src/index'
import type { ComemEvent } from '#src/index'
import type { ComemDomain, ComemDomainTable } from '#src/storage'

const plugin = { Config, apply, inject, name }

/** Create the minimal DSH storage-domain service used by real plugin mounts. */
export function createTestStorageDomain() {
  const values = new Map<string, ComemEvent>()
  const table: ComemDomainTable = {
    get: (key) => values.get(key),
    entries: () => values.entries(),
    put: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
  }
  const close = vi.fn<() => Promise<void>>(async () => {})
  const open = vi.fn<(spec: unknown) => Promise<ComemDomain>>(
    async (_spec: unknown): Promise<ComemDomain> => ({
      table: () => table,
      close,
    }),
  )
  return { service: { open }, values, open, close }
}

interface PluginHarness {
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  info: ReturnType<typeof vi.spyOn>
  dispose: () => Promise<void>
}

/** Mount the production plugin with an observable host logger. */
export async function createPluginHarness(
  config: PluginConfig = {},
): Promise<PluginHarness> {
  const ctx = new Context()
  const info = vi.spyOn(ctx.logger, 'info').mockReturnValue()
  const storage = createTestStorageDomain()
  ctx.provide('storageDomain', storage.service)
  const fiber = await ctx.plugin(plugin, config)

  return {
    ctx,
    fiber,
    info,
    async dispose(): Promise<void> {
      try {
        await fiber.dispose()
      } finally {
        info.mockRestore()
      }
    },
  }
}
