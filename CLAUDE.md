# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**All workflows must go through Moon** - never invoke Bun/OXC directly except for debugging.

```bash
bun install                           # Install dependencies (Bun 1.3.9 pinned via Moon)
moon run :check                       # Full lint + format check (oxlint + oxfmt)
moon run :apply                       # Auto-fix formatting and lint
moon run :apply-unsafe                # Auto-fix with dangerous rewrites (oxlint --fix-dangerous)
moon run :clean                       # Reset build artifacts (dist, .ozaco)
moon run std:build                    # Build @ozaco/std package (tsdown)
```

Pre-commit hook runs `moon run :check --affected`.

## Architecture

This is a TypeScript monorepo for building CLI tools and a standard library (`@ozaco/std`).

**Workspaces:** `packages/`, `plugins/`, `apps/`, `tools/`

### @ozaco/std Modules

The core package exports these modules via path aliases (e.g., `std:result`, `std:logger`):

- **result** - `Result<T,E>` type with utilities: `fail`, `succeed`, `appendCauses`, `orElse`, `pipe`, `guard`, `map`
- **shared** - Common types (`BlobType`, `Helpers`) and utilities (`isPromise`, `isResult`, timing)
- **event** - Event system
- **plugin** - Plugin architecture with context, dependency lists, extendable APIs
- **logger** - Logger with transport abstraction
- **logger/create-transport** - Base transport definitions for extending logger
- **logger/file-transport** - File transport implementation
- **color** - Styling/color utilities with logger plugin

### Key Patterns

- **Error handling:** Use Result helpers (`fail`, `succeed`, `appendCauses`, `orElse`), avoid bare throws
- **Exports:** Use `const` arrows, keep modules side-effect free, re-export through `index.ts` barrels
- **Async:** Use `isPromise`/`isResult` helpers, return promises instead of mixing await with mutation
- **Immutability:** Default immutable, mutate only when APIs require it (e.g., pushing into `failure.causes`)
- **New utilities:** Add to `packages/std/src/<domain>/utils`, export immediately

## Code Style

OXC is canonical (oxlint + oxfmt): 2 spaces, width 100, single quotes, JSX single quotes, trailing commas `all`, no semicolons.

- **Import order:** external packages → `std:*` aliases → relatives
- **Use `import type`** for type-only imports
- **Naming:** camelCase values, PascalCase types, SCREAMING_SNAKE_CASE for shared constants
- **TypeScript:** Honor `tsconfig.base.json` strictness (no relaxing `strict`, `verbatimModuleSyntax`)
