import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { adapterFromEnv } from './providers.js'

const { adapter, reasons } = adapterFromEnv(process.env)
const here = path.dirname(fileURLToPath(import.meta.url))
const dist = [path.resolve(here, '../dist'), path.resolve(here, '../../dist')].find((p) => fs.existsSync(path.join(p, 'index.html')))

const app = createApp({
  adapter,
  reasons,
  chunkBudgetChars: Number(process.env.AI_CHUNK_CHARS) || undefined,
  maxAudioBytes: Number(process.env.AI_MAX_AUDIO_BYTES) || undefined,
  staticDir: dist,
})
const port = Number(process.env.PORT) || 8787
const host = process.env.HOST || '127.0.0.1'
app.listen(port, host, () => {
  console.log(`생각바로 서버: http://${host}:${port}  (AI ${adapter ? adapter.name : '미연결'})`)
  for (const r of reasons) console.log(` - ${r}`)
})
