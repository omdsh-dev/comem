/** Serializable comem configuration and resolved defaults. */

import schema from 'schemastery'

const DEFAULT_LOGICAL_LAYER_CAP = 102_400
const DEFAULT_PHYSICAL_CALL_BUDGET = 0
const DEFAULT_STORAGE_DIR = '~/.dsh/comem'

interface ConfigShape {
  storageDir?: string
  logicalLayerCap?: number
  physicalCallBudget?: number
  provider?: string
  model?: string
}
interface ResolvedConfig {
  storageDir: string
  logicalLayerCap: number
  physicalCallBudget: number
  provider: string
  model: string
}
const Config: schema<ConfigShape> = schema.object({
  storageDir: schema.string().default(DEFAULT_STORAGE_DIR),
  logicalLayerCap: schema.natural().default(DEFAULT_LOGICAL_LAYER_CAP),
  physicalCallBudget: schema.natural().default(DEFAULT_PHYSICAL_CALL_BUDGET),
  provider: schema.string().default(''),
  model: schema.string().default(''),
})
function resolveConfig(config: ConfigShape = {}): ResolvedConfig {
  return {
    storageDir: config.storageDir ?? DEFAULT_STORAGE_DIR,
    logicalLayerCap: config.logicalLayerCap ?? DEFAULT_LOGICAL_LAYER_CAP,
    physicalCallBudget:
      config.physicalCallBudget ?? DEFAULT_PHYSICAL_CALL_BUDGET,
    provider: config.provider ?? '',
    model: config.model ?? '',
  }
}

export { Config, resolveConfig, type ConfigShape, type ResolvedConfig }
