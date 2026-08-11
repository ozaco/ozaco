# std:plugin examples

The plugin system is built on `std:effect`'s api layer (`createApi`/`around`). Protocol and plugin
actions live under **`.actions`**, mirroring the api layer: `Db.actions.find(1)`.

Each example is a standalone script — run it from the repo root with bun:

```bash
bun run examples/std-plugin/01-db-protocol.ts
bun run examples/std-plugin/02-logger-fanout.ts
bun run examples/std-plugin/03-scoped-override.ts
```

| Example                 | Shows                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `01-db-protocol.ts`     | contract → implement → install → .actions calls, impl context, missing-install failure |
| `02-logger-fanout.ts`   | cloneable protocols, custom `exec` (fan-out to every transport), pinned plugin calls   |
| `03-scoped-override.ts` | protocol handlers, `around`/`before`/`after` hooks, scoped test fakes that revert      |

Key semantics:

- `install(plugin, ...args)` registers the impl in the **current scope**; children inherit it,
  siblings don't, and everything reverts when the scope closes.
- Protocol-level calls dispatch through the protocol's `exec` strategy (default: last-installed
  impl). Plugin handles (`MemoryDb.actions.find(...)`) always pin to their own impl.
- Hooks are api middleware over dispatch: they compose in installation order (earlier installs wrap
  later ones) and are scope-scoped like everything else.
- Reserved control members on a protocol: `name`, `version`, `tag`, `description`, `context`,
  `implement`, `around`, `before`, `after`, `error` — and on a plugin: `setup`, `getKeys`,
  `getMeta`. Action names always lose against control members.
