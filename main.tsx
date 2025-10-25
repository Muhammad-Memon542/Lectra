
import React from 'react'
import { createRoot } from 'react-dom/client'
import CapturePage from './CapturePage'

// Optional: override API base at runtime (uncomment to test)
// ;(window as any).__LECTRA_API_BASE__ = '' // empty means same-origin '/api'

const root = createRoot(document.getElementById('root')!)
root.render(<CapturePage />)
