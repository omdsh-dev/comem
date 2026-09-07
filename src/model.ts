/** Model and host seams used by comem. */

export interface ComemModelRequest {
  readonly kind: 'archive' | 'append' | 'layer' | 'abs'
  readonly background: string
  readonly target: string
  readonly instruction: string
  /** Session whose active request model should be used in session mode. */
  readonly sessionId?: string
  /** Internal provider/model override used by fallback attempts. */
  readonly provider?: string
  readonly model?: string
  readonly physicalBudget?: number
}

export interface ComemModelResult {
  readonly content: string
  readonly provider?: string
  readonly model?: string
  readonly usage?: Record<string, number>
}

export interface ComemModel {
  compact(request: ComemModelRequest): Promise<ComemModelResult>
  summarize(request: ComemModelRequest): Promise<ComemModelResult>
}

/** Deterministic fallback used when DSH's LLM seam is not mounted. */
export const localComemModel: ComemModel = {
  compact(request) {
    return Promise.resolve({ content: request.target })
  },
  summarize(request) {
    const firstLine = request.target.split(/\r?\n/u)[0] ?? request.target
    return Promise.resolve({ content: firstLine.slice(0, 500) })
  },
}
