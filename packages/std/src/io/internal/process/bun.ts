import { until } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { IOErrors } from '../../errors'
import type { IODef } from '../../types/io'
import { fromReadable } from '../stream/from-readable'

import {
  detachFlags,
  emptyByteFlow,
  inheritedStdinWrite,
  makeExecResult,
  makeStatus,
  normalizeSpawn,
  resolveStdio,
  toBytes,
  unlessDetached,
} from './shared'
import { openStdio } from './stdio'

/**
 * Run a command to completion with `Bun.spawn`, buffering stdout/stderr. A non-zero exit is data
 * (reported on the {@link IODef.ExecResult}), not a failure — only an inability to launch the process (or
 * a runtime error draining it) surfaces as a `Result.Failure`.
 */
export function* bunExec(cmd: string, args?: readonly string[], options?: IODef.ExecOptions) {
  const config = normalizeSpawn(options)
  const argv = args ?? []

  let proc

  try {
    proc = Bun.spawn([cmd, ...argv], {
      ...config,
      stdin: options?.stdin === undefined ? 'ignore' : toBytes(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    return yield* fail(
      IOErrors.ExecSpawnFailed,
      `failed to spawn "${cmd}"`,
      asFailure(error, IOErrors),
    )
  }

  try {
    const [out, err] = yield* until(
      Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).arrayBuffer(),
        proc.exited,
      ]),
    )

    return makeExecResult([cmd, ...argv], makeStatus(proc.exitCode, proc.signalCode), {
      stdout: new Uint8Array(out),
      stderr: new Uint8Array(err),
    })
  } catch (error) {
    return yield* fail(IOErrors.ExecFailed, `command "${cmd}" failed`, asFailure(error, IOErrors))
  }
}

/**
 * Spawn a long-lived child process with `Bun.spawn`, exposing its streams and lifecycle as effect
 * primitives. stdin/stdout/stderr are piped unless `stdio` says otherwise (a stream that is not
 * piped is an empty flow on the handle); consume (or `kill`, or `detach`) the handle within the
 * spawning scope.
 */
export function* bunSpawn(cmd: string, args?: readonly string[], options?: IODef.SpawnOptions) {
  const config = normalizeSpawn(options)
  const stdio = resolveStdio(options?.stdio)
  const opened = yield* openStdio(stdio)

  let proc

  try {
    proc = Bun.spawn([cmd, ...(args ?? [])], {
      ...config,
      ...detachFlags(options),
      stdin: opened.stdin,
      stdout: opened.stdout,
      stderr: opened.stderr,
    })
  } catch (error) {
    yield* opened.close()

    return yield* fail(IOErrors.SpawnFailed, `failed to spawn "${cmd}"`, asFailure(error, IOErrors))
  }

  yield* opened.close()

  const exited = function* () {
    yield* until(proc.exited)

    return makeStatus(proc.exitCode, proc.signalCode)
  }

  // a stream that is not piped is no stream on the Bun process — narrowed by `stdio`, not by type
  const stdin = stdio.stdin === 'pipe' ? (proc.stdin as Bun.FileSink) : null
  const stdout = stdio.stdout === 'pipe' ? (proc.stdout as ReadableStream<Uint8Array>) : null
  const stderr = stdio.stderr === 'pipe' ? (proc.stderr as ReadableStream<Uint8Array>) : null
  const outReader = stdout?.getReader()
  const errReader = stderr?.getReader()

  let detached = false

  const write = function* (chunk: Uint8Array | string) {
    if (!stdin || detached) {
      return yield* inheritedStdinWrite()
    }

    try {
      stdin.write(toBytes(chunk))
      yield* until(Promise.resolve(stdin.flush()))
    } catch (error) {
      return yield* fail(
        IOErrors.StdinWriteFailed,
        `failed to write stdin`,
        asFailure(error, IOErrors),
      )
    }
  }

  const closeStdin = function* () {
    if (stdin) {
      yield* until(Promise.resolve(stdin.end()))
    }
  }

  const kill = function* (signal?: number | string) {
    try {
      // Bun takes a signal NAME as well as a number; the cast only narrows to the overload TS picks
      proc.kill(signal as number | undefined)
    } catch (error) {
      return yield* fail(
        IOErrors.KillFailed,
        `failed to kill pid ${proc.pid}`,
        asFailure(error, IOErrors),
      )
    }
  }

  // `unref` lets the event loop exit with the child running; cancelling the readers closes the
  // parent's pipe ends (the handle's flows end `true`), `end` the stdin sink
  const detach = function* () {
    if (detached) {
      return
    }

    detached = true
    proc.unref()
    yield* closeStdin()
    yield* until(Promise.all([outReader?.cancel(), errReader?.cancel()]).catch(() => {}))
  }

  const isDetached = () => detached

  const handle: IODef.ProcessHandle = {
    pid: proc.pid,
    stdout: outReader
      ? unlessDetached(fromReadable(outReader as IODef.WebReadableLike), isDetached)
      : emptyByteFlow(),
    stderr: errReader
      ? unlessDetached(fromReadable(errReader as IODef.WebReadableLike), isDetached)
      : emptyByteFlow(),
    exited,
    write,
    closeStdin,
    kill,
    detach,
  }

  return handle
}
