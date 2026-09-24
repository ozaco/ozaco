import { until } from 'std:effect'
import { fail } from 'std:result'

import { IOErrors } from '../../errors'
import type { IODef } from '../../types/io'
import { fromReadable } from '../stream/from-readable'

import {
  emptyByteFlow,
  errorMessage,
  inheritedStdinWrite,
  makeStatus,
  normalizeSpawn,
  resolveStdio,
  toBytes,
} from './shared'

/**
 * Run a command to completion with `Bun.spawn`, buffering stdout/stderr. A non-zero exit is data
 * (reported on the {@link IODef.ExecResult}), not a failure — only an inability to launch the process (or
 * a runtime error draining it) surfaces as a `Result.Failure`.
 */
export function* bunExec(cmd: string, args?: readonly string[], options?: IODef.ExecOptions) {
  const config = normalizeSpawn(options)

  let proc
  try {
    proc = Bun.spawn([cmd, ...(args ?? [])], {
      ...config,
      stdin: options?.stdin === undefined ? 'ignore' : toBytes(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    return yield* fail(IOErrors.ExecSpawnFailed, `failed to spawn "${cmd}": ${errorMessage(error)}`)
  }

  try {
    const [out, err] = yield* until(
      Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).arrayBuffer(),
        proc.exited,
      ]),
    )
    const result: IODef.ExecResult = {
      ...makeStatus(proc.exitCode, proc.signalCode),
      stdout: new Uint8Array(out),
      stderr: new Uint8Array(err),
    }
    return result
  } catch (error) {
    return yield* fail(IOErrors.ExecFailed, `command "${cmd}" failed: ${errorMessage(error)}`)
  }
}

/**
 * Spawn a long-lived child process with `Bun.spawn`, exposing its streams and lifecycle as effect
 * primitives. stdin/stdout/stderr are piped unless `stdio` inherits them (an inherited output is
 * an empty flow on the handle); consume (or `kill`) the handle within the spawning scope.
 */
export function* bunSpawn(cmd: string, args?: readonly string[], options?: IODef.SpawnOptions) {
  const config = normalizeSpawn(options)
  const stdio = resolveStdio(options?.stdio)

  let proc
  try {
    proc = Bun.spawn([cmd, ...(args ?? [])], {
      ...config,
      stdin: stdio.stdin,
      stdout: stdio.stdout,
      stderr: stdio.stderr,
    })
  } catch (error) {
    return yield* fail(IOErrors.SpawnFailed, `failed to spawn "${cmd}": ${errorMessage(error)}`)
  }

  const exited = function* () {
    yield* until(proc.exited)
    return makeStatus(proc.exitCode, proc.signalCode)
  }

  // an inherited stream is `null` on the Bun process — typed loosely here, narrowed by `stdio`
  const stdin = proc.stdin as Bun.FileSink | null
  const stdout = proc.stdout as ReadableStream<Uint8Array> | null
  const stderr = proc.stderr as ReadableStream<Uint8Array> | null

  const write = function* (chunk: Uint8Array | string) {
    if (!stdin) {
      return yield* inheritedStdinWrite()
    }

    try {
      stdin.write(toBytes(chunk))
      yield* until(Promise.resolve(stdin.flush()))
    } catch (error) {
      return yield* fail(IOErrors.StdinWriteFailed, `failed to write stdin: ${errorMessage(error)}`)
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
        `failed to kill pid ${proc.pid}: ${errorMessage(error)}`,
      )
    }
  }

  const handle: IODef.ProcessHandle = {
    pid: proc.pid,
    stdout: stdout ? fromReadable(stdout.getReader() as IODef.WebReadableLike) : emptyByteFlow(),
    stderr: stderr ? fromReadable(stderr.getReader() as IODef.WebReadableLike) : emptyByteFlow(),
    exited,
    write,
    closeStdin,
    kill,
  }
  return handle
}
