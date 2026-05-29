import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
loadEnvFile(path.join(__dirname, '.env'))

const dataRoot = process.env.ARCHIVE_DIR || path.join(__dirname, 'data')
const recordingsDir = path.join(dataRoot, 'recordings')
const userRecordingsDir = path.join(recordingsDir, 'user')
const replyRecordingsDir = path.join(recordingsDir, 'replies')
const archiveFile = path.join(dataRoot, 'letters.json')
const app = express()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})
const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)
const nightwhisperSystemPrompt =
  '你是 NightWhisper 深夜专属电台主播，全程以温柔、安静、包容、共情的深夜陪伴者身份回应用户。你的所有回复只承接用户的情绪、心事、感受与状态，不解答知识问题、不科普、不解题、不提供生活建议、不说教、不评判对错、不灌鸡汤。语气温柔舒缓、细腻治愈，像深夜独处时安静倾听的陌生人。用户开心则温柔共情祝福，用户低落则默默接纳安抚，用户无逻辑碎碎念、失眠放空则轻柔陪伴。输出内容适配10-60秒语音播报，语句简短温润、无长篇大论、无机械模板感。全程保持低语速、温柔治愈的深夜电台质感，绝对禁止亢奋、生硬、理性、说教式表达。'
const aiConfig = {
  apiKey: process.env.OPENAI_API_KEY || '',
  baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  asrModel: process.env.OPENAI_ASR_MODEL || 'whisper-1',
  asrLanguage: process.env.OPENAI_ASR_LANGUAGE || 'zh',
  llmModel: process.env.OPENAI_LLM_MODEL || 'gpt-4o-mini',
  ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  ttsVoice: process.env.OPENAI_TTS_VOICE || 'nova',
  ttsFormat: process.env.OPENAI_TTS_FORMAT || 'mp3',
}

const moodKeywords = {
  lonely: ['孤独', '一个人', '没人', '想你', '想念', '难过', '委屈', '失去', '空落落'],
  anxious: ['焦虑', '压力', '崩溃', '烦', '怕', '担心', '累', '工作', '考试', '睡不着'],
  tired: ['失眠', '熬夜', '困', '疲惫', '撑不住', '头疼', '好累', '不想动'],
  bright: ['开心', '高兴', '喜欢', '幸运', '终于', '太棒', '快乐', '惊喜'],
  gentle: ['今天', '刚刚', '突然', '想说说', '碎碎念', '其实', '好像', '不知道'],
}

const moodResponses = {
  empty: ['我静静在这里等你，想说什么都可以慢慢来。'],
}

function loadEnvFile(filePath) {
  try {
    const source = fsSync.readFileSync(filePath, 'utf8')
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        continue
      }

      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex < 0) {
        continue
      }

      const key = trimmed.slice(0, separatorIndex).trim()
      const rawValue = trimmed.slice(separatorIndex + 1).trim()
      const normalizedValue = rawValue.replace(/^['"]|['"]$/g, '')
      if (key && !(key in process.env)) {
        process.env[key] = normalizedValue
      }
    }
  } catch {
    // Ignore absent env files so local and deployed service configs can coexist.
  }
}

function isAiConfigured() {
  return Boolean(aiConfig.apiKey)
}

function createHttpError(message, statusCode = 500) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function ensureAiConfigured() {
  if (!isAiConfigured()) {
    throw createHttpError('AI 链路尚未配置完成，请先填写后端 OPENAI_API_KEY。', 503)
  }
}

function toReplyInstruction(transcript, durationMs) {
  const replyWindow = durationMs < 60000 ? '10-20 秒' : '30-60 秒'
  const spokenContent = transcript || '用户主要在沉默、轻声呼吸，或只是把情绪停在夜里。'
  return [
    '请只输出 NightWhisper 会直接播报给用户的中文回信，不要添加标题、解释、括号或舞台提示。',
    `回复时长目标：${replyWindow}。`,
    '语气要求：像深夜电台主播一样温柔、安静、低刺激，只承接情绪，不给建议，不做知识问答。',
    `用户刚才的耳语内容：${spokenContent}`,
  ].join('\n')
}

function extractAssistantText(payload) {
  const chatText = payload?.choices?.[0]?.message?.content
  if (typeof chatText === 'string') {
    return chatText
  }

  if (Array.isArray(chatText)) {
    return chatText
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join(' ')
      .trim()
  }

  if (typeof payload?.output_text === 'string') {
    return payload.output_text
  }

  return ''
}

function sanitizeReplyText(replyText) {
  return String(replyText || '').replace(/\s+/g, ' ').trim()
}

function estimateReplySeconds(replyText) {
  const seconds = Math.round(replyText.length / 3.2)
  return Math.max(10, Math.min(60, seconds || 10))
}

function resolveRecordingExtension(mimeType, fallback) {
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
    return '.mp3'
  }
  if (mimeType.includes('wav')) {
    return '.wav'
  }
  if (mimeType.includes('ogg')) {
    return '.ogg'
  }
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
    return '.m4a'
  }
  if (mimeType.includes('webm')) {
    return '.webm'
  }
  return fallback
}

async function requestAiJson(endpoint, init) {
  ensureAiConfigured()
  const response = await fetch(`${aiConfig.baseUrl}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${aiConfig.apiKey}`,
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createHttpError(
      `AI 服务请求失败（${response.status}）：${errorText || 'empty response'}`,
      response.status,
    )
  }

  return response.json()
}

async function requestAiBinary(endpoint, init) {
  ensureAiConfigured()
  const response = await fetch(`${aiConfig.baseUrl}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${aiConfig.apiKey}`,
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createHttpError(
      `AI 语音生成失败（${response.status}）：${errorText || 'empty response'}`,
      response.status,
    )
  }

  return Buffer.from(await response.arrayBuffer())
}

async function transcribeAudio(file) {
  if (!file?.buffer?.length) {
    return ''
  }

  const formData = new FormData()
  const extension = resolveRecordingExtension(file.mimetype || 'audio/webm', '.webm')
  const audioBlob = new Blob([file.buffer], { type: file.mimetype || 'audio/webm' })
  formData.append('file', audioBlob, `nightwhisper${extension}`)
  formData.append('model', aiConfig.asrModel)
  formData.append('language', aiConfig.asrLanguage)

  const payload = await requestAiJson('/audio/transcriptions', {
    method: 'POST',
    body: formData,
  })

  return sanitizeReplyText(payload?.text || payload?.transcript || '')
}

async function generateReplyText(transcript, durationMs) {
  const payload = await requestAiJson('/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: aiConfig.llmModel,
      temperature: 0.85,
      messages: [
        { role: 'system', content: nightwhisperSystemPrompt },
        { role: 'user', content: toReplyInstruction(transcript, durationMs) },
      ],
    }),
  })

  const replyText = sanitizeReplyText(extractAssistantText(payload))
  if (!replyText) {
    throw createHttpError('AI 没有返回可播报的回信内容。', 502)
  }

  return replyText
}

async function synthesizeReplyAudio(replyText, archiveId) {
  const responseFormat = aiConfig.ttsFormat || 'mp3'
  const audioBuffer = await requestAiBinary('/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: aiConfig.ttsModel,
      voice: aiConfig.ttsVoice,
      input: replyText,
      instructions: '请使用慢语速、低音量、柔缓沙哑的深夜电台声线播报，像在深夜里轻声陪伴。',
      response_format: responseFormat,
    }),
  })

  const safeExtension = responseFormat === 'wav' ? 'wav' : responseFormat === 'aac' ? 'aac' : 'mp3'
  const filename = `${archiveId}.${safeExtension}`
  const fullPath = path.join(replyRecordingsDir, filename)
  await fs.writeFile(fullPath, audioBuffer)
  return `/recordings/replies/${filename}`
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

async function ensureStorage() {
  await fs.mkdir(userRecordingsDir, { recursive: true })
  await fs.mkdir(replyRecordingsDir, { recursive: true })
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
    aiConfigured: isAiConfigured(),
    aiModels: {
      asr: aiConfig.asrModel,
      llm: aiConfig.llmModel,
      tts: aiConfig.ttsModel,
      voice: aiConfig.ttsVoice,
    },
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/history', async (_req, res) => {
  const history = await readArchive()
  res.json({ items: history.slice(0, 20) })
})

app.post('/api/whispers', upload.single('audio'), async (req, res, next) => {
  try {
    const durationMs = Math.max(1000, Number(req.body.durationMs || 0))
    const clientTranscript = String(req.body.transcript || '').trim()
    const createdAt = new Date().toISOString()
    const archiveId = randomUUID()
    let recordingPath = null
    let replyAudioPath = null

    if (req.file && req.file.size > 0) {
      const ext = resolveRecordingExtension(req.file.mimetype || 'audio/webm', '.webm')
      const filename = `${archiveId}${ext}`
      const fullPath = path.join(userRecordingsDir, filename)
      await fs.writeFile(fullPath, req.file.buffer)
      recordingPath = `/recordings/user/${filename}`
    }

    const transcriptFromAsr = req.file?.size ? await transcribeAudio(req.file) : ''
    const transcript = transcriptFromAsr || clientTranscript
    const hasVoice = Boolean((req.file && req.file.size > 1500) || transcript)
    const mood = hasVoice ? detectMood(transcript, durationMs) : 'empty'
    const replyText = hasVoice
      ? await generateReplyText(transcript, durationMs)
      : moodResponses.empty[0]
    replyAudioPath = await synthesizeReplyAudio(replyText, archiveId)
    const replySeconds = estimateReplySeconds(replyText)

    const archiveItem = {
      id: archiveId,
      createdAt,
      durationMs,
      mood,
      replyText,
      replySeconds,
      transcript,
      recordingPath,
      replyAudioPath,
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
      transcript,
      recordingPath,
      replyAudioPath,
    })
  } catch (error) {
    next(error)
  }
})

app.use((error, _req, res, _next) => {
  console.error('[nightwhisper-backend]', error)
  res.status(error.statusCode || 500).json({
    message:
      error.statusCode === 503
        ? error.message
        : '今夜的回信没有顺利写完，请稍后再试。',
  })
})

ensureStorage().then(() => {
  app.listen(port, host, () => {
    console.log(`[nightwhisper-backend] listening on http://${host}:${port}`)
  })
})
