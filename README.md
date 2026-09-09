# comem

comem is a DeepSeek Harness Cordis plugin that keeps an append-only hierarchical memory tree. It follows the repository template function-plugin form and exports name, inject, Config, and apply without a default export.

## Behavior

- Each successful native or archive compact creates a new L1 node and immutable mem revision.
- Active parent nodes keep ordered child-specific Records. The first Record uses empty background, replayed current Records are used for later appends, and a rollover parent may read the previous same-layer mem exactly once.
- The logical layer cap defaults to 102,400 tokens. A full L2 node writes its layer mem revision back to that L2 node before the completed node is passed to the parameterized next layer.
- mem, Record, edge, abs, and explicit note events are append-only records in the versioned DSH `storageDomain` `comem/events` table. Reopening the domain rebuilds the tree without a currentMaterial field.
- comem_open defaults to abs; expand returns mem, ordered Records, children, and provenance; source returns provenance only. comem_search searches abs and explicit notes, and comem_note is the only shared-memory write path.

## Configuration

    - id: comem
      name: 'comem'
      config:
        logicalLayerCap: 102400
        physicalCallBudget: 0
        provider: ''
        model: ''

physicalCallBudget is a separate deployment budget: replay backgrounds are split at Record boundaries and merged into one Record or layer mem; an indivisible oversized target fails instead of being truncated. The core engine accepts an injected ComemModel and ComemStore for isolated engine tests. The runtime requires the DSH `storageDomain` service, opens the versioned `comem` domain before creating the engine, and closes it with the plugin fiber. If the service is unavailable or the domain cannot be opened, the plugin does not start; there is no `storageDir`, `comemStore`, `comemDomain`, or JSONL fallback. With DSH's default JSON backend, the memory tree is stored under `$DSH_HOME/storages/comem/events/` and the compaction recovery markers under `$DSH_HOME/storages/comem/observations/` (one directory per storage table). Runtime host-model calls use the persistent `comem` settings namespace. The Web client contributes a `Comem` settings section with a live choice between the current session model and a separately configured provider/model; the selected source applies to append, layer, and archive compression calls. In session mode, Comem resolves the session's latest request header. If that model fails, it retries the configurable number of times and then falls back to the custom provider/model. The workspace registry keeps its archive set in the `workspace` storage domain, so comem watches the durable `domain/changed` event and archive-compacts each newly archived session (sessions archived before startup are the baseline, not a backfill); `comemArchiveProvider` overrides the built-in session-content provider.

## Development

Run from this repository:

    pnpm install
    pnpm run lint
    pnpm test
    pnpm run build

The implementation is DSH-specific: runtime activation uses Cordis effects, optional DSH tools/system-prompt services, and session/event observation. Native compaction is observed rather than replaced; archive callers use the same archiveCompact operation. The memory tree is not injected into the ordinary conversation surface. The bundle patch inserts only the `comem` runtime row because the ordinary `dsh-base`/`dsh-web-app` profile does not provide the `invariants` service. The exported `./invariant` companion can be added separately in a profile that mounts `@deepseek-ai/dsh-invariants`.
