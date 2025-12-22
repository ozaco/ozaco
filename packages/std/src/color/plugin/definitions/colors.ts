import { formatter } from './formatter'

export const colors = formatter.extend(({ def: formatter }) => {
  return {
    reset: formatter('\x1b[0m', '\x1b[0m'),

    style: {
      bold: formatter('\x1b[1m', '\x1b[22m', '\x1b[22m\x1b[1m'),
      dim: formatter('\x1b[2m', '\x1b[22m', '\x1b[22m\x1b[2m'),
      italic: formatter('\x1b[3m', '\x1b[23m'),
      underline: formatter('\x1b[4m', '\x1b[24m'),
      inverse: formatter('\x1b[7m', '\x1b[27m'),
      hidden: formatter('\x1b[8m', '\x1b[28m'),
      strikethrough: formatter('\x1b[9m', '\x1b[29m'),
    },

    text: {
      black: formatter('\x1b[30m', '\x1b[39m'),
      red: formatter('\x1b[31m', '\x1b[39m'),
      green: formatter('\x1b[32m', '\x1b[39m'),
      yellow: formatter('\x1b[33m', '\x1b[39m'),
      blue: formatter('\x1b[34m', '\x1b[39m'),
      magenta: formatter('\x1b[35m', '\x1b[39m'),
      cyan: formatter('\x1b[36m', '\x1b[39m'),
      white: formatter('\x1b[37m', '\x1b[39m'),
      gray: formatter('\x1b[90m', '\x1b[39m'),
    },

    textBright: {
      red: formatter('\x1b[91m', '\x1b[39m'),
      green: formatter('\x1b[92m', '\x1b[39m'),
      yellow: formatter('\x1b[93m', '\x1b[39m'),
      blue: formatter('\x1b[94m', '\x1b[39m'),
      magenta: formatter('\x1b[95m', '\x1b[39m'),
      cyan: formatter('\x1b[96m', '\x1b[39m'),
      white: formatter('\x1b[97m', '\x1b[39m'),
    },

    bg: {
      black: formatter('\x1b[40m', '\x1b[49m'),
      red: formatter('\x1b[41m', '\x1b[49m'),
      green: formatter('\x1b[42m', '\x1b[49m'),
      yellow: formatter('\x1b[43m', '\x1b[49m'),
      blue: formatter('\x1b[44m', '\x1b[49m'),
      magenta: formatter('\x1b[45m', '\x1b[49m'),
      cyan: formatter('\x1b[46m', '\x1b[49m'),
      white: formatter('\x1b[47m', '\x1b[49m'),
      gray: formatter('\x1b[100m', '\x1b[49m'),
    },

    bgBright: {
      red: formatter('\x1b[101m', '\x1b[49m'),
      green: formatter('\x1b[102m', '\x1b[49m'),
      yellow: formatter('\x1b[103m', '\x1b[49m'),
      blue: formatter('\x1b[104m', '\x1b[49m'),
      magenta: formatter('\x1b[105m', '\x1b[49m'),
      cyan: formatter('\x1b[106m', '\x1b[49m'),
      white: formatter('\x1b[107m', '\x1b[49m'),
    },
  }
})
