import { describe, expect, it } from 'bun:test'

describe('app — lifecycle', () => {
  it('roles + graceful stop; the process exits naturally with nothing leaked', async () => {
    const fixture = new URL('../fixtures/lifecycle.ts', import.meta.url).pathname
    const started = Date.now()
    const proc = Bun.spawn(['bun', fixture], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), 15_000)
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    clearTimeout(timer)
    expect(err).toBe('')
    expect(out.trim().split('\n').slice(-2)).toEqual(['stopped', 'all-done'])
    expect(code).toBe(0)
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})
