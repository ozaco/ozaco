/** Whether `flag` (a single bit or bit mask) is set within the `flags` bitfield. */
export const hasFlag = (flags: number, flag: number): boolean => (flags & flag) !== 0
