import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { $rm, $write, $writeJson } from '@ozaco/std/io'
import { Err, Ok, ResultAsync } from '@ozaco/std/results'
import type { BlobType } from '@ozaco/std/shared'

describe('std/io/write', () => {
  describe('text', () => {
    const txtFilePath = join(__dirname, './correct.txt')
    const txtFileContent = 'hi this is alice zuberg'

    afterEach(async () => {
      ;(await $rm(txtFilePath)).unwrap()
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
      await $rm(jsonFilePath)
      await $rm(incorrectJsonFilePath)
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
