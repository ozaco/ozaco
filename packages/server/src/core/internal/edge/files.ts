import type { Operation } from 'std:effect'
import { attempt, toReadable } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import { ServerErrors } from '../../errors'
import type { EdgeDef } from '../../types/edge'

const TEXT = '; charset=utf-8'

/** Content types by extension — what a static directory of a web app actually holds. */
const MIME: Readonly<Record<string, string>> = {
  '.html': `text/html${TEXT}`,
  '.htm': `text/html${TEXT}`,
  '.css': `text/css${TEXT}`,
  '.js': `text/javascript${TEXT}`,
  '.mjs': `text/javascript${TEXT}`,
  '.cjs': `text/javascript${TEXT}`,
  '.json': `application/json${TEXT}`,
  '.map': `application/json${TEXT}`,
  '.webmanifest': `application/manifest+json${TEXT}`,
  '.txt': `text/plain${TEXT}`,
  '.md': `text/markdown${TEXT}`,
  '.csv': `text/csv${TEXT}`,
  '.xml': `application/xml${TEXT}`,
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/** `'/assets/**'`, `'/assets/'`, `'/assets'` → `'/assets'`; the root → `''`. */
const prefixOf = (path: string | undefined): string =>
  `/${(path ?? '/').replace(/\/\*\*(?::\w+)?$/u, '')}`.replaceAll(/\/+/gu, '/').replace(/\/$/u, '')

/** The requested relative path as segments — `null` when it tries to leave the directory
 * (`..`, a NUL, a backslash, an absolute drive) or reaches a dot-file it may not. */
const segmentsOf = (rest: string, dotfiles: boolean): string[] | null => {
  const segments = rest.split('/').filter(segment => segment !== '' && segment !== '.')

  for (const segment of segments) {
    if (
      segment === '..' ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      segment.includes(':') ||
      (!dotfiles && segment.startsWith('.'))
    ) {
      return null
    }
  }

  return segments
}

const notFound = (path: string) => fail(ServerErrors.NotFound, `no file for ${path}`)

/** Whether `path` is `root` or lies under it (after normalization). */
const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

/** Whether any step from `root` down to `segments` is a symlink — one may point outside `root`,
 * which the lexical checks cannot see (`IO` has no `realpath`, so each step is `lstat`ed). */
function* crossesSymlink(root: string, segments: readonly string[]): Operation<boolean> {
  for (const [index, segment] of segments.entries()) {
    const path = yield* IO.actions.join(root, ...segments.slice(0, index), segment)
    const stat = yield* attempt(() => IO.actions.lstat(path))

    if (isFailure(stat)) {
      return false
    }
    if (stat.value.isSymlink) {
      return true
    }
  }

  return false
}

/** One file as a response: streamed (pull-paced), typed by its extension. */
function* fileResponse(path: string, size: number, head: boolean): Operation<Response> {
  const extension = (yield* IO.actions.extname(path)).toLowerCase()
  const headers = {
    'content-type': MIME[extension] ?? 'application/octet-stream',
    'content-length': String(size),
  }

  if (head) {
    return new Response(null, { status: 200, headers })
  }

  return new Response(yield* toReadable(IO.actions.readFlow(path)), { status: 200, headers })
}

/** The raw routes `Edge.actions.static(options)` mounts: `<prefix>` and `<prefix>/**`, GET and
 * HEAD each. */
export function* staticRoutes(options: EdgeDef.StaticOptions): Operation<EdgeDef.RawRoute[]> {
  const prefix = prefixOf(options.path)
  const index = options.index ?? 'index.html'
  const dotfiles = options.dotfiles ?? false
  const followSymlinks = options.followSymlinks ?? false
  const root = (yield* IO.actions.isAbsolute(options.dir))
    ? yield* IO.actions.join(options.dir)
    : yield* IO.actions.join(yield* IO.actions.cwd(), options.dir)

  function* serve(request: Request, rest: string): Operation<Response> {
    const url = new URL(request.url)
    const segments = segmentsOf(rest, dotfiles)

    if (!segments) {
      return yield* notFound(url.pathname)
    }

    const target = yield* IO.actions.join(root, ...segments)

    // belt and braces: whatever the segments said, the normalized path must stay inside
    if (!within(root, target)) {
      return yield* notFound(url.pathname)
    }

    if (!followSymlinks && (yield* crossesSymlink(root, segments))) {
      return yield* notFound(url.pathname)
    }

    const stat = yield* attempt(() => IO.actions.stat(target))

    if (isFailure(stat)) {
      return yield* notFound(url.pathname)
    }

    const head = request.method === 'HEAD'

    if (stat.value.isFile) {
      return yield* fileResponse(target, stat.value.size, head)
    }

    if (!stat.value.isDirectory || index === false) {
      return yield* notFound(url.pathname)
    }

    const indexPath = yield* IO.actions.join(target, index)
    const indexStat = yield* attempt(() => IO.actions.stat(indexPath))

    if (
      isFailure(indexStat) ||
      !indexStat.value.isFile ||
      (!followSymlinks && (yield* crossesSymlink(root, [...segments, index])))
    ) {
      return yield* notFound(url.pathname)
    }

    return yield* fileResponse(indexPath, indexStat.value.size, head)
  }

  const routes: EdgeDef.RawRoute[] = []

  for (const method of ['GET', 'HEAD'] as const) {
    routes.push(
      {
        method,
        path: prefix === '' ? '/' : prefix,
        auth: options.auth,
        *handler(request) {
          return yield* serve(request, '')
        },
      },
      {
        method,
        path: `${prefix}/**:path`,
        auth: options.auth,
        *handler(request, params) {
          return yield* serve(request, params['path'] ?? '')
        },
      },
    )
  }

  return routes
}
