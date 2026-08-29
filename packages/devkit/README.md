# @ozaco/devkit

Two ways to import the Ozaco packages. Pick one per project — they are not meant to be mixed.

## Mode 1 — with devkit: the aliases

`@ozaco/devkit` is a types-only package. Listing it under `types` loads the ambient module
declarations, and every package becomes importable under its short alias — the same spelling the
Ozaco repo itself uses.

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "types": ["node", "bun", "@ozaco/devkit"],
  },
}
```

```ts
import { install } from 'std:plugin'
import { column, DbClient, table } from 'db:core'
import { MemoryAdapter } from 'db:impl/memory'
import { action, service } from 'server:core'
```

Aliases: `std:*`, `transport:*`, `db:*`, `server:*`, `client:*`, `ai:*`, `cli:*` — the full list is
in [`ambient.d.ts`](./ambient.d.ts).

The declarations are types only — whatever RUNS the code has to resolve the aliases as well.

**Bundled app** (vite/rollup/rolldown/webpack/esbuild) — `kitResolve` covers all seven families
and hands each alias to the bundler as the package it publishes under:

```ts
import { kitResolve } from '@ozaco/devkit/resolve'

export default defineConfig({
  plugins: [kitResolve.vite()],
})
```

**Bun / Node, run straight from source** — no bundler, so the aliases go in `paths`, which Bun
reads at runtime:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "std:*": ["./node_modules/@ozaco/std/dist/*"],
      "db:core": ["./node_modules/@ozaco/db/dist/index"],
      "db:*": ["./node_modules/@ozaco/db/dist/*"],
      "server:core": ["./node_modules/@ozaco/server/dist/index"],
      "server:impl/edge/*": ["./node_modules/@ozaco/server/dist/edge/*"],
      "server:*": ["./node_modules/@ozaco/server/dist/*"],
    },
  },
}
```

`examples/demo` in this repo is the worked example of the Bun flavour, `apps/panel` and
`apps/observe` of the bundled one. The per-package plugins (`stdResolve`, `dbResolve`, …) are for
building the Ozaco packages themselves, not for apps.

### Keeping `@ozaco/*` out

In this mode the `@ozaco/*` specifiers are the wrong spelling — but they keep resolving, because
they are what the aliases are made of (and what every package's own `.d.ts` imports). TypeScript
cannot be told to reject them without breaking those declarations, so the guard is a lint rule.

Extend the shipped lint preset; `@ozaco/*` imports become errors (`@ozaco/devkit` itself stays
allowed — the build plugin is imported by package specifier):

```jsonc
// .oxlintrc.json
{
  "extends": ["./node_modules/@ozaco/devkit/oxlintrc.json"],
}
```

## Mode 2 — without devkit: the packages

Install nothing extra and import the published specifiers. Everything works out of the box: the
shipped declarations name only `@ozaco/*`, so no alias resolution — and no bundler plugin — is
involved.

```ts
import { install } from '@ozaco/std/plugin'
import { column, DbClient, table } from '@ozaco/db'
import { MemoryAdapter } from '@ozaco/db/impl/memory'
import { action, service } from '@ozaco/server'
```

In this mode the aliases are simply not declared: `import 'std:plugin'` fails to resolve, which is
the intended asymmetry.
