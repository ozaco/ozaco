import type { SetReturnType } from 'type-fest'

export const throttle = <C extends (...args: any[]) => any>(mainFunction: C, delay: number) => {
  let timerFlag: NodeJS.Timeout | null = null

  return ((...args) => {
    if (timerFlag === null) {
      mainFunction(...args)

      timerFlag = setTimeout(() => {
        timerFlag = null
      }, delay)
    }
  }) as SetReturnType<C, Awaited<ReturnType<C>>>
}

export const prettyMs = (value: number) => {
  const seconds = Math.floor(value / 1000) % 60
  const milliseconds = Math.floor(value % 1000)

  if (seconds) {
    return `${seconds}.${milliseconds}s`
  }

  return `${milliseconds}ms`
}
