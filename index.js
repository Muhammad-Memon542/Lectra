
import express from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import os from 'os'

const app = express()
const upload = multer({ dest: path.join(os.tmpdir(), 'lectra-chunks') })

// Store per-session chunks in tmp
app.post('/api/ingest/chunk', upload.single('chunk'), (req, res) => {
  const sessionId = req.body.sessionId || 'no-session'
  const dir = path.join(os.tmpdir(), 'lectra-sessions', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, req.file.originalname || `chunk-${Date.now()}.webm`)
  fs.renameSync(req.file.path, dest)
  res.json({ ok: true })
})

app.post('/api/ingest/finalize', express.json(), (req, res) => {
  const { sessionId } = req.body || {}
  if (!sessionId) return res.status(400).json({ error: 'missing sessionId' })
  const dir = path.join(os.tmpdir(), 'lectra-sessions', sessionId)
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.webm')).sort() : []
  // For demo: we don't merge. We just confirm receipt.
  res.json({ ok: true, receivedChunks: files.length, sessionId })
})

const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  console.log(`[lectra-api] listening on http://localhost:${PORT}`)
})
