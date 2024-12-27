import { afterEach, describe, expect, test } from 'bun:test'
import { exists, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { $write, $writeJson } from '../../../dist/io'
import { Err, Ok, ResultAsync } from '../../../dist/results'
import type { BlobType } from '../../../dist/shared'

const removeFile = async (path: string) => {
  if (await exists(path)) {
    await unlink(path)
  }
}

describe('std/io/write', () => {
  describe('text', () => {
    const txtFilePath = join(__dirname, './correct.txt')
    const txtFileContent = 'hi this is alice zuberg'

    afterEach(async () => {
      await removeFile(txtFilePath)
    })

    test('correct', async () => {
      const result = $write(txtFilePath, txtFileContent)
      const called = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(called).toBeInstanceOf(Ok)

      const file = Bun.file(txtFilePath)

      expect(await file.exists()).toBe(true)
      expect(await file.text()).toBe(txtFileContent)
    })
  })

  describe('json', () => {
    const jsonFilePath = join(__dirname, './correct.json')
    const jsonFileContent = { name: 'alice', surname: 'zuberg' }

    const incorrectJsonFilePath = join(__dirname, './correct.data')
    const incorrectJsonFileContent = undefined

    afterEach(async () => {
      await removeFile(jsonFilePath)
      await removeFile(incorrectJsonFilePath)
    })

    test('correct', async () => {
      const result = $writeJson(jsonFilePath, jsonFileContent)
      const called = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(called).toBeInstanceOf(Ok)

      const file = Bun.file(jsonFilePath)

      expect(await file.exists()).toBe(true)
      expect(await file.json()).toEqual(jsonFileContent)
    })

    test('incorrect', async () => {
      const result = $writeJson(incorrectJsonFilePath, incorrectJsonFileContent as BlobType)
      const called = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(called).toBeInstanceOf(Err)

      if (called.isErr()) {
        expect(called.name).toBe('std/io.invalid-mime')
      }

      const file = Bun.file(jsonFilePath)

      expect(await file.exists()).toBe(false)
    })
  })
})
