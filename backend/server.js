import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataRoot = process.env.ARCHIVE_DIR || path.join(__dirname, 'data')
const recordingsDir = path.join(dataRoot, 'recordings')
const archiveFile = path.join(dataRoot, 'letters.json')
const app = express()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})
const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)

const moodKeywords = {
  lonely: ['孤独', '一个人', '没人', '想你', '想念', '难过', '委屈', '失去', '空落落'],
  anxious: ['焦虑', '压力', '崩溃', '烦', '怕', '担心', '累', '工作', '考试', '睡不着'],
  tired: ['失眠', '熬夜', '困', '疲惫', '撑不住', '头疼', '好累', '不想动'],
  bright: ['开心', '高兴', '喜欢', '幸运', '终于', '太棒', '快乐', '惊喜'],
  gentle: ['今天', '刚刚', '突然', '想说说', '碎碎念', '其实', '好像', '不知道'],
}

const moodResponses = {
  lonely: [
    '我听见你把那些没来得及说出口的想念，轻轻放进了夜里。今夜不用急着变得坚强，先让我陪你把这份空落落安安静静地放一会儿。',
    '有些委屈在白天找不到落点，到了深夜才敢慢慢浮上来。你可以就这样靠近一点，把心里的沉默交给我，我会替你把它接住。',
    '一个人的夜晚总会把情绪放大一些，可你不是独自漂着的。至少此刻，这段耳语有了回声，也有人在认真听你。'
  ],
  anxious: [
    '那些盘旋不下去的念头，我都听到了。今夜先不用把一切想明白，只要把呼吸放轻一点，让心里的褶皱慢慢松开就好。',
    '你已经撑了很久，所以才会在这一刻觉得紧绷。别急着整理世界，先把自己轻轻放下来，剩下的天亮以后再说也来得及。',
    '我知道你不是故意要这样焦灼，只是心里装了太多事。先让夜色替你挡一挡风，你可以在这里短暂地不用逞强。'
  ],
  tired: [
    '听起来你真的很累了，像把整天的重量都拖到了这一刻。那就先别赶路了，把疲惫交给我，今晚只需要慢一点、轻一点。',
    '当身体和心都在发沉的时候，连一句完整的话都显得费力。没关系，你说到哪里都算数，我会陪你把这段夜晚走得柔一点。',
    '如果今夜只是想安静躺着，也已经很好了。你不需要继续证明自己还撑得住，先让这份疲惫有一个落脚的地方。'
  ],
  bright: [
    '我听见你语气里那一点亮亮的开心了，像深夜窗边刚好落下来的柔光。这样的好心情很珍贵，值得被轻轻珍藏起来。',
    '原来今夜也有温柔的小确幸在发生，这真好。谢谢你把这份亮度分给我一点，让整片夜色都显得更柔和了。',
    '你说起那些开心的时候，连空气都跟着松快了一些。愿这份轻轻发亮的心情，能陪你把今晚也过得温暖一点。'
  ],
  gentle: [
    '我在听，你可以不用整理逻辑，也不用把情绪说得很完整。深夜本来就适合让心事慢慢散开，我会陪着你把这些碎片放稳。',
    '有些话不一定非要有答案，只是想在安静里被听见。你就这样继续说也很好，今夜不需要急着下结论。',
    '你能把这些细小又真实的感受交给我，本身就很珍贵。夜很深了，心也可以稍微松一松，在这里待一会儿。'
  ],
  empty: ['我静静在这里等你，想说什么都可以慢慢来。'],
}

function detectMood(transcript, durationMs) {
  const normalized = String(transcript || '').trim()
  if (!normalized && durationMs < 2000) {
    return 'empty'
  }

  for (const [mood, keywords] of Object.entries(moodKeywords)) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return mood
    }
  }

  if (durationMs > 90000) {
    return 'tired'
  }

  return normalized ? 'gentle' : 'empty'
}

function createReply(mood, durationMs) {
  const pool = moodResponses[mood] || moodResponses.empty
  const replyText = pool[Math.floor(Math.random() * pool.length)] || moodResponses.empty[0]
  const replySeconds = durationMs < 60000 ? 10 + Math.floor(Math.random() * 11) : 30 + Math.floor(Math.random() * 31)
  return { replyText, replySeconds }
}

async function ensureStorage() {
  await fs.mkdir(recordingsDir, { recursive: true })
  try {
    await fs.access(archiveFile)
  } catch {
    await fs.writeFile(archiveFile, '[]\n', 'utf8')
  }
}

async function readArchive() {
  await ensureStorage()
  const content = await fs.readFile(archiveFile, 'utf8')
  try {
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeArchive(records) {
  await ensureStorage()
  await fs.writeFile(archiveFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
}

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }))
app.use(express.json({ limit: '8mb' }))
app.use('/recordings', express.static(recordingsDir))

app.get('/api/health', async (_req, res) => {
  const history = await readArchive()
  res.json({
    status: 'ok',
    service: 'nightwhisper-backend',
    host,
    port,
    archiveCount: history.length,
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/history', async (_req, res) => {
  const history = await readArchive()
  res.json({ items: history.slice(0, 20) })
})

app.post('/api/whispers', upload.single('audio'), async (req, res, next) => {
  try {
    const durationMs = Number(req.body.durationMs || 0)
    const transcript = String(req.body.transcript || '').trim()
    const createdAt = new Date().toISOString()
    const hasVoice = Boolean((req.file && req.file.size > 1500) || transcript)
    const mood = hasVoice ? detectMood(transcript, durationMs) : 'empty'
    const { replyText, replySeconds } = createReply(mood, durationMs)
    const archiveId = randomUUID()
    let recordingPath = null

    if (req.file && req.file.size > 0) {
      const ext = req.file.mimetype.includes('ogg') ? '.ogg' : '.webm'
      const filename = `${archiveId}${ext}`
      const fullPath = path.join(recordingsDir, filename)
      await fs.writeFile(fullPath, req.file.buffer)
      recordingPath = `/recordings/${filename}`
    }

    const archiveItem = {
      id: archiveId,
      createdAt,
      durationMs,
      mood,
      replyText,
      replySeconds,
      transcript,
      recordingPath,
    }

    const history = await readArchive()
    history.unshift(archiveItem)
    await writeArchive(history.slice(0, 300))

    res.json({
      archiveId,
      createdAt,
      mood,
      replyText,
      replySeconds,
      recordingPath,
    })
  } catch (error) {
    next(error)
  }
})

app.use((error, _req, res, _next) => {
  console.error('[nightwhisper-backend]', error)
  res.status(500).json({ message: '今夜的回信没有顺利写完，请稍后再试。' })
})

ensureStorage().then(() => {
  app.listen(port, host, () => {
    console.log(`[nightwhisper-backend] listening on http://${host}:${port}`)
  })
})
