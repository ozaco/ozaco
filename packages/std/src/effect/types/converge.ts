export interface ConvergeOptions {
  timeout?: number | undefined
  interval?: number | undefined
}

export interface ConvergeStats<T> {
  start: number
  end: number
  elapsed: number
  runs: number
  timeout: number
  interval: number
  value: T
}
