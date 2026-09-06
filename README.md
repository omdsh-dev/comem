# comem

comem is a DeepSeek Harness Cordis plugin that keeps an append-only hierarchical memory tree. It follows the repository template function-plugin form and exports name, inject, Config, and apply without a default export.

## Behavior

- Each successful native or archive compact creates a new L1 node and immutable mem revision.
- Active parent nodes keep ordered child-specific Records. The first Record uses empty background, replayed current Records are used for later appends, and a rollover parent may read the previous same-layer mem exactly once.
- The logical layer cap defaults to 102,400 tokens. A full L2 node writes its layer mem revision back to that L2 node before the completed node is passed to the parameterized next layer.
- mem, Record, edge, abs, and explicit note events are append-only JSONL records. Reopening a store rebuilds the tree without a currentMaterial field.
- comem_open defaults to abs; expand returns mem, ordered Records, children, and provenance; source returns provenance only. comem_search searches abs and explicit notes, and comem_note is the only shared-memory write path.

## Configuration

    - id: comem
      name: 'comem'
      config:
        storageDir: ~/.dsh/comem
        logicalLayerCap: 102400
        physicalCallBudget: 0
        provider: ''
        model: ''

physicalCallBudget is a separate deployment budget: replay backgrounds are split at Record boundaries and merged into one Record or layer mem; an indivisible oversized target fails instead of being truncated. The core engine accepts an injected ComemModel and ComemStore. Runtime host-model calls use the configured provider/model (or fields exposed by the host LLM service). `comemArchiveProvider` is an explicit archive seam; DSH has no native `session/archive` event. When DSH `storageDomain` is available, runtime opens the versioned `comem` domain and closes it with the plugin fiber; an already-open `comemDomain` may still be injected for tests or adapters. JSONL remains the standalone fallback.

## Development

Run from this repository:

    pnpm install
    pnpm run lint
    pnpm test
    pnpm run build

The implementation is DSH-specific: runtime activation uses Cordis effects, optional DSH tools/system-prompt services, and session/event observation. Native compaction is observed rather than replaced; archive callers use the same archiveCompact operation. The memory tree is not injected into the ordinary conversation surface.
