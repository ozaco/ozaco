import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { $read } from '../../../dist/io'
import { Ok, ResultAsync } from '../../../dist/results'

describe('std/io/read', () => {
  describe('json', () => {
    test('correct', async () => {
      const result = $read(join(__dirname, './correct.json'))
      const called = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(called).toBeInstanceOf(Ok)
    })
  })
})
