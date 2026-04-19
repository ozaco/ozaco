export const tap =
  <T>(fn: (value: T) => void) =>
  (value: T): T => {
    fn(value)
    return value
  }
