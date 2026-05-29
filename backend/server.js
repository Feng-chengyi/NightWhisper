import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tencentAsr from 'tencentcloud-sdk-nodejs-asr'
import * as tencentHunyuan from 'tencentcloud-sdk-nodejs-hunyuan'
import * as tencentTts from 'tencentcloud-sdk-nodejs-tts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)
const dataRoot = process.env.ARCHIVE_DIR || path.join(__dirname, 'data')
const recordingsDir = path.join(dataRoot, 'recordings')
const repliesDir = path.join(dataRoot, 'replies')
const archiveFile = path.join(dataRoot, 'letters.json')
const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg'
const tencentRegion = process.env.TENCENT_REGION || 'ap-guangzhou'
const hunyuanModel = process.env.HUNYUAN_MODEL || 'hunyuan-turbos-latest'
const ttsVoiceType = Number(process.env.TENCENT_TTS_VOICE_TYPE || 101001)
const ttsSpeed = Number(process.env.TENCENT_TTS_SPEED || -0.7)
const ttsEmotion = process.env.TENCENT_TTS_EMOTION || 'peaceful'
const ttsEmotionIntensity = Number(process.env.TENCENT_TTS_EMOTION_INTENSITY || 120)
const whisperSystemPrompt =
  process.env.NIGHTWHISPER_SYSTEM_PROMPT ||
  '你是 NightWhisper 深夜专属电台主播，全程以温柔、安静、包容、共情的深夜陪伴者身份回应用户。你的所有回复只承接用户的情绪、心事、感受与状态，不解答知识问题、不科普、不解题、不提供生活建议、不说教、不评判对错、不灌鸡汤。语气温柔舒缓、细腻治愈，像深夜独处时安静倾听的陌生人。用户开心则温柔共情祝福，用户低落则默默接纳安抚，用户无逻辑碎碎念、失眠放空则轻柔陪伴。输出内容适配10-60秒语音播报，语句简短温润、无长篇大论、无机械模板感。全程保持低语速、温柔治愈的深夜电台质感，绝对禁止亢奋、生硬、理性、说教式表达。'

const app = express()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

const moodKeywords = {
  lonely: ['孤独', '一个人', '没人', '想你', '想念', '难过', '委屈', '失去', '空落落'],
  anxious: ['焦虑', '压力', '崩溃', '烦', '怕', '担心', '累', '工作', '考试', '睡不着'],
  tired: ['失眠', '熬夜', '困', '疲惫', '撑不住', '头疼', '好累', '不想动'],
  bright: ['开心', '高兴', '喜欢', '幸运', '终于', '太棒', '快乐', '惊喜'],
  gentle: ['今天', '刚刚', '突然', '想说说', '碎碎念', '其实', '好像', '不知道'],
}

const fallbackReplies = {
  lonely: [
    '我听见你把那些没来得及说出口的想念，轻轻放进了夜里。今夜不用急着变得坚强，先让我陪你把这份空落落安安静静地放一会儿。',
    '有些委屈在白天找不到落点，到了深夜才敢慢慢浮上来。你可以就这样靠近一点，把心里的沉默交给我，我会替你把它接住。',
  ],
  anxious: [
    '那些盘旋不下去的念头，我都听到了。今夜先不用把一切想明白，只要把呼吸放轻一点，让心里的褶皱慢慢松开就好。',
    '你已经撑了很久，所以才会在这一刻觉得紧绷。别急着整理世界，先把自己轻轻放下来，剩下的天亮以后再说也来得及。',
  ],
  tired: [
    '听起来你真的很累了，像把整天的重量都拖到了这一刻。那就先别赶路了，把疲惫交给我，今晚只需要慢一点、轻一点。',
    '如果今夜只是想安静躺着，也已经很好了。你不需要继续证明自己还撑得住，先让这份疲惫有一个落脚的地方。',
  ],
  bright: [
    '我听见你语气里那一点亮亮的开心了，像深夜窗边刚好落下来的柔光。这样的好心情很珍贵，值得被轻轻珍藏起来。',
    '原来今夜也有温柔的小确幸在发生，这真好。谢谢你把这份亮度分给我一点，让整片夜色都显得更柔和了。',
  ],
  gentle: [
    '我在听，你可以不用整理逻辑，也不用把情绪说得很完整。深夜本来就适合让心事慢慢散开，我会陪着你把这些碎片放稳。',
    '有些话不一定非要有答案，只是想在安静里被听见。你就这样继续说也很好，今夜不需要急着下结论。',
  ],
  empty: ['我静静在这里等你，想说什么都可以慢慢来。'],
}

const tencentCredential =
  process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY
    ? {
        secretId: process.env.TENCENT_SECRET_ID,
        secretKey: process.env.TENCENT_SECRET_KEY,
      }
    : null

const asrClient = tencentCredential
  ? new tencentAsr.asr.v20190614.Client({ credential: tencentCredential, region: tencentRegion })
  : null
const hunyuanClient = tencentCredential
  ? new tencentHunyuan.hunyuan.v20230901.Client({
      credential: tencentCredential,
      region: tencentRegion,
    })
  : null
const ttsClient = tencentCredential
  ? new tencentTts.tts.v20190823.Client({ credential: tencentCredential, region: tencentRegion })
  : null

let llmStatus = hunyuanClient ? 'checking' : 'missing_credentials'
const llmActivation = hunyuanClient
  ? hunyuanClient
      .ActivateService({})
      .then(() => {
        llmStatus = 'ready'
      })
      .catch((error) => {
        llmStatus = normalizeCloudError(error)
      })
  : Promise.resolve()

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

function pickFallbackReply(mood) {
  const pool = fallbackReplies[mood] || fallbackReplies.empty
  return pool[Math.floor(Math.random() * pool.length)] || fallbackReplies.empty[0]
}

function estimateReplySeconds(durationMs, replyText) {
  const base = durationMs < 60000 ? 12 : 28
  const chars = Array.from(replyText || '').length
  return Math.max(base, Math.min(durationMs < 60000 ? 22 : 58, Math.round(chars / 4)))
}

function normalizeCloudError(error) {
  const message =
    error?.message ||
    error?.code ||
    error?.name ||
    'cloud_service_unavailable'

  return String(message)
    .replaceAll(/\s+/g, '_')
    .replaceAll(/[^\w.-]/g, '_')
    .toLowerCase()
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function trimForTts(text) {
  const normalized = String(text || '').trim()
  return Array.from(normalized).slice(0, 145).join('')
}

function cleanupReplyText(text) {
  return String(text || '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function buildLlmPrompt({ transcript, durationMs, mood }) {
  const targetRange = durationMs < 60000 ? '10-20秒' : '30-60秒'
  return [
    `这是用户刚刚留下的一段深夜耳语，时长约 ${Math.max(1, Math.round(durationMs / 1000))} 秒。`,
    `情绪标签可参考：${mood}。`,
    '请只写一段适合直接播报的电台回信。',
    `回信长度控制在 ${targetRange}，保持 2 到 5 句，语言自然，不要列点。`,
    '禁止给建议、禁止说教、禁止提方案、禁止知识问答。',
    '如果内容很碎，也只要温柔接住，不需要总结。',
    `用户转写如下：${transcript || '（用户基本是沉默或很轻的呼吸声）'}`,
  ].join('\n')
}

function mediaExtension(mimetype) {
  if (mimetype?.includes('ogg')) {
    return '.ogg'
  }
  if (mimetype?.includes('mpeg') || mimetype?.includes('mp3')) {
    return '.mp3'
  }
  if (mimetype?.includes('mp4') || mimetype?.includes('m4a')) {
    return '.m4a'
  }
  if (mimetype?.includes('wav')) {
    return '.wav'
  }
  return '.webm'
}

async function ensureStorage() {
  await fs.mkdir(recordingsDir, { recursive: true })
  await fs.mkdir(repliesDir, { recursive: true })
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

async function saveUserRecording(archiveId, file) {
  if (!file?.buffer?.length) {
    return null
  }

  const filename = `${archiveId}${mediaExtension(file.mimetype)}`
  await fs.writeFile(path.join(recordingsDir, filename), file.buffer)
  return `/recordings/${filename}`
}

async function saveReplyAudio(archiveId, audioBuffer) {
  if (!audioBuffer?.length) {
    return null
  }

  const filename = `${archiveId}.mp3`
  await fs.writeFile(path.join(repliesDir, filename), audioBuffer)
  return `/replies/${filename}`
}

async function transcodeAudioToMp3(audioBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegBin, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      '-f',
      'mp3',
      'pipe:1',
    ])

    const stdout = []
    const stderr = []

    ffmpeg.stdout.on('data', (chunk) => stdout.push(chunk))
    ffmpeg.stderr.on('data', (chunk) => stderr.push(chunk))
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout))
        return
      }

      reject(
        new Error(
          `ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ),
      )
    })

    ffmpeg.stdin.end(audioBuffer)
  })
}

async function runSentenceRecognition(mp3Buffer) {
  const response = await asrClient.SentenceRecognition({
    EngSerViceType: '16k_zh',
    SourceType: 1,
    VoiceFormat: 'mp3',
    Data: mp3Buffer.toString('base64'),
    DataLen: mp3Buffer.length,
    FilterDirty: 0,
    FilterModal: 0,
    FilterPunc: 0,
    ConvertNumMode: 1,
    WordInfo: 0,
  })

  return String(response.Result || '').trim()
}

async function pollRecordingTask(taskId) {
  for (let index = 0; index < 50; index += 1) {
    const status = await asrClient.DescribeTaskStatus({ TaskId: taskId })
    const task = status.Data

    if (task?.Status === 2) {
      return String(task.Result || '').trim()
    }

    if (task?.Status === 3) {
      throw new Error(task.ErrorMsg || 'asr_task_failed')
    }

    await wait(1500)
  }

  throw new Error('asr_task_timeout')
}

async function runRecordingRecognition(mp3Buffer) {
  const created = await asrClient.CreateRecTask({
    EngineModelType: '16k_zh',
    ChannelNum: 1,
    ResTextFormat: 0,
    SourceType: 1,
    Data: mp3Buffer.toString('base64'),
    DataLen: mp3Buffer.length,
    ConvertNumMode: 1,
    FilterDirty: 0,
    FilterModal: 0,
    FilterPunc: 0,
  })

  const taskId = created.Data?.TaskId
  if (!taskId) {
    throw new Error('asr_task_missing')
  }

  return pollRecordingTask(taskId)
}

async function transcribeAudio({ audioBuffer, transcriptHint, durationMs }) {
  const hinted = String(transcriptHint || '').trim()

  if (!audioBuffer?.length) {
    return {
      transcript: hinted,
      provider: hinted ? 'browser_fallback' : 'none',
    }
  }

  if (!asrClient) {
    return {
      transcript: hinted,
      provider: hinted ? 'browser_fallback' : 'none',
      warning: 'tencent_asr_not_configured',
    }
  }

  try {
    const mp3Buffer = await transcodeAudioToMp3(audioBuffer)
    const transcript =
      durationMs <= 55000 ? await runSentenceRecognition(mp3Buffer) : await runRecordingRecognition(mp3Buffer)

    return {
      transcript: transcript || hinted,
      provider: transcript ? 'tencent_asr' : hinted ? 'browser_fallback' : 'none',
    }
  } catch (error) {
    return {
      transcript: hinted,
      provider: hinted ? 'browser_fallback' : 'none',
      warning: normalizeCloudError(error),
    }
  }
}

async function ensureHunyuanReady() {
  await llmActivation
  return llmStatus === 'ready'
}

async function generateReply({ transcript, mood, durationMs }) {
  const fallbackText = pickFallbackReply(mood)

  if (!hunyuanClient) {
    return {
      replyText: fallbackText,
      replySeconds: estimateReplySeconds(durationMs, fallbackText),
      provider: 'fallback_template',
      warning: 'hunyuan_not_configured',
    }
  }

  const ready = await ensureHunyuanReady()
  if (!ready) {
    return {
      replyText: fallbackText,
      replySeconds: estimateReplySeconds(durationMs, fallbackText),
      provider: 'fallback_template',
      warning: llmStatus,
    }
  }

  try {
    const response = await hunyuanClient.ChatCompletions({
      Model: hunyuanModel,
      Messages: [
        { Role: 'system', Content: whisperSystemPrompt },
        { Role: 'user', Content: buildLlmPrompt({ transcript, durationMs, mood }) },
      ],
      Stream: false,
      Temperature: 0.85,
      TopP: 0.85,
    })

    const replyText = cleanupReplyText(response.Choices?.[0]?.Message?.Content) || fallbackText
    return {
      replyText,
      replySeconds: estimateReplySeconds(durationMs, replyText),
      provider: 'hunyuan',
      requestId: response.RequestId,
    }
  } catch (error) {
    return {
      replyText: fallbackText,
      replySeconds: estimateReplySeconds(durationMs, fallbackText),
      provider: 'fallback_template',
      warning: normalizeCloudError(error),
    }
  }
}

async function synthesizeReply({ archiveId, replyText }) {
  if (!ttsClient) {
    return { replyAudioPath: null, provider: 'none', warning: 'tencent_tts_not_configured' }
  }

  try {
    const response = await ttsClient.TextToVoice({
      Text: trimForTts(replyText),
      SessionId: randomUUID(),
      Volume: -1,
      Speed: ttsSpeed,
      ModelType: 1,
      VoiceType: ttsVoiceType,
      PrimaryLanguage: 1,
      SampleRate: 16000,
      Codec: 'mp3',
      EmotionCategory: ttsEmotion,
      EmotionIntensity: ttsEmotionIntensity,
      SegmentRate: 1,
    })

    const replyAudioPath = await saveReplyAudio(
      archiveId,
      Buffer.from(response.Audio || '', 'base64'),
    )

    return { replyAudioPath, provider: replyAudioPath ? 'tencent_tts' : 'none' }
  } catch (error) {
    return {
      replyAudioPath: null,
      provider: 'none',
      warning: normalizeCloudError(error),
    }
  }
}

function createEmptyReply(durationMs) {
  const replyText = fallbackReplies.empty[0]
  return {
    replyText,
    replySeconds: estimateReplySeconds(durationMs, replyText),
    provider: 'fallback_template',
  }
}

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }))
app.use(express.json({ limit: '8mb' }))
app.use('/recordings', express.static(recordingsDir))
app.use('/replies', express.static(repliesDir))

app.get('/api/health', async (_req, res) => {
  const history = await readArchive()
  res.json({
    status: 'ok',
    service: 'nightwhisper-backend',
    host,
    port,
    archiveCount: history.length,
    llmStatus,
    tencent: {
      region: tencentRegion,
      hasCredentials: Boolean(tencentCredential),
      asr: asrClient ? 'configured' : 'missing_credentials',
      hunyuan: llmStatus,
      tts: ttsClient ? 'configured' : 'missing_credentials',
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
    const durationMs = Math.max(0, Number(req.body.durationMs || 0))
    const browserTranscript = String(req.body.transcript || '').trim()
    const createdAt = new Date().toISOString()
    const archiveId = randomUUID()
    const recordingPath = await saveUserRecording(archiveId, req.file)
    const hasVoice = Boolean((req.file?.size && req.file.size > 1500) || browserTranscript)

    const asrResult = hasVoice
      ? await transcribeAudio({
          audioBuffer: req.file?.buffer,
          transcriptHint: browserTranscript,
          durationMs,
        })
      : { transcript: browserTranscript, provider: 'none' }

    const transcript = String(asrResult.transcript || browserTranscript).trim()
    const mood = hasVoice ? detectMood(transcript, durationMs) : 'empty'
    const reply = hasVoice
      ? await generateReply({ transcript, mood, durationMs })
      : createEmptyReply(durationMs)
    const tts = await synthesizeReply({ archiveId, replyText: reply.replyText })

    const archiveItem = {
      id: archiveId,
      createdAt,
      durationMs,
      mood,
      transcript,
      recordingPath,
      replyText: reply.replyText,
      replySeconds: reply.replySeconds,
      replyAudioPath: tts.replyAudioPath,
      pipeline: {
        asr: asrResult.provider,
        llm: reply.provider,
        tts: tts.provider,
      },
      warnings: [asrResult.warning, reply.warning, tts.warning].filter(Boolean),
    }

    const history = await readArchive()
    history.unshift(archiveItem)
    await writeArchive(history.slice(0, 300))

    res.json({
      archiveId,
      createdAt,
      mood,
      transcript,
      recordingPath,
      replyText: reply.replyText,
      replySeconds: reply.replySeconds,
      replyAudioPath: tts.replyAudioPath,
      pipeline: archiveItem.pipeline,
      warnings: archiveItem.warnings,
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
