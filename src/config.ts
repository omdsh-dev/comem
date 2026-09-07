/**
 * Serializable comem configuration and resolved defaults. Persistence is
 * provided exclusively by the host `storageDomain` service; no filesystem
 * storage path is configurable.
 */

import schema from 'schemastery'

const DEFAULT_LOGICAL_LAYER_CAP = 102_400
const DEFAULT_PHYSICAL_CALL_BUDGET = 0

interface ConfigShape {
  logicalLayerCap?: number
  physicalCallBudget?: number
  /** Composition default provider; the Web settings page can override it. */
  provider?: string
  /** Composition default model; the Web settings page can override it. */
  model?: string
}
type ModelSource = 'session' | 'configured'
interface ResolvedConfig {
  logicalLayerCap: number
  physicalCallBudget: number
  provider: string
  model: string
}
const Config: schema<ConfigShape> = schema.object({
  logicalLayerCap: schema.natural().default(DEFAULT_LOGICAL_LAYER_CAP),
  physicalCallBudget: schema.natural().default(DEFAULT_PHYSICAL_CALL_BUDGET),
  provider: schema.string().default(''),
  model: schema.string().default(''),
})

/**
 * The user-editable model selection used by all Comem compression passes.
 * source=session follows the originating session; source=configured uses the
 * provider and model entered on the Comem settings page.
 */
const ComemModelSettings: schema<{
  source: ModelSource
  fallbackAttempts: number
  provider: string
  model: string
}> = schema.object({
  source: schema
    .union([schema.const('session'), schema.const('configured')])
    .default('session'),
  fallbackAttempts: schema.natural().default(1),
  provider: schema.string().default(''),
  model: schema.string().default(''),
})
function resolveConfig(config: ConfigShape = {}): ResolvedConfig {
  return {
    logicalLayerCap: config.logicalLayerCap ?? DEFAULT_LOGICAL_LAYER_CAP,
    physicalCallBudget:
      config.physicalCallBudget ?? DEFAULT_PHYSICAL_CALL_BUDGET,
    provider: config.provider ?? '',
    model: config.model ?? '',
  }
}

export {
  ComemModelSettings,
  Config,
  resolveConfig,
  type ConfigShape,
  type ModelSource,
  type ResolvedConfig,
}
