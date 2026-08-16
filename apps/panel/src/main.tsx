import { createRoot } from 'react-dom/client'

import { App } from './app'
import { applyStoredTheme } from './lib'

// oxlint-disable-next-line import/no-unassigned-import -- the tailwind entry is side-effect only
import './styles.css'

applyStoredTheme()

const root = document.querySelector('#root')

if (root) {
  createRoot(root).render(<App />)
}
