import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Page = 'home' | 'history' | 'about'
type ComposerState = 'ready' | 'listening' | 'thinking' | 'replying'
type RecordingMode = 'idle' | 'hold' | 'continuous'
type PlaybackPhase = 'idle' | 'user' | 'ai'
type Mood = 'lonely' | 'anxious' | 'tired' | 'bright' | 'gentle' | 'empty'
type BackendState = 'checking' | 'ready' | 'error'
type PermissionState = 'checking' | 'prompt' | 'granted' | 'denied' | 'unsupported' | 'insecure'

interface WhisperRecord {
  id: string
  serverArchiveId?: string
  createdAt: string
  durationMs: number
  mood: Mood
  replyText: string
  replySeconds: number
  userAudioDataUrl?: string
  serverRecordingPath?: string | null
  replyAudioPath?: string | null
  transcript?: string
}

interface WhisperResponse {
  archiveId: string
  createdAt: string
  mood: Mood
  replyText: string
  replySeconds: number
  recordingPath?: string | null
  replyAudioPath?: string | null
  transcript?: string
}

interface HistoryResponse {
  items: Array<{
    id: string
    createdAt: string
    durationMs: number
    mood: Mood
    replyText: string
    replySeconds: number
    transcript?: string
    recordingPath?: string | null
    replyAudioPath?: string | null
  }>
}

interface HealthResponse {
  status: string
  aiConfigured: boolean
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
const API_BASE = import.meta.env.VITE_API_BASE ?? ''
const initialStatus = '深夜有言，有人倾听'

function getTimeOfDay(hour: number) {
  if (hour >= 0 && hour <= 5) return { prefix: '凌晨', mood: '深夜' }
  if (hour >= 6 && hour <= 8) return { prefix: '清晨', mood: '清晨' }
  if (hour >= 9 && hour <= 11) return { prefix: '上午', mood: '上午' }
  if (hour >= 12 && hour <= 13) return { prefix: '中午', mood: '午后' }
  if (hour >= 14 && hour <= 17) return { prefix: '下午', mood: '傍晚' }
  if (hour >= 18 && hour <= 21) return { prefix: '晚上', mood: '夜晚' }
  return { prefix: '深夜', mood: '深夜' }
}

function getCurrentTimeContext() {
  const now = new Date()
  return getTimeOfDay(now.getHours())
}

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
    return Array.isArray(parsed) ? parsed : []
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
  const { prefix } = getTimeOfDay(date.getHours())
  return `${prefix}${hour}点的耳语`
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

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function mergeServerRecords(current: WhisperRecord[], incoming: HistoryResponse['items']) {
  const byId = new Map<string, WhisperRecord>()

  for (const record of current) {
    byId.set(record.serverArchiveId ?? record.id, record)
  }

  for (const item of incoming) {
    const existing = byId.get(item.id)
    byId.set(item.id, {
      id: item.id,
      serverArchiveId: item.id,
      createdAt: item.createdAt,
      durationMs: item.durationMs,
      mood: item.mood,
      replyText: item.replyText,
      replySeconds: item.replySeconds,
      transcript: item.transcript,
      serverRecordingPath: item.recordingPath ?? null,
      replyAudioPath: item.replyAudioPath ?? null,
      userAudioDataUrl: existing?.userAudioDataUrl,
    })
  }

  return [...byId.values()].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  )
}

async function fetchJson<T>(url: string, options?: RequestInit) {
  const response = await fetch(url, options)
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`)
  }
  return (await response.json()) as T
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
  const [permissionState, setPermissionState] = useState<PermissionState>('checking')
  const [permissionHint, setPermissionHint] = useState('首次使用请先授权麦克风，之后就能一键倾诉。')
  const [backendState, setBackendState] = useState<BackendState>('checking')

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
    void (async () => {
      await syncPermissionState()
      const backendOk = await checkBackend(true)
      if (!backendOk) {
        return
      }

      try {
        const history = await fetchJson<HistoryResponse>(`${API_BASE}/api/history`)
        setRecords((current) => mergeServerRecords(current, history.items))
      } catch {
        setBackendState('error')
      }
    })()

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

  function describePermission(state: PermissionState) {
    if (state === 'granted') {
      return { badge: '已授权', detail: '麦克风权限已就绪，长按或轻触都可直接倾诉。' }
    }
    if (state === 'denied') {
      return { badge: '被拒绝', detail: '麦克风权限被拒绝，请在浏览器地址栏权限设置中重新允许。' }
    }
    if (state === 'unsupported') {
      return { badge: '不支持', detail: '当前浏览器不支持麦克风录音，请更换 Chrome / Safari。' }
    }
    if (state === 'insecure') {
      return { badge: '需 HTTPS', detail: '麦克风只能在 HTTPS 或 localhost 下申请。' }
    }
    if (state === 'prompt') {
      return { badge: '待授权', detail: '点击下方按钮即可立即申请麦克风权限。' }
    }
    return { badge: '检测中', detail: '正在确认当前浏览器的麦克风权限状态。' }
  }

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

  async function checkBackend(silent: boolean) {
    try {
      const health = await fetchJson<HealthResponse>(`${API_BASE}/api/health`)
      if (!health.aiConfigured) {
        setBackendState('ready')
        if (!silent) {
          setStatusLine('真实 AI 还没配置完成，当前先使用温柔兜底回信')
        }
        return true
      }

      setBackendState('ready')
      if (!silent) {
        setStatusLine(`AI ${getCurrentTimeContext().mood}回信服务已经连上了`)
      }
      return true
    } catch {
      setBackendState('error')
      if (!silent) {
        setStatusLine(`AI ${getCurrentTimeContext().mood}回信服务暂时没有连上`)
      }
      return false
    }
  }

  async function syncPermissionState() {
    if (!window.isSecureContext) {
      setPermissionState('insecure')
      setPermissionHint('当前页面不是安全上下文，请通过 HTTPS 打开后再授权麦克风。')
      return 'insecure'
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setPermissionState('unsupported')
      setPermissionHint('当前浏览器不支持麦克风访问。')
      return 'unsupported'
    }

    try {
      if (!navigator.permissions?.query) {
        setPermissionState(streamRef.current ? 'granted' : 'prompt')
        setPermissionHint(
          streamRef.current
            ? '麦克风权限已就绪，随时可以倾诉。'
            : '点击“授权麦克风”后，即可开始倾诉。',
        )
        return streamRef.current ? 'granted' : 'prompt'
      }

      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
      if (status.state === 'granted') {
        setPermissionState('granted')
        setPermissionHint('麦克风权限已授权，长按或轻触按钮都能直接录音。')
        return 'granted'
      }

      if (status.state === 'denied') {
        setPermissionState('denied')
        setPermissionHint('麦克风权限当前为拒绝，请去浏览器权限设置改为允许。')
        return 'denied'
      }

      setPermissionState('prompt')
      setPermissionHint('点击“授权麦克风”后，浏览器会弹出权限请求。')
      return 'prompt'
    } catch {
      setPermissionState(streamRef.current ? 'granted' : 'prompt')
      setPermissionHint(
        streamRef.current ? '麦克风权限已就绪。' : '点击“授权麦克风”后，浏览器会申请录音权限。',
      )
      return streamRef.current ? 'granted' : 'prompt'
    }
  }

  async function requestMicrophonePermission() {
    if (!window.isSecureContext) {
      setPermissionState('insecure')
      setPermissionHint('当前页面不是 HTTPS，浏览器不会弹出麦克风授权。')
      setStatusLine('请先用 HTTPS 打开 NightWhisper，再申请麦克风权限')
      throw new Error('麦克风权限仅支持 HTTPS 或 localhost。')
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setPermissionState('unsupported')
      setPermissionHint('当前浏览器不支持麦克风访问。')
      throw new Error('当前浏览器暂不支持麦克风访问。')
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream
      setPermissionState('granted')
      setPermissionHint('麦克风授权成功，此刻想说什么都可以直接开始。')
      setStatusLine('麦克风权限已就绪，可以开始倾诉')
      return stream
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        setPermissionState('denied')
        setPermissionHint('你刚刚拒绝了麦克风权限，请在浏览器设置里改为允许。')
        setStatusLine('麦克风权限被拒绝，请到浏览器权限设置重新允许')
      } else {
        setPermissionState('prompt')
        setPermissionHint('暂时没能打开麦克风，可点击按钮再次申请。')
      }
      throw error
    }
  }

  async function ensureStream() {
    if (streamRef.current) {
      return streamRef.current
    }
    return requestMicrophonePermission()
  }

  function stopPlayback() {
    audioRef.current?.pause()
    audioRef.current = null
    window.speechSynthesis?.cancel()
    setPlayback({ id: null, phase: 'idle' })
  }

  function finishPlayback(record: WhisperRecord) {
    setPlayback({ id: null, phase: 'idle' })
    setComposerState('ready')
    setStatusLine(`已存好，随时都能回听 · ${describeLetter(record)}`)
  }

  function speakReply(record: WhisperRecord) {
    const replySource = record.replyAudioPath ? `${API_BASE}${record.replyAudioPath}` : undefined
    if (replySource) {
      const audio = new Audio(replySource)
      audioRef.current = audio
      audio.onended = () => finishPlayback(record)
      audio.onerror = () => {
        audioRef.current = null
        finishPlayback(record)
      }
      setPlayback({ id: record.id, phase: 'ai' })
      void audio.play().catch(() => finishPlayback(record))
      return
    }

    if (!window.speechSynthesis) {
      finishPlayback(record)
      return
    }

    const utterance = new SpeechSynthesisUtterance(record.replyText)
    utterance.lang = 'zh-CN'
    utterance.rate = 0.84
    utterance.pitch = 0.82
    utterance.volume = 0.82
    utterance.onend = () => {
      finishPlayback(record)
    }

    setPlayback({ id: record.id, phase: 'ai' })
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }

  function playWholeLetter(record: WhisperRecord) {
    stopPlayback()
    setActiveRecord(record)
    setStatusLine('正在回听这封来信')

    const playbackSource = record.userAudioDataUrl || (record.serverRecordingPath ? `${API_BASE}${record.serverRecordingPath}` : undefined)

    if (playbackSource) {
      const audio = new Audio(playbackSource)
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

    const backendOk = backendState === 'ready' ? true : await checkBackend(false)
    if (!backendOk) {
      return
    }

    try {
      if (permissionState !== 'granted') {
        await requestMicrophonePermission()
      }
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

    lastDurationRef.current = Math.max(1000, Date.now() - startAtRef.current)
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
    const durationMs = lastDurationRef.current || recordingMs || 1000

    try {
      const formData = new FormData()
      if (blob.size > 0) {
        formData.append('audio', blob, 'whisper.webm')
      }
      formData.append('transcript', transcript)
      formData.append('durationMs', `${durationMs}`)

      const payload = await fetchJson<WhisperResponse>(`${API_BASE}/api/whispers`, {
        method: 'POST',
        body: formData,
      })

      const record: WhisperRecord = {
        id: payload.archiveId,
        serverArchiveId: payload.archiveId,
        createdAt: payload.createdAt,
        durationMs,
        mood: payload.mood,
        replyText: payload.replyText,
        replySeconds: payload.replySeconds,
        transcript: payload.transcript || transcript,
        userAudioDataUrl: blob.size > 0 ? await blobToDataUrl(blob) : undefined,
        serverRecordingPath: payload.recordingPath ?? null,
        replyAudioPath: payload.replyAudioPath ?? null,
      }

      window.setTimeout(() => {
        setRecords((current) => [record, ...current].slice(0, 24))
        setActiveRecord(record)
        setComposerState('replying')
        setStatusLine('你的专属来信，已经落下来了')
        speakReply(record)
      }, 720)
    } catch {
      setBackendState('error')
      setComposerState('ready')
      setStatusLine('回信服务暂时失联了，请稍后再试')
    }
  }

  function handlePressStart() {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current)
    }

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
              <div className="nightwhisper-mark">
                <span className="mark-orb" aria-hidden="true" />
                <span className="mark-text">NightWhisper After Dark</span>
              </div>
              <p className="slogan">深夜有言，有人倾听</p>
              <p className="status-line">{statusLine}</p>
              <div className="intro-passage">
                <p className="intro-line">
                  当白天的声音慢慢退远，总有一些话，只适合在灯灭以后，轻轻交给夜色。
                </p>
                <p className="intro-line intro-line-soft">
                  在这里，你不用整理句子，不用解释情绪，也不用急着变得更好。只要开口，深夜就会替你把心事接住。
                </p>
              </div>
              <p className="hero-microcopy">夜深的时候，先说给风听，再说给我听。</p>
            </div>

            {permissionState !== 'granted' && (
              <section className="permission-panel" aria-live="polite">
                <p className="permission-kicker">麦克风权限</p>
                <h3>{describePermission(permissionState).badge}</h3>
                <p className="permission-copy">{permissionHint || describePermission(permissionState).detail}</p>
                <div className="permission-actions">
                  <button
                    type="button"
                    className="solid-button"
                    onClick={() => {
                      void requestMicrophonePermission().catch(() => {})
                    }}
                    disabled={permissionState === 'insecure' || permissionState === 'unsupported'}
                  >
                    {permissionState === 'denied' ? '重新申请权限' : '授权麦克风'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      void syncPermissionState()
                    }}
                  >
                    刷新权限状态
                  </button>
                </div>
              </section>
            )}

            <div className={`orbital-stage state-${composerState}`}>
              <div className="lunar-glow" aria-hidden="true" />
              <div className="whisper-dust whisper-dust-left" aria-hidden="true" />
              <div className="whisper-dust whisper-dust-right" aria-hidden="true" />
              <div className="halo-ring halo-ring-1" aria-hidden="true" />
              <div className="halo-ring halo-ring-2" aria-hidden="true" />
              <div className="echo-arc echo-arc-1" aria-hidden="true" />
              <div className="echo-arc echo-arc-2" aria-hidden="true" />
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
                <span className="button-aura" aria-hidden="true" />
                <span className="button-shell" aria-hidden="true" />
                <span className="button-core">
                  <span className="button-glyph" aria-hidden="true">
                    <span className="glyph-dot" />
                    <span className="glyph-wave glyph-wave-1" />
                    <span className="glyph-wave glyph-wave-2" />
                    <span className="glyph-wave glyph-wave-3" />
                  </span>
                  <span className="button-label">
                    {composerState === 'listening'
                      ? '正在倾诉'
                      : composerState === 'thinking'
                        ? '写回信中'
                        : composerState === 'replying'
                          ? '耳语回响'
                          : '此刻想说什么'}
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
                <span className="strip-label">AI 回信</span>
                <strong>
                  {backendState === 'ready'
                    ? '已连接'
                    : backendState === 'checking'
                      ? '检测中'
                      : '未连通'}
                </strong>
              </div>
              <div>
                <span className="strip-label">麦克风</span>
                <strong>{describePermission(permissionState).badge}</strong>
              </div>
              <div>
                <span className="strip-label">本次倾诉</span>
                <strong>{formatDuration(recordingMs)}</strong>
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
              <p className="group-label">今天</p>
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
                <p className="empty-state">今天还没有留声，等你轻轻开口。</p>
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

          <section className="about-intro">
            <p className="about-intro-kicker">给深夜留一盏小灯</p>
            <h3>不是聊天工具，更像一封会回声的夜间来信。</h3>
            <p className="about-intro-copy">
              NightWhisper 想做的，不是替你回答世界，而是在那些失眠、委屈、疲惫、说不出口的时刻，
              给你一段不被打断的安静陪伴。你说，夜色来听；你停顿，回信也会慢慢落下来。
            </p>
          </section>

          <section className="about-stack">
            <article className="about-block">
              <p className="block-kicker">深夜电台</p>
              <h3>这里只有倾诉、回信，与那些被温柔收存的夜晚。</h3>
              <p>
                没有信息流，没有热闹广场，也没有需要学习的复杂功能。打开以后，你只需要把心事交出来，
                剩下的交给这一段低声的夜间陪伴。
              </p>
            </article>

            <article className="about-block">
              <p className="block-kicker">回信方式</p>
              <h3>你的声音会被认真接住，再被写成一封贴近情绪的电台回信。</h3>
              <p>
                当你说完，耳语会被安静送往后端，由 NightWhisper 的深夜主播语气轻轻整理、回应、归档，
                然后再回到你耳边。它不说教，也不催促，只陪你把这一刻走完。
              </p>
            </article>

            <article className="about-block">
              <p className="block-kicker">私密边界</p>
              <h3>每一封来信都留在属于你的夜里，不被围观，也不必展示。</h3>
              <p>
                页面不主动展示你的文字，不把情绪变成公开内容。你可以随时回听、删除，或让一整晚的留声彻底归于安静，
                不留下多余的喧哗痕迹。
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
