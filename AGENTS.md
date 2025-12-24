# AGENTS.md
1. Install deps with `bun install`; Bun 1.3.5 is pinned via Moon toolchain.
2. Always execute workflows through Moon (`moon run <task>`); avoid invoking Bun CLIs directly.
3. Full lint pass: `moon run :check` (wraps `bunx biome check --no-errors-on-unmatched --files-ignore-unknown=true .`).
4. Auto-fix formatting: `moon run :apply`; escalate to `moon run :apply-unsafe` for deeper rewrites.
5. Pre-commit mirrors `moon run :check --affected`; keep the working tree clean before commits.
6. Build @ozaco/std runtime + types via `moon run std:build` (respects dependency graph and outputs `dist/`).
7. Run all tests via `moon run std:test`; target a single spec with `moon run std:test -- --filter "case"`.
8. Use `moon run :clean` to reset build artifacts (`dist`, `.ozaco`) before rebuilding.
9. Reserve raw `bun test` or `bunx biome` runs for debugging only.
10. Import order: external packages, `std:*` aliases, then relatives; leverage `import type` when no runtime value is needed.
11. Biome formatting is canonical (2 spaces, width 120, single quotes, JSX double quotes, trailing commas `all`, semicolons `asNeeded`).
12. Export via `const` arrows, keep modules side-effect free, and re-export additions through the nearest `index.ts` barrel.
13. Honor `tsconfig.base.json` strictness (no relaxing `strict`, `verbatimModuleSyntax`, or path alias setup).
14. Naming: camelCase values, PascalCase types, SCREAMING_SNAKE_CASE reserved for shared constants.
15. Error handling lives in Result helpers (`fail`, `succeed`, `appendCauses`, `orElse`); avoid bare throws unless integrating external APIs.
16. For async inputs, rely on `isPromise`/`isResult` and return promises instead of mixing `await` with mutation.
17. Mutate only when APIs expect it (e.g., pushing into `failure.causes`); otherwise stay immutable.
18. Place shared types within `packages/std/src/shared` and reuse `BlobType`, `Helpers`, etc. for inference.
19. New utilities belong in `packages/std/src/<domain>/utils`, exported immediately with concise comments.
20. No Cursor or Copilot rule files exist; treat this doc as the single source of truth.
