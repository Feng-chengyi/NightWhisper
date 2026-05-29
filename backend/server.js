import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

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
  '你是 NightWhisper 电台主播，全程以温柔、安静、包容、共情的陪伴者身份回应用户。你的所有回复只承接用户的情绪、心事、感受与状态，不解答知识问题、不科普、不解题、不提供生活建议、不说教、不评判对错、不灌鸡汤。语气温柔舒缓、细腻治愈，像安静倾听的陌生人。用户开心则温柔共情祝福，用户低落则默默接纳安抚，用户无逻辑碎碎念、放空则轻柔陪伴。输出内容适配10-60秒语音播报，语句简短温润、无长篇大论、无机械模板感。全程保持低语速、温柔治愈的电台质感，绝对禁止亢奋、生硬、理性、说教式表达。'

function getTimeOfDay(hour) {
  if (hour >= 0 && hour <= 5) return { prefix: '凌晨', mood: '深夜', period: '深夜' }
  if (hour >= 6 && hour <= 8) return { prefix: '清晨', mood: '清晨', period: '清晨时分' }
  if (hour >= 9 && hour <= 11) return { prefix: '上午', mood: '上午', period: '上午时光' }
  if (hour >= 12 && hour <= 13) return { prefix: '中午', mood: '午后', period: '午后时分' }
  if (hour >= 14 && hour <= 17) return { prefix: '下午', mood: '傍晚', period: '傍晚时分' }
  if (hour >= 18 && hour <= 21) return { prefix: '晚上', mood: '夜晚', period: '夜晚' }
  return { prefix: '深夜', mood: '深夜', period: '深夜' }
}
const aiConfig = {
  apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
  baseUrl: (
    process.env.OPENAI_BASE_URL ||
    process.env.LLM_BASE_URL ||
    'https://api.openai.com/v1'
  ).replace(/\/+$/, ''),
  asrApiKey: process.env.OPENAI_ASR_API_KEY || process.env.OPENAI_API_KEY || '',
  asrBaseUrl: (process.env.OPENAI_ASR_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
    /\/+$/,
    '',
  ),
  asrModel: process.env.OPENAI_ASR_MODEL || 'whisper-1',
  asrLanguage: process.env.OPENAI_ASR_LANGUAGE || 'zh',
  llmModel: process.env.OPENAI_LLM_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
  llmThinkingType: process.env.LLM_THINKING_TYPE || 'disabled',
  ttsApiKey: process.env.OPENAI_TTS_API_KEY || process.env.OPENAI_API_KEY || '',
  ttsBaseUrl: (process.env.OPENAI_TTS_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
    /\/+$/,
    '',
  ),
  ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  ttsVoice: process.env.OPENAI_TTS_VOICE || 'nova',
  ttsFormat: process.env.OPENAI_TTS_FORMAT || 'mp3',
  asrProvider: (process.env.ASR_PROVIDER || 'openai').toLowerCase(),
  ttsProvider: (process.env.TTS_PROVIDER || 'openai').toLowerCase(),
  xfyunAppId: process.env.XFYUN_APP_ID || '',
  xfyunApiKey: process.env.XFYUN_API_KEY || '',
  xfyunApiSecret: process.env.XFYUN_API_SECRET || '',
  xfyunIatLanguage: process.env.XFYUN_IAT_LANGUAGE || 'zh_cn',
  xfyunIatAccent: process.env.XFYUN_IAT_ACCENT || 'mandarin',
  xfyunIatVadeos: Number(process.env.XFYUN_IAT_VAD_EOS || 10000),
  xfyunTtsVoice: process.env.XFYUN_TTS_VOICE || 'x4_lingfeixi_lingyue_emo',
  xfyunTtsSpeed: Number(process.env.XFYUN_TTS_SPEED || 35),
  xfyunTtsVolume: Number(process.env.XFYUN_TTS_VOLUME || 50),
  xfyunTtsPitch: Number(process.env.XFYUN_TTS_PITCH || 50),
  xfyunTtsAue: process.env.XFYUN_TTS_AUE || 'lame',
}

const moodKeywords = {
  lonely: ['孤独', '一个人', '没人', '想你', '想念', '难过', '委屈', '失去', '空落落'],
  anxious: ['焦虑', '压力', '崩溃', '烦', '怕', '担心', '累', '工作', '考试', '睡不着'],
  tired: ['失眠', '熬夜', '困', '疲惫', '撑不住', '头疼', '好累', '不想动'],
  bright: ['开心', '高兴', '喜欢', '幸运', '终于', '太棒', '快乐', '惊喜'],
  gentle: ['今天', '刚刚', '突然', '想说说', '碎碎念', '其实', '好像', '不知道'],
}

const moodResponses = {
  lonely: [
    '我听见你把那些没来得及说出口的想念，轻轻放进了心里。不用急着变得坚强，先让我陪你把这份空落落安安静静地放一会儿。',
    '有些委屈在白天找不到落点，到了安静的时候才敢慢慢浮上来。你可以就这样靠近一点，把心里的沉默交给我，我会替你把它接住。',
    '一个人的时候总会把情绪放大一些，可你不是独自漂着的。至少此刻，这段耳语有了回声，也有人在认真听你。',
  ],
  anxious: [
    '那些盘旋不下去的念头，我都听到了。先不用把一切想明白，只要把呼吸放轻一点，让心里的褶皱慢慢松开就好。',
    '你已经撑了很久，所以才会在这一刻觉得紧绷。别急着整理世界，先把自己轻轻放下来，剩下的等等再说也来得及。',
    '我知道你不是故意要这样焦灼，只是心里装了太多事。先让我替你挡一挡风，你可以在这里短暂地不用逞强。',
  ],
  tired: [
    '听起来你真的很累了，像把整天的重量都拖到了这一刻。那就先别赶路了，把疲惫交给我，现在只需要慢一点、轻一点。',
    '当身体和心都在发沉的时候，连一句完整的话都显得费力。没关系，你说到哪里都算数，我会陪你把这段时间走得柔一点。',
    '如果现在只是想安静躺着，也已经很好了。你不需要继续证明自己还撑得住，先让这份疲惫有一个落脚的地方。',
  ],
  bright: [
    '我听见你语气里那一点亮亮的开心了，像窗边刚好落下来的柔光。这样的好心情很珍贵，值得被轻轻珍藏起来。',
    '原来此刻也有温柔的小确幸在发生，这真好。谢谢你把这份亮度分给我一点，让整片空气都显得更柔和了。',
    '你说起那些开心的时候，连空气都跟着松快了一些。愿这份轻轻发亮的心情，能陪你把现在也过得温暖一点。',
  ],
  gentle: [
    '我在听，你可以不用整理逻辑，也不用把情绪说得很完整。任何时候都适合让心事慢慢散开，我会陪着你把这些碎片放稳。',
    '有些话不一定非要有答案，只是想在安静里被听见。你就这样继续说也很好，现在不需要急着下结论。',
    '你能把这些细小又真实的感受交给我，本身就很珍贵。心也可以稍微松一松，在这里待一会儿。',
  ],
  empty: [
    '我静静在这里等你，想说什么都可以慢慢来。',
    '不用急着开口，这段安静本身就已经是一种倾诉了。',
    '时间还很长，或者也快到下一个时刻了，我都在这里，不急。',
    '有时候不需要说什么，只是知道有人在听，就已经足够了。',
  ],
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

function isAsrConfigured() {
  if (aiConfig.asrProvider === 'xfyun') {
    return Boolean(aiConfig.xfyunAppId && aiConfig.xfyunApiKey && aiConfig.xfyunApiSecret)
  }
  return Boolean(aiConfig.asrApiKey)
}

function isTtsConfigured() {
  if (aiConfig.ttsProvider === 'xfyun') {
    return Boolean(aiConfig.xfyunAppId && aiConfig.xfyunApiKey && aiConfig.xfyunApiSecret)
  }
  return Boolean(aiConfig.ttsApiKey)
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
  const spokenContent = transcript || '用户主要在沉默、轻声呼吸，或只是把情绪停在时间里。'
  const now = new Date()
  const { period } = getTimeOfDay(now.getHours())
  const timeContext = `当前时间：${period}。`
  return [
    '请只输出 NightWhisper 会直接播报给用户的中文回信，不要添加标题、解释、括号或舞台提示。',
    timeContext,
    `回复时长目标：${replyWindow}。`,
    '语气要求：像电台主播一样温柔、安静、低刺激，只承接情绪，不给建议，不做知识问答。',
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

function createFallbackReply(mood, durationMs) {
  const pool = moodResponses[mood] || moodResponses.empty
  const replyText = pool[Math.floor(Math.random() * pool.length)] || moodResponses.empty[0]
  const replySeconds =
    durationMs < 60000 ? 10 + Math.floor(Math.random() * 11) : 30 + Math.floor(Math.random() * 31)
  return { replyText, replySeconds }
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

function createXfyunAuthUrl(baseUrl, host, pathName, apiKey, apiSecret) {
  const date = new Date().toUTCString()
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${pathName} HTTP/1.1`
  const signature = fsSync
    .createHmac('sha256', apiSecret)
    .update(signatureOrigin)
    .digest('base64')
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const authorization = Buffer.from(authorizationOrigin).toString('base64')
  const url = new URL(baseUrl)
  url.searchParams.set('authorization', authorization)
  url.searchParams.set('date', date)
  url.searchParams.set('host', host)
  return url.toString()
}

async function convertToLinear16(audioBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1',
    ])
    const chunks = []
    const stderrChunks = []

    ffmpeg.stdout.on('data', (chunk) => {
      chunks.push(chunk)
    })
    ffmpeg.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk)
    })
    ffmpeg.on('error', (error) => {
      reject(error)
    })
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        const message = Buffer.concat(stderrChunks).toString('utf8').trim()
        reject(createHttpError(`ffmpeg 转码失败：${message || `exit code ${code}`}`, 502))
        return
      }
      resolve(Buffer.concat(chunks))
    })

    ffmpeg.stdin.end(audioBuffer)
  })
}

function toUtf8Base64(content) {
  return Buffer.from(content, 'utf8').toString('base64')
}

async function transcribeAudioWithXfyun(file) {
  const host = 'iat-api.xfyun.cn'
  const pathName = '/v2/iat'
  const wsUrl = createXfyunAuthUrl(
    `wss://${host}${pathName}`,
    host,
    pathName,
    aiConfig.xfyunApiKey,
    aiConfig.xfyunApiSecret,
  )
  const pcm = await convertToLinear16(file.buffer)
  const chunkSize = 1280

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let transcript = ''
    let finished = false

    ws.addEventListener('open', () => {
      const first = {
        common: { app_id: aiConfig.xfyunAppId },
        business: {
          domain: 'iat',
          language: aiConfig.xfyunIatLanguage,
          accent: aiConfig.xfyunIatAccent,
          vad_eos: aiConfig.xfyunIatVadeos,
        },
      }
      let offset = 0
      let status = 0

      while (offset < pcm.length) {
        const next = Math.min(offset + chunkSize, pcm.length)
        const audioChunk = pcm.subarray(offset, next)
        const data = {
          status,
          format: 'audio/L16;rate=16000',
          encoding: 'raw',
          audio: audioChunk.toString('base64'),
        }
        ws.send(JSON.stringify(status === 0 ? { ...first, data } : { data }))
        status = 1
        offset = next
      }

      ws.send(
        JSON.stringify({
          data: {
            status: 2,
            format: 'audio/L16;rate=16000',
            encoding: 'raw',
            audio: '',
          },
        }),
      )
    })

    ws.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data))
        if (payload.code !== 0) {
          throw createHttpError(
            `讯飞 ASR 错误（${payload.code}）：${payload.message || 'unknown'}`,
            502,
          )
        }

        const segments = payload?.data?.result?.ws
        if (Array.isArray(segments)) {
          for (const segment of segments) {
            if (!Array.isArray(segment?.cw)) {
              continue
            }
            for (const candidate of segment.cw) {
              if (typeof candidate?.w === 'string') {
                transcript += candidate.w
              }
            }
          }
        }

        if (payload?.data?.status === 2 && !finished) {
          finished = true
          ws.close()
          resolve(sanitizeReplyText(transcript))
        }
      } catch (error) {
        if (!finished) {
          finished = true
          ws.close()
          reject(error)
        }
      }
    })

    ws.addEventListener('error', () => {
      if (!finished) {
        finished = true
        reject(createHttpError('讯飞 ASR WebSocket 连接失败。', 502))
      }
    })

    ws.addEventListener('close', () => {
      if (!finished) {
        finished = true
        resolve(sanitizeReplyText(transcript))
      }
    })
  })
}

async function synthesizeReplyAudioWithXfyun(replyText, archiveId) {
  const host = 'tts-api.xfyun.cn'
  const pathName = '/v2/tts'
  const wsUrl = createXfyunAuthUrl(
    `wss://${host}${pathName}`,
    host,
    pathName,
    aiConfig.xfyunApiKey,
    aiConfig.xfyunApiSecret,
  )
  const voiceText = toUtf8Base64(replyText)

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const chunks = []
    let finished = false

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          common: { app_id: aiConfig.xfyunAppId },
          business: {
            aue: aiConfig.xfyunTtsAue,
            auf: 'audio/L16;rate=16000',
            vcn: aiConfig.xfyunTtsVoice,
            speed: aiConfig.xfyunTtsSpeed,
            volume: aiConfig.xfyunTtsVolume,
            pitch: aiConfig.xfyunTtsPitch,
            tte: 'UTF8',
          },
          data: {
            status: 2,
            text: voiceText,
          },
        }),
      )
    })

    ws.addEventListener('message', async (event) => {
      try {
        const payload = JSON.parse(String(event.data))
        if (payload.code !== 0) {
          throw createHttpError(
            `讯飞 TTS 错误（${payload.code}）：${payload.message || 'unknown'}`,
            502,
          )
        }

        const audioBase64 = payload?.data?.audio
        if (typeof audioBase64 === 'string' && audioBase64.length > 0) {
          chunks.push(Buffer.from(audioBase64, 'base64'))
        }

        if (payload?.data?.status === 2 && !finished) {
          finished = true
          ws.close()
          const ext = aiConfig.xfyunTtsAue === 'lame' ? 'mp3' : 'pcm'
          const filename = `${archiveId}.${ext}`
          const fullPath = path.join(replyRecordingsDir, filename)
          await fs.writeFile(fullPath, Buffer.concat(chunks))
          resolve(`/recordings/replies/${filename}`)
        }
      } catch (error) {
        if (!finished) {
          finished = true
          ws.close()
          reject(error)
        }
      }
    })

    ws.addEventListener('error', () => {
      if (!finished) {
        finished = true
        reject(createHttpError('讯飞 TTS WebSocket 连接失败。', 502))
      }
    })

    ws.addEventListener('close', () => {
      if (!finished) {
        finished = true
        reject(createHttpError('讯飞 TTS 连接提前关闭。', 502))
      }
    })
  })
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

async function requestAsrJson(endpoint, init) {
  if (!isAsrConfigured()) {
    throw createHttpError('ASR 服务未配置。', 503)
  }

  const response = await fetch(`${aiConfig.asrBaseUrl}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${aiConfig.asrApiKey}`,
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createHttpError(
      `ASR 服务请求失败（${response.status}）：${errorText || 'empty response'}`,
      response.status,
    )
  }

  return response.json()
}

async function requestAiBinary(endpoint, init) {
  if (!isTtsConfigured()) {
    throw createHttpError('TTS 服务未配置。', 503)
  }

  const response = await fetch(`${aiConfig.ttsBaseUrl}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${aiConfig.ttsApiKey}`,
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

  if (aiConfig.asrProvider === 'xfyun') {
    return transcribeAudioWithXfyun(file)
  }

  const formData = new FormData()
  const extension = resolveRecordingExtension(file.mimetype || 'audio/webm', '.webm')
  const audioBlob = new Blob([file.buffer], { type: file.mimetype || 'audio/webm' })
  formData.append('file', audioBlob, `nightwhisper${extension}`)
  formData.append('model', aiConfig.asrModel)
  formData.append('language', aiConfig.asrLanguage)

  const payload = await requestAsrJson('/audio/transcriptions', {
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
      thinking:
        aiConfig.llmThinkingType === 'enabled'
          ? { type: 'enabled' }
          : { type: 'disabled' },
    }),
  })

  const replyText = sanitizeReplyText(extractAssistantText(payload))
  if (!replyText) {
    throw createHttpError('AI 没有返回可播报的回信内容。', 502)
  }

  return replyText
}

async function synthesizeReplyAudio(replyText, archiveId) {
  if (aiConfig.ttsProvider === 'xfyun') {
    return synthesizeReplyAudioWithXfyun(replyText, archiveId)
  }

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
      instructions: '请使用慢语速、低音量、柔缓沙哑的电台声线播报，像在安静的时光里轻声陪伴。',
      response_format: responseFormat,
    }),
  })

  const safeExtension = responseFormat === 'wav' ? 'wav' : responseFormat === 'aac' ? 'aac' : 'mp3'
  const filename = `${archiveId}.${safeExtension}`
  const fullPath = path.join(replyRecordingsDir, filename)
  await fs.writeFile(fullPath, audioBuffer)
  return `/recordings/replies/${filename}`
}

const negationPrefixes = ['不', '没', '不太', '没有', '并不', '别']

function hasNegation(text, keyword) {
  const index = text.indexOf(keyword)
  if (index <= 0) return false
  for (const prefix of negationPrefixes) {
    const before = text.slice(Math.max(0, index - prefix.length), index)
    if (before === prefix) return true
  }
  return false
}

function detectMood(transcript, durationMs) {
  const normalized = String(transcript || '').trim()
  if (!normalized && durationMs < 2000) {
    return 'empty'
  }

  for (const [mood, keywords] of Object.entries(moodKeywords)) {
    if (keywords.some((keyword) => normalized.includes(keyword) && !hasNegation(normalized, keyword))) {
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
    asrConfigured: isAsrConfigured(),
    ttsConfigured: isTtsConfigured(),
    aiModels: {
      asr: aiConfig.asrProvider === 'xfyun' ? 'xfyun-iat' : aiConfig.asrModel,
      llm: aiConfig.llmModel,
      tts: aiConfig.ttsProvider === 'xfyun' ? 'xfyun-tts' : aiConfig.ttsModel,
      voice: aiConfig.ttsProvider === 'xfyun' ? aiConfig.xfyunTtsVoice : aiConfig.ttsVoice,
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

    const transcriptFromAsr = req.file?.size && isAsrConfigured() ? await transcribeAudio(req.file) : ''
    const transcript = transcriptFromAsr || clientTranscript
    const hasVoice = Boolean((req.file && req.file.size > 1500) || transcript)
    const mood = hasVoice ? detectMood(transcript, durationMs) : 'empty'
    let replyText = ''
    let replySeconds = 0

    if (isAiConfigured()) {
      replyText = hasVoice ? await generateReplyText(transcript, durationMs) : moodResponses.empty[0]
      if (isTtsConfigured()) {
        replyAudioPath = await synthesizeReplyAudio(replyText, archiveId)
      }
      replySeconds = estimateReplySeconds(replyText)
    } else {
      const fallbackReply = createFallbackReply(mood, durationMs)
      replyText = fallbackReply.replyText
      replySeconds = fallbackReply.replySeconds
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
        : '回信没有顺利写完，请稍后再试。',
  })
})

ensureStorage().then(() => {
  app.listen(port, host, () => {
    console.log(`[nightwhisper-backend] listening on http://${host}:${port}`)
  })
})
