import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Page = 'home' | 'history' | 'about'
type ComposerState = 'ready' | 'listening' | 'thinking' | 'replying'
type RecordingMode = 'idle' | 'hold' | 'continuous'
type PlaybackPhase = 'idle' | 'user' | 'ai'
type Mood = 'lonely' | 'anxious' | 'tired' | 'bright' | 'gentle' | 'empty'

interface WhisperRecord {
  id: string
  createdAt: string
  durationMs: number
  mood: Mood
  replyText: string
  replySeconds: number
  userAudioDataUrl?: string
  transcript?: string
}

interface SpeechRecognitionResultLike {
  0: {
    transcript: string
  }
  isFinal: boolean
  length: number
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
}

const STORAGE_KEY = 'nightwhisper-letters'

const moodKeywords: Record<Exclude<Mood, 'empty'>, string[]> = {
  lonely: ['孤独', '一个人', '没人', '想你', '想念', '难过', '委屈', '失去', '空落落'],
  anxious: ['焦虑', '压力', '崩溃', '烦', '怕', '担心', '累', '工作', '考试', '睡不着'],
  tired: ['失眠', '熬夜', '困', '疲惫', '撑不住', '头疼', '好累', '不想动'],
  bright: ['开心', '高兴', '喜欢', '幸运', '终于', '太棒', '快乐', '惊喜'],
  gentle: ['今天', '刚刚', '突然', '想说说', '碎碎念', '其实', '好像', '不知道'],
}

const moodResponses: Record<Mood, string[]> = {
  lonely: [
    '我听见你把那些没来得及说出口的想念，轻轻放进了夜里。今夜不用急着变得坚强，先让我陪你把这份空落落安安静静地放一会儿。',
    '有些委屈在白天找不到落点，到了深夜才敢慢慢浮上来。你可以就这样靠近一点，把心里的沉默交给我，我会替你把它接住。',
    '一个人的夜晚总会把情绪放大一些，可你不是独自漂着的。至少此刻，这段耳语有了回声，也有人在认真听你。 ',
  ],
  anxious: [
    '那些盘旋不下去的念头，我都听到了。今夜先不用把一切想明白，只要把呼吸放轻一点，让心里的褶皱慢慢松开就好。',
    '你已经撑了很久，所以才会在这一刻觉得紧绷。别急着整理世界，先把自己轻轻放下来，剩下的天亮以后再说也来得及。',
    '我知道你不是故意要这样焦灼，只是心里装了太多事。先让夜色替你挡一挡风，你可以在这里短暂地不用逞强。',
  ],
  tired: [
    '听起来你真的很累了，像把整天的重量都拖到了这一刻。那就先别赶路了，把疲惫交给我，今晚只需要慢一点、轻一点。',
    '当身体和心都在发沉的时候，连一句完整的话都显得费力。没关系，你说到哪里都算数，我会陪你把这段夜晚走得柔一点。',
    '如果今夜只是想安静躺着，也已经很好了。你不需要继续证明自己还撑得住，先让这份疲惫有一个落脚的地方。',
  ],
  bright: [
    '我听见你语气里那一点亮亮的开心了，像深夜窗边刚好落下来的柔光。这样的好心情很珍贵，值得被轻轻珍藏起来。',
    '原来今夜也有温柔的小确幸在发生，这真好。谢谢你把这份亮度分给我一点，让整片夜色都显得更柔和了。',
    '你说起那些开心的时候，连空气都跟着松快了一些。愿这份轻轻发亮的心情，能陪你把今晚也过得温暖一点。',
  ],
  gentle: [
    '我在听，你可以不用整理逻辑，也不用把情绪说得很完整。深夜本来就适合让心事慢慢散开，我会陪着你把这些碎片放稳。',
    '有些话不一定非要有答案，只是想在安静里被听见。你就这样继续说也很好，今夜不需要急着下结论。',
    '你能把这些细小又真实的感受交给我，本身就很珍贵。夜很深了，心也可以稍微松一松，在这里待一会儿。 ',
  ],
  empty: ['我静静在这里等你，想说什么都可以慢慢来。'],
}

const initialStatus = '深夜有言，有人倾听'

function loadStoredRecords() {
  if (typeof window === 'undefined') {
    return [] as WhisperRecord[]
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return [] as WhisperRecord[]
    }

    const parsed = JSON.parse(raw) as WhisperRecord[]
    if (!Array.isArray(parsed)) {
      return [] as WhisperRecord[]
    }

    return parsed
  } catch {
    return [] as WhisperRecord[]
  }
}

function formatClock(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

function formatFullDate(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return minutes > 0
    ? `${minutes}分${seconds.toString().padStart(2, '0')}秒`
    : `${seconds}秒`
}

function describeLetter(record: WhisperRecord) {
  const date = new Date(record.createdAt)
  const hour = date.getHours().toString().padStart(2, '0')
  return `深夜${hour}点的耳语`
}

function isSameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function isYesterday(date: Date) {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return isSameDay(date, yesterday)
}

function detectMood(transcript: string, durationMs: number): Mood {
  const normalized = transcript.trim()

  if (!normalized && durationMs < 2000) {
    return 'empty'
  }

  for (const [mood, keywords] of Object.entries(moodKeywords) as Array<
    [Exclude<Mood, 'empty'>, string[]]
  >) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return mood
    }
  }

  if (durationMs > 90_000) {
    return 'tired'
  }

  if (normalized.length === 0) {
    return 'empty'
  }

  return 'gentle'
}

function createReply(mood: Mood, durationMs: number) {
  const pool = moodResponses[mood]
  const replyText = pool[Math.floor(Math.random() * pool.length)] ?? moodResponses.empty[0]
  const replySeconds =
    durationMs < 60_000
      ? 10 + Math.floor(Math.random() * 11)
      : 30 + Math.floor(Math.random() * 31)

  return { replyText, replySeconds }
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function App() {
  const [page, setPage] = useState<Page>('home')
  const [records, setRecords] = useState<WhisperRecord[]>(() => loadStoredRecords())
  const [composerState, setComposerState] = useState<ComposerState>('ready')
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('idle')
  const [recordingMs, setRecordingMs] = useState(0)
  const [statusLine, setStatusLine] = useState(initialStatus)
  const [activeRecord, setActiveRecord] = useState<WhisperRecord | null>(null)
  const [playback, setPlayback] = useState<{ id: string | null; phase: PlaybackPhase }>({
    id: null,
    phase: 'idle',
  })
  const [permissionReady, setPermissionReady] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const transcriptRef = useRef('')
  const startAtRef = useRef(0)
  const durationTimerRef = useRef<number | null>(null)
  const pointerDownAtRef = useRef(0)
  const holdTimerRef = useRef<number | null>(null)
  const lastDurationRef = useRef(0)

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  }, [records])

  useEffect(() => {
    return () => {
      if (durationTimerRef.current) {
        window.clearInterval(durationTimerRef.current)
      }
      if (holdTimerRef.current) {
        window.clearTimeout(holdTimerRef.current)
      }

      audioRef.current?.pause()
      window.speechSynthesis?.cancel()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const sortedRecords = useMemo(
    () =>
      [...records].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    [records],
  )

  const todayRecords = sortedRecords.filter((record) => isSameDay(new Date(record.createdAt), new Date()))
  const yesterdayRecords = sortedRecords.filter((record) => isYesterday(new Date(record.createdAt)))
  const earlierRecords = sortedRecords.filter((record) => {
    const date = new Date(record.createdAt)
    return !isSameDay(date, new Date()) && !isYesterday(date)
  })

  async function ensureStream() {
    if (streamRef.current) {
      return streamRef.current
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器暂不支持麦克风访问。')
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    streamRef.current = stream
    setPermissionReady(true)
    return stream
  }

  function stopPlayback() {
    audioRef.current?.pause()
    audioRef.current = null
    window.speechSynthesis?.cancel()
    setPlayback({ id: null, phase: 'idle' })
  }

  function speakReply(record: WhisperRecord) {
    if (!window.speechSynthesis) {
      setPlayback({ id: null, phase: 'idle' })
      setComposerState('ready')
      setStatusLine('今夜已存好，随时都能回听')
      return
    }

    const utterance = new SpeechSynthesisUtterance(record.replyText)
    utterance.lang = 'zh-CN'
    utterance.rate = 0.84
    utterance.pitch = 0.82
    utterance.volume = 0.82
    utterance.onend = () => {
      setPlayback({ id: null, phase: 'idle' })
      setComposerState('ready')
      setStatusLine('今夜已存好，随时都能回听')
    }

    setPlayback({ id: record.id, phase: 'ai' })
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }

  function playWholeLetter(record: WhisperRecord) {
    stopPlayback()
    setActiveRecord(record)
    setStatusLine('正在回听这封来信')

    if (record.userAudioDataUrl) {
      const audio = new Audio(record.userAudioDataUrl)
      audioRef.current = audio
      audio.onended = () => speakReply(record)
      audio.onerror = () => speakReply(record)
      setPlayback({ id: record.id, phase: 'user' })
      void audio.play().catch(() => speakReply(record))
      return
    }

    speakReply(record)
  }

  function startRecognition() {
    const RecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!RecognitionCtor) {
      return
    }

    const recognition = new RecognitionCtor()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      let transcript = ''

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? ''
      }

      transcriptRef.current = `${transcriptRef.current} ${transcript}`.trim()
    }
    recognition.onerror = () => {
      recognitionRef.current = null
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
    } catch {
      recognitionRef.current = null
    }
  }

  function stopRecognition() {
    try {
      recognitionRef.current?.stop()
    } catch {
      recognitionRef.current?.abort()
    } finally {
      recognitionRef.current = null
    }
  }

  async function beginRecording(mode: Exclude<RecordingMode, 'idle'>) {
    if (recorderRef.current?.state === 'recording' || composerState === 'thinking') {
      return
    }

    try {
      const stream = await ensureStream()
      stopPlayback()
      transcriptRef.current = ''
      chunksRef.current = []

      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }
      recorder.onstop = () => {
        void finalizeRecording()
      }

      recorder.start()
      startRecognition()
      window.navigator.vibrate?.(18)
      // eslint-disable-next-line react-hooks/purity
      startAtRef.current = Date.now()
      setRecordingMs(0)
      setRecordingMode(mode)
      setComposerState('listening')
      setStatusLine(mode === 'hold' ? '轻轻说，我在听' : '持续倾诉中，再轻触一次结束')

      if (durationTimerRef.current) {
        window.clearInterval(durationTimerRef.current)
      }

      durationTimerRef.current = window.setInterval(() => {
        setRecordingMs(Date.now() - startAtRef.current)
      }, 120)
    } catch (error) {
      setRecordingMode('idle')
      setComposerState('ready')
      setStatusLine(
        error instanceof Error ? error.message : '暂时没能连接麦克风，请允许麦克风权限后再试。',
      )
    }
  }

  function endRecording() {
    if (!recorderRef.current || recorderRef.current.state !== 'recording') {
      return
    }

    // eslint-disable-next-line react-hooks/purity
    lastDurationRef.current = Math.max(1_000, Date.now() - startAtRef.current)
    if (durationTimerRef.current) {
      window.clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }

    setRecordingMs(lastDurationRef.current)
    setRecordingMode('idle')
    setComposerState('thinking')
    setStatusLine('耳语收好了，正在写回信')
    stopRecognition()
    recorderRef.current.stop()
  }

  async function finalizeRecording() {
    const chunks = [...chunksRef.current]
    recorderRef.current = null
    chunksRef.current = []

    const blob = new Blob(chunks, { type: 'audio/webm' })
    const transcript = transcriptRef.current.trim()
    const durationMs = lastDurationRef.current || recordingMs
    const hasVoice = blob.size > 1500 || transcript.length > 0
    const mood = hasVoice ? detectMood(transcript, durationMs) : 'empty'
    const { replyText, replySeconds } = createReply(mood, durationMs)
    const createdAt = new Date().toISOString()
    const record: WhisperRecord = {
      // eslint-disable-next-line react-hooks/purity
      id: `${Date.now()}`,
      createdAt,
      durationMs,
      mood,
      replyText,
      replySeconds,
      transcript,
      userAudioDataUrl: hasVoice ? await blobToDataUrl(blob) : undefined,
    }

    window.setTimeout(() => {
      setRecords((current) => [record, ...current].slice(0, 24))
      setActiveRecord(record)
      setComposerState('replying')
      setStatusLine('你的专属深夜来信，已经落下来了')
      speakReply(record)
    }, 720)
  }

  function handlePressStart() {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current)
    }

    // eslint-disable-next-line react-hooks/purity
    pointerDownAtRef.current = Date.now()

    if (recordingMode === 'continuous') {
      return
    }

    holdTimerRef.current = window.setTimeout(() => {
      void beginRecording('hold')
    }, 220)
  }

  function handlePressEnd() {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }

    // eslint-disable-next-line react-hooks/purity
    const pressDuration = Date.now() - pointerDownAtRef.current

    if (recordingMode === 'hold') {
      endRecording()
      return
    }

    if (recordingMode === 'continuous') {
      if (pressDuration < 220) {
        endRecording()
      }
      return
    }

    if (pressDuration < 220) {
      void beginRecording('continuous')
    }
  }

  function deleteRecord(recordId: string) {
    if (activeRecord?.id === recordId) {
      setActiveRecord(null)
    }
    if (playback.id === recordId) {
      stopPlayback()
    }
    setRecords((current) => current.filter((record) => record.id !== recordId))
    setStatusLine('这封来信已经轻轻放走了')
  }

  function clearAll() {
    stopPlayback()
    setActiveRecord(null)
    setRecords([])
    setStatusLine('所有来信都已清空，没有留下残响')
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-stars" aria-hidden="true" />
      <div className="ambient ambient-glow" aria-hidden="true" />
      <div className="ambient ambient-fog" aria-hidden="true" />

      <header className="topbar">
        <div>
          <p className="eyebrow">NightWhisper</p>
          <h1>深夜耳语电台</h1>
        </div>
        {yesterdayRecords.length > 0 ? (
          <button type="button" className="ghost-chip" onClick={() => setPage('history')}>
            昨日来信 {yesterdayRecords.length}
          </button>
        ) : (
          <span className="ghost-chip ghost-chip-muted">昨夜尚无来信</span>
        )}
      </header>

      {page === 'home' && (
        <main className="screen home-screen">
          <section className="hero-panel">
            <div className="hero-copy">
              <p className="slogan">深夜有言，有人倾听</p>
              <p className="status-line">{statusLine}</p>
            </div>

            <div className={`orbital-stage state-${composerState}`}>
              <div className="halo-ring halo-ring-1" aria-hidden="true" />
              <div className="halo-ring halo-ring-2" aria-hidden="true" />
              <button
                type="button"
                className={`whisper-button mode-${recordingMode}`}
                onPointerDown={handlePressStart}
                onPointerUp={handlePressEnd}
                onPointerCancel={handlePressEnd}
                onPointerLeave={() => {
                  if (recordingMode === 'hold') {
                    handlePressEnd()
                  }
                }}
              >
                <span className="button-core">
                  <span className="button-label">
                    {composerState === 'listening'
                      ? '正在倾诉'
                      : composerState === 'thinking'
                        ? '写回信中'
                        : composerState === 'replying'
                          ? '耳语回响'
                          : '今夜想说什么'}
                  </span>
                  <span className="button-subtitle">
                    {recordingMode === 'continuous'
                      ? '轻触结束'
                      : '轻触持续倾诉 / 长按说话'}
                  </span>
                </span>
              </button>
            </div>

            <div className="session-strip" aria-live="polite">
              <div>
                <span className="strip-label">收音状态</span>
                <strong>{permissionReady ? '已准备好' : '等待麦克风授权'}</strong>
              </div>
              <div>
                <span className="strip-label">本次倾诉</span>
                <strong>{formatDuration(recordingMs)}</strong>
              </div>
              <div>
                <span className="strip-label">今夜来信</span>
                <strong>{todayRecords.length} 封</strong>
              </div>
            </div>
          </section>
        </main>
      )}

      {page === 'history' && (
        <main className="screen list-screen">
          <section className="section-heading">
            <div>
              <p className="eyebrow">History</p>
              <h2>历史来信</h2>
            </div>
            {records.length > 0 ? (
              <button type="button" className="text-button" onClick={clearAll}>
                一键清空
              </button>
            ) : null}
          </section>

          <section className="letter-section">
            <div className="letter-group">
              <p className="group-label">今夜</p>
              {todayRecords.length > 0 ? (
                todayRecords.map((record) => (
                  <article key={record.id} className="letter-row">
                    <button
                      type="button"
                      className="letter-card"
                      onClick={() => playWholeLetter(record)}
                    >
                      <span>{describeLetter(record)}</span>
                      <strong>{formatClock(record.createdAt)}</strong>
                    </button>
                    <div className="letter-meta">
                      <span>{formatDuration(record.durationMs)}</span>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => deleteRecord(record.id)}
                        aria-label="删除来信"
                      >
                        ×
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="empty-state">今夜还没有留声，等你轻轻开口。</p>
              )}
            </div>

            {yesterdayRecords.length > 0 && (
              <div className="letter-group">
                <p className="group-label">昨日来信</p>
                {yesterdayRecords.map((record) => (
                  <article key={record.id} className="letter-row">
                    <button
                      type="button"
                      className="letter-card"
                      onClick={() => playWholeLetter(record)}
                    >
                      <span>{describeLetter(record)}</span>
                      <strong>{formatClock(record.createdAt)}</strong>
                    </button>
                    <div className="letter-meta">
                      <span>{formatDuration(record.durationMs)}</span>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => deleteRecord(record.id)}
                        aria-label="删除来信"
                      >
                        ×
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {earlierRecords.length > 0 && (
              <div className="letter-group">
                <p className="group-label">更早以前</p>
                {earlierRecords.map((record) => (
                  <article key={record.id} className="letter-row">
                    <button
                      type="button"
                      className="letter-card"
                      onClick={() => playWholeLetter(record)}
                    >
                      <span>{describeLetter(record)}</span>
                      <strong>{formatFullDate(record.createdAt)}</strong>
                    </button>
                    <div className="letter-meta">
                      <span>{record.replySeconds} 秒回信</span>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => deleteRecord(record.id)}
                        aria-label="删除来信"
                      >
                        ×
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      )}

      {page === 'about' && (
        <main className="screen about-screen">
          <section className="section-heading">
            <div>
              <p className="eyebrow">About</p>
              <h2>关于深夜耳语</h2>
            </div>
          </section>

          <section className="about-stack">
            <article className="about-block">
              <p className="block-kicker">唯一核心</p>
              <h3>只保留倾诉、来信、回听</h3>
              <p>
                没有信息流、没有社交公开、没有花哨功能。打开以后，只需要说话，然后安静听见一封属于你的深夜回信。
              </p>
            </article>

            <article className="about-block">
              <p className="block-kicker">主播人设</p>
              <h3>温柔、安静、包容的深夜电台声线</h3>
              <p>
                回信只承接情绪，不说教、不评判、不灌鸡汤。短倾诉给出轻柔短回信，长倾诉给出更完整的夜间陪伴。
              </p>
            </article>

            <article className="about-block">
              <p className="block-kicker">隐私与权限</p>
              <h3>仅使用麦克风与本地存档</h3>
              <p>
                录音、回信和时间轴记录只保留在当前设备浏览器中。你可以删除单条来信，也可以在历史页一键清空所有留声。
              </p>
            </article>
          </section>
        </main>
      )}

      <nav className="bottom-nav" aria-label="主导航">
        <button
          type="button"
          className={page === 'history' ? 'nav-link active' : 'nav-link'}
          onClick={() => setPage('history')}
        >
          历史来信
        </button>
        <button
          type="button"
          className={page === 'home' ? 'nav-link active nav-link-home' : 'nav-link nav-link-home'}
          onClick={() => setPage('home')}
        >
          倾诉
        </button>
        <button
          type="button"
          className={page === 'about' ? 'nav-link active' : 'nav-link'}
          onClick={() => setPage('about')}
        >
          关于深夜耳语
        </button>
      </nav>

      {activeRecord && (
        <aside className="letter-sheet">
          <div>
            <p className="block-kicker">当前来信</p>
            <h3>{describeLetter(activeRecord)}</h3>
            <p className="sheet-copy">
              已为你存好原声与回信。此处不展示文字内容，只保留聆听本身。
            </p>
          </div>

          <div className="sheet-meta">
            <span>{formatDuration(activeRecord.durationMs)}</span>
            <span>{activeRecord.replySeconds} 秒回信</span>
            <span>
              {playback.id === activeRecord.id
                ? playback.phase === 'user'
                  ? '正在播放你的耳语'
                  : '正在播放电台来信'
                : '随时可以回听'}
            </span>
          </div>

          <div className="sheet-actions">
            <button type="button" className="solid-button" onClick={() => playWholeLetter(activeRecord)}>
              完整回听
            </button>
            <button type="button" className="ghost-button" onClick={() => speakReply(activeRecord)}>
              只听回信
            </button>
            <button type="button" className="ghost-button" onClick={() => setActiveRecord(null)}>
              收起
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}

export default App
