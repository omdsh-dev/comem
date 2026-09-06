# Comem Contributor Notes

This repository is the standalone DeepSeek Harness Comem plugin.

- Preserve the function-plugin named exports: `name`, `inject`, `Config`, and `apply`; do not add a default export.
- Keep Loader metadata in `src/index.ts`, schema/defaults in `src/config.ts`, and host boundaries plus activation in `src/runtime.ts`.
- Keep all registrations scoped to the plugin fiber and test disposal.
- Keep host-provided runtime APIs as peer dependencies and resolve development imports from this repository's declared dependencies.
- Do not add source, configuration, documentation, project-reference, `link:`, or `file:` paths that leave this repository.
- Update `README.md`, configuration JSDoc, tests, and `cordis.patch.yml` together when behavior changes.
- `patches/` and patch-only scripts are intentionally absent because Comem currently requires no dependency or DSH host patch.
- Keep the repository-local `.agents/skills/dsh-plugin-*` workflow synchronized with this repository's paths, commands, and package conventions.
- Run `pnpm run lint`, `pnpm test`, and `pnpm run build` before publishing changes.
