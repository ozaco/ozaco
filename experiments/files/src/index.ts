import './definition'
import '@ozaco/std/effects'

import { $readFrom, $writeTo } from '@ozaco/std/io'
import { join } from 'node:path'

import { logger } from './consts'

const EMPTY_BUFFER = Buffer.from('')
const DECODER = new TextDecoder()

Bun.serve({
  port: 3000,
  async fetch() {
    await using reader = (await $readFrom(join(import.meta.dir, './example.txt'))).unwrap()
    await using writer = (await $writeTo(join(import.meta.dir, './example-2.txt'))).unwrap()

    let total = 0n
    let remainder = ''

    for await (const chunk of reader) {
      const data = DECODER.decode(chunk.else(EMPTY_BUFFER))

      const currentData = remainder + data

      remainder = ''

      const splitted = currentData.split(',')
      if (data.at(-1) !== ',') {
        remainder = splitted.pop() || ''
      }

      for (const part of splitted) {
        if (part.trim() === '') {
          continue
        }

        total += BigInt(part)
      }

      await writer.write(Buffer.from(`${total.toString()}\n`))
    }

    if (remainder.trim() !== '') {
      total += BigInt(remainder)
      await writer.write(Buffer.from(`${total.toString()}\n`))
    }

    logger.log('total', total.toString())

    return new Response(total.toString())
  },
})

export * from './consts'
export * from './tag'
