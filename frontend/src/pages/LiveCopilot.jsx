import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

const API_BASE = import.meta.env.VITE_API_BASE_URL
// The backend URL is https://... (Render); a WebSocket to the same
// host just needs wss:// instead -- everything else about the address
// is identical.
const WS_BASE = API_BASE ? API_BASE.replace(/^http/, 'ws') : ''

const CALIBRATION_MS = 6000

// Render's free hosting tier sleeps the backend after ~15 min idle.
// A Live Copilot session can easily sit quietly for longer than that
// while waiting for the interviewer to actually start talking (mic on,
// calibrated, just... waiting) -- with no requests going to the
// backend in that time, it could fall asleep mid-session and then be
// slow to respond to the first real suggestion. Pinging /health every
// few minutes for as long as a session is running keeps it warm.
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

// Deepgram closes a live connection if it gets neither audio NOR a
// KeepAlive message for 10 seconds straight (its NET-0001 error).
// Pausing stops us sending audio on purpose -- so while paused, send
// an explicit KeepAlive text message on this schedule (Deepgram's
// own docs recommend every 3-5s) so a long Pause (e.g. the
// interviewer still talking while you've paused suggestions) doesn't
// silently kill the connection.
const KEEP_ALIVE_WHILE_PAUSED_MS = 4000

// If the connection drops (bad wifi, a few seconds of no internet,
// etc.), keep retrying rather than giving up -- 2s, 4s, 6s... capped
// at 15s between tries, forever (until you click End Session). The
// mic keeps recording the whole time (see bufferAudioChunk below), so
// nothing said during the gap is lost -- it's sent the moment the
// connection comes back.
const RECONNECT_BASE_DELAY_MS = 2000
const RECONNECT_MAX_DELAY_MS = 15000

// How much audio to hold onto while disconnected before we start
// dropping the OLDEST of it. 120s is generous for a real connectivity
// blip without letting memory grow without bound if you're genuinely
// offline for much longer than that.
const MAX_BUFFERED_AUDIO_SECONDS = 120
const QUICK_POINTS_MARKER = 'QUICK POINTS:'
const SUGGESTED_ANSWER_MARKER = 'SUGGESTED ANSWER:'
const MAX_QA_MATCHES = 3
// How many of this Track's knowledge-base chunks (see Tracks.jsx's
// "Knowledge base" section) to pull in per question -- kept small
// since these get sent on every live suggestion request, same
// reasoning as MAX_QA_MATCHES above.
const MAX_TRACK_KNOWLEDGE_MATCHES = 4

// Real semantic search (30 Sep upgrade, replacing keyword-overlap
// matching). Cosine similarity is the standard way to compare two
// embedding vectors -- 1 means "same meaning", 0 means "unrelated".
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Embeds the interviewer's question via NVIDIA's hosted embeddings API
// (same NVIDIA_API_KEY already configured on Render -- see
// embed_text() in providers.py) and compares it against each saved
// Q&A entry's PRE-COMPUTED embedding (computed once when the entry
// was added in Profile.jsx, cached in Supabase's qa_entries.embedding
// column). Matches by MEANING, not shared words -- "who was your last
// client" now matches "tell me about your most recent employer" even
// though they share no words, unlike the old keyword-overlap version
// this replaces. Entries that don't have an embedding yet (e.g. added
// right before this upgrade shipped, still being backfilled) are
// simply skipped rather than causing an error.
async function matchQaEntriesSemantic(question, qaEntries) {
  const withEmbeddings = qaEntries.filter((e) => Array.isArray(e.embedding) && e.embedding.length > 0)
  if (withEmbeddings.length === 0) return []
  let questionEmbedding
  try {
    const res = await fetch(`${API_BASE}/api/embed-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question, input_type: 'query' }),
    })
    if (!res.ok) return []
    const json = await res.json()
    questionEmbedding = json.embedding
  } catch {
    return []
  }
  const scored = withEmbeddings
    .map((e) => ({ entry: e, similarity: cosineSimilarity(questionEmbedding, e.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, MAX_QA_MATCHES).map((s) => s.entry)
}

// Same idea as matchQaEntriesSemantic above, but over this Track's
// (possibly very large) knowledge base instead of the global Q&A
// bank -- each chunk was embedded once when it was indexed in
// Tracks.jsx, so this is just comparing against already-computed
// vectors, one embedding call for the question itself.
async function matchTrackKnowledgeSemantic(question, chunks) {
  const withEmbeddings = chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
  if (withEmbeddings.length === 0) return []
  let questionEmbedding
  try {
    const res = await fetch(`${API_BASE}/api/embed-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question, input_type: 'query' }),
    })
    if (!res.ok) return []
    const json = await res.json()
    questionEmbedding = json.embedding
  } catch {
    return []
  }
  const scored = withEmbeddings
    .map((c) => ({ chunk: c, similarity: cosineSimilarity(questionEmbedding, c.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, MAX_TRACK_KNOWLEDGE_MATCHES).map((s) => s.chunk)
}

// The backend streams plain text in a fixed two-section format (see
// stream_live_suggestion_chunks in providers.py). This pulls whatever
// has arrived SO FAR apart into {quickPointers, suggestedAnswer} --
// called on every chunk while streaming, so both sections can visibly
// grow as text arrives instead of popping in all at once.
function parseStreamedSuggestion(fullText) {
  let pointsBlock = fullText
  let answerBlock = ''
  const markerIdx = fullText.indexOf(SUGGESTED_ANSWER_MARKER)
  if (markerIdx !== -1) {
    pointsBlock = fullText.slice(0, markerIdx)
    answerBlock = fullText.slice(markerIdx + SUGGESTED_ANSWER_MARKER.length).trim()
  }
  pointsBlock = pointsBlock.replace(QUICK_POINTS_MARKER, '').trim()
  const quickPointers = pointsBlock
    .split('\n')
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean)
  return { quickPointers, suggestedAnswer: answerBlock }
}

// Holds one raw PCM16 audio chunk that couldn't be sent because the
// connection to the backend was down at the time -- see
// processor.onaudioprocess below, which calls this instead of
// silently dropping the audio the way it used to.
function bufferAudioChunk(state, buffer) {
  const seconds = buffer.byteLength / 2 / 16000 // 16-bit samples, 16kHz
  state.pendingAudioChunks.push(buffer)
  state.pendingAudioSeconds += seconds
  while (state.pendingAudioSeconds > MAX_BUFFERED_AUDIO_SECONDS && state.pendingAudioChunks.length > 1) {
    const dropped = state.pendingAudioChunks.shift()
    state.pendingAudioSeconds -= dropped.byteLength / 2 / 16000
  }
}

// Sends everything that piled up while disconnected, in one go, the
// moment the connection is back -- Deepgram transcribes it in a quick
// burst rather than real-time, which is what lets you "catch up"
// instead of losing what was said during the gap.
function flushPendingAudio(state) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
  const chunks = state.pendingAudioChunks
  state.pendingAudioChunks = []
  state.pendingAudioSeconds = 0
  for (const buf of chunks) {
    try {
      state.ws.send(buf)
    } catch (e) {
      break
    }
  }
}

/**
 * Live Interview Copilot: listens during a REAL interview (not
 * simulated) through one mic, tells your voice apart from the
 * interviewer's (Deepgram diarization + a short one-time calibration
 * step), and shows quick suggested replies the moment the interviewer
 * finishes asking something -- silently, text-only, never speaking
 * back. Suggestions stream in live (typed-out, not a sudden
 * paragraph); the newest suggestion is pinned at the top, visually
 * separate from earlier ones, so it's easy to glance at mid-call.
 *
 * If the connection drops for a few seconds (flaky wifi, a brief
 * outage), it auto-reconnects and replays whatever you said in the
 * meantime -- see connectWebSocket/scheduleReconnect below -- instead
 * of resetting the whole session.
 */
function LiveCopilot() {
  const { session, profile } = useAuth()

  const [tracks, setTracks] = useState([])
  const [selectedTrackId, setSelectedTrackId] = useState('')
  const [qaEntries, setQaEntries] = useState([])
  // This Track's knowledge-base chunks (see Tracks.jsx), refetched
  // whenever the selected Track changes -- only the few most
  // relevant ones get sent per question, via matchTrackKnowledgeSemantic.
  const [trackKnowledgeChunks, setTrackKnowledgeChunks] = useState([])
  // idle | preparing | calibrating | live | ended
  const [status, setStatus] = useState('idle')
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState(null)
  // connected | reconnecting -- see connectWebSocket/scheduleReconnect
  const [connectionState, setConnectionState] = useState('connected')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [turns, setTurns] = useState([])
  const [suggestions, setSuggestions] = useState([]) // {id, question, quickPointers, suggestedAnswer, streaming}
  // The CURRENT, not-yet-flushed speaker turn, shown immediately as
  // each Deepgram "final" chunk arrives, instead of waiting for a
  // speaker change/UtteranceEnd to flush the whole turn to `turns`
  // below -- so the transcript appears live instead of all at once.
  const [liveLine, setLiveLine] = useState(null) // {speaker, text}
  // Older suggestions collapse by default so the latest 2 always fit
  // on screen together -- this expands the full history on demand.
  const [showEarlierSuggestions, setShowEarlierSuggestions] = useState(false)

  const liveRef = useRef(null)
  const mountedRef = useRef(true)
  const suggestionIdRef = useRef(0)
  const turnIdRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!session) return
    supabase
      .from('tracks')
      .select('id, company_name, role_title, resume_path, jd_text, jd_path, notes')
      .order('created_at', { ascending: false })
      .then(({ data, error: fetchError }) => {
        if (!fetchError) setTracks(data || [])
      })
    supabase
      .from('qa_entries')
      .select('id, question, answer, embedding')
      .then(({ data, error: fetchError }) => {
        if (!fetchError) setQaEntries(data || [])
      })
  }, [session])

  useEffect(() => {
    return () => stopSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!session) return <p>Log in to use Live Copilot.</p>
  if (!API_BASE) {
    return <p className="form-error">Live Copilot isn't configured yet (missing API base URL).</p>
  }

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId)

  useEffect(() => {
    if (!selectedTrackId) {
      setTrackKnowledgeChunks([])
      return
    }
    supabase
      .from('track_knowledge_chunks')
      .select('id, chunk_text, embedding')
      .eq('track_id', selectedTrackId)
      .then(({ data, error: fetchError }) => {
        if (!fetchError) setTrackKnowledgeChunks(data || [])
      })
  }, [selectedTrackId])

  async function extractFileText(path) {
    if (!path) return ''
    const { data, error: urlError } = await supabase.storage.from('resumes').createSignedUrl(path, 300)
    if (urlError) throw new Error('Could not read file: ' + urlError.message)
    const res = await fetch(`${API_BASE}/api/extract-resume-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: data.signedUrl, filename: path }),
    })
    const json = await res.json()
    if (!json.ok) throw new Error(json.error || 'Could not read file text')
    return json.text
  }

  // A completed utterance (already coalesced by speaker in
  // handleDeepgramMessage below) is added to the transcript and, for
  // the candidate's own record, saved. Interviewer turns additionally
  // trigger a suggestion request.
  async function appendCompletedTurn(speaker, text) {
    // A client-side id, separate from the database row's id below --
    // this is what lets fixLastTurnSpeaker() (further down) find and
    // remove/retrigger the right suggestion when correcting a
    // misattributed turn, without waiting on the DB insert.
    const localTurnId = ++turnIdRef.current
    setTurns((prev) => [...prev, { speaker, text, localTurnId, dbTurnId: null }])
    const sid = liveRef.current?.sessionId
    let dbTurnId = null
    if (sid) {
      const { data, error: insertError } = await supabase
        .from('live_turns')
        .insert({ session_id: sid, speaker, text })
        .select('id')
        .single()
      if (insertError) console.error('Failed to save turn:', insertError.message)
      else {
        dbTurnId = data.id
        setTurns((prev) => prev.map((t) => (t.localTurnId === localTurnId ? { ...t, dbTurnId } : t)))
      }
    }
    if (speaker === 'interviewer') {
      requestSuggestion(text, dbTurnId, localTurnId)
    }
  }

  // Deepgram's live diarization has no confidence score to catch this
  // automatically (checked their docs -- speaker_confidence only
  // exists for pre-recorded audio, not streaming), so a short
  // interjection like "okay" right after the interviewer finishes can
  // get attributed to the wrong speaker with no reliable signal to
  // detect it. This is the manual fix: flips the LAST completed
  // turn's speaker. If it's being corrected AWAY from "interviewer",
  // the suggestion that turn wrongly triggered is removed. If it's
  // being corrected TO "interviewer" (it really was their question),
  // a suggestion is requested for it now, since none was triggered
  // the first time.
  // NOTE: side effects (the supabase update, possibly requestSuggestion)
  // deliberately happen OUTSIDE the setTurns updater below -- a setState
  // updater function should stay pure, since React can invoke it more
  // than once (e.g. under StrictMode in dev) to check for exactly this.
  function fixLastTurnSpeaker() {
    if (turns.length === 0) return
    const last = turns[turns.length - 1]
    const flipped = last.speaker === 'you' ? 'interviewer' : 'you'
    setTurns((prev) => [...prev.slice(0, -1), { ...last, speaker: flipped }])

    if (last.speaker === 'interviewer' && flipped === 'you') {
      setSuggestions((prev) => prev.filter((s) => s.localTurnId !== last.localTurnId))
    }
    if (last.speaker === 'you' && flipped === 'interviewer') {
      requestSuggestion(last.text, last.dbTurnId, last.localTurnId)
    }
    if (last.dbTurnId) {
      supabase
        .from('live_turns')
        .update({ speaker: flipped })
        .eq('id', last.dbTurnId)
        .then(({ error: updateError }) => {
          if (updateError) console.error('Failed to fix turn speaker:', updateError.message)
        })
    }
  }

  // Reads the streamed response chunk by chunk, updating this one
  // suggestion entry's text as it grows -- this is what makes it
  // appear "typed" live instead of arriving as one sudden paragraph.
  async function requestSuggestion(question, turnId, localTurnId) {
    const id = ++suggestionIdRef.current
    const placeholder = { id, question, quickPointers: [], suggestedAnswer: '', streaming: true, localTurnId }
    if (mountedRef.current) setSuggestions((prev) => [...prev, placeholder])

    let fullText = ''
    try {
      const matchedQa = await matchQaEntriesSemantic(question, qaEntries)
      const qaContext = matchedQa.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
      const matchedKnowledge = await matchTrackKnowledgeSemantic(question, trackKnowledgeChunks)
      const knowledgeContext = matchedKnowledge.map((c) => c.chunk_text).join('\n\n')
      const res = await fetch(`${API_BASE}/api/live-suggestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          company_name: selectedTrack?.company_name || '',
          role_title: selectedTrack?.role_title || '',
          jd_text: liveRef.current?.jdText || '',
          resume_text: liveRef.current?.resumeText || '',
          qa_context: qaContext,
          profile_summary: profile?.summary || '',
          track_notes: selectedTrack?.notes || '',
          knowledge_context: knowledgeContext,
        }),
      })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullText += decoder.decode(value, { stream: true })
        const parsed = parseStreamedSuggestion(fullText)
        if (mountedRef.current) {
          setSuggestions((prev) => prev.map((s) => (s.id === id ? { ...s, ...parsed, streaming: true } : s)))
        }
      }
    } catch (err) {
      console.error('Suggestion error:', err.message)
    }

    const final = parseStreamedSuggestion(fullText)
    if (mountedRef.current) {
      setSuggestions((prev) => prev.map((s) => (s.id === id ? { ...s, ...final, streaming: false } : s)))
    }

    const sid = liveRef.current?.sessionId
    if (sid && (final.quickPointers.length > 0 || final.suggestedAnswer)) {
      const { error: insertError } = await supabase.from('live_suggestions').insert({
        session_id: sid,
        turn_id: turnId,
        quick_pointers: final.quickPointers,
        suggested_answer: final.suggestedAnswer,
      })
      if (insertError) console.error('Failed to save suggestion:', insertError.message)
    }
  }

  function flushCurrentBuffer() {
    const state = liveRef.current
    if (!state) return
    const buf = state.currentBuffer
    state.currentBuffer = null
    if (mountedRef.current) setLiveLine(null)
    if (buf && buf.text.trim()) {
      appendCompletedTurn(buf.speaker, buf.text.trim())
    }
  }

  function handleDeepgramMessage(raw) {
    const state = liveRef.current
    if (!state) return
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return
    }

    if (parsed.error) {
      // The backend relayed an error (from Deepgram, or one it hit
      // itself) right before it closes the connection -- show the
      // real reason. The connection will still auto-reconnect right
      // after this (ws.onclose fires next), so this message may be
      // briefly followed by a "retrying" one -- both are informative,
      // neither needs suppressing.
      if (mountedRef.current) setError('Live listening stopped: ' + parsed.error)
      return
    }

    if (parsed.type === 'UtteranceEnd') {
      // Deepgram's own docs: a last_word_end of -1 marks a stale
      // UtteranceEnd for a result that was already finalized --
      // acting on it anyway can split one sentence into extra empty
      // turns. Skip those.
      if (parsed.last_word_end === -1) return
      flushCurrentBuffer()
      return
    }
    if (parsed.type !== 'Results') return

    const alt = parsed.channel?.alternatives?.[0]
    const words = alt?.words || []
    if (words.length === 0 || !alt.transcript) return

    // Deepgram tags each WORD with a speaker number; take whichever
    // speaker said most of this chunk as this chunk's speaker.
    const counts = {}
    for (const w of words) counts[w.speaker] = (counts[w.speaker] || 0) + 1
    const speakerLabel = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]

    if (state.calibrating) {
      // Only count FINAL chunks towards calibration -- an interim
      // result covers the same stretch of speech as the final one
      // that follows it, so counting both would double-count words.
      if (parsed.is_final) {
        state.calibrationCounts[speakerLabel] = (state.calibrationCounts[speakerLabel] || 0) + words.length
      }
      return
    }

    // Tracks whichever OTHER label has actually been heard, so Swap
    // Speakers (below) can flip to a real, seen label instantly
    // instead of needing fresh audio the way Recalibrate does.
    if (speakerLabel !== state.youSpeakerLabel) {
      state.otherSpeakerLabel = speakerLabel
    }

    const speakerTag = speakerLabel === state.youSpeakerLabel ? 'you' : 'interviewer'

    if (!parsed.is_final) {
      // Deepgram may still revise this exact text (it's mid-utterance,
      // not yet finalized) -- show it live, on top of whatever's
      // already confirmed for this speaker, WITHOUT committing it to
      // the real transcript yet. This is what makes words appear as
      // they're actually spoken instead of only once Deepgram decides
      // the sentence is done.
      if (mountedRef.current) {
        const confirmed = state.currentBuffer && state.currentBuffer.speaker === speakerTag ? state.currentBuffer.text + ' ' : ''
        setLiveLine({ speaker: speakerTag, text: confirmed + alt.transcript, interim: true })
      }
      return
    }

    if (state.currentBuffer && state.currentBuffer.speaker === speakerTag) {
      state.currentBuffer.text += ' ' + alt.transcript
    } else {
      flushCurrentBuffer()
      state.currentBuffer = { speaker: speakerTag, text: alt.transcript }
    }
    // Show this chunk on screen right away -- don't wait for the
    // speaker to change or for UtteranceEnd to flush the full turn.
    if (mountedRef.current) {
      setLiveLine({ speaker: state.currentBuffer.speaker, text: state.currentBuffer.text, interim: false })
    }
  }

  async function startSession() {
    setError(null)
    setTurns([])
    setSuggestions([])
    setShowEarlierSuggestions(false)
    setPaused(false)
    setConnectionState('connected')
    setReconnectAttempt(0)
    setStatus('preparing')

    let resumeText = ''
    let jdText = selectedTrack?.jd_text || ''
    try {
      resumeText = await extractFileText(selectedTrack?.resume_path)
      if (!jdText && selectedTrack?.jd_path) {
        jdText = await extractFileText(selectedTrack.jd_path)
      }
    } catch (err) {
      setError(err.message)
      setStatus('idle')
      return
    }

    let stream
    try {
      // echoCancellation is deliberately OFF here, unlike Mock
      // Interview: when the real interview is a video call on THIS
      // laptop, the interviewer's voice comes out of your speakers --
      // if echo cancellation strips that "echo" out, this mic would
      // never hear the interviewer at all. Use your laptop's built-in
      // speakers (not headphones) for that setup so the mic can pick
      // up both voices; for an in-person interview this doesn't matter.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      setError('Mic error: ' + err.message)
      setStatus('idle')
      return
    }

    const state = {
      stream,
      sessionId: null,
      resumeText,
      jdText,
      youSpeakerLabel: null,
      otherSpeakerLabel: null,
      calibrating: true,
      calibrationCounts: {},
      currentBuffer: null,
      paused: false,
      // Set right before WE deliberately close the WebSocket (End
      // Session, or this component unmounting) -- lets ws.onclose
      // tell apart "you ended this on purpose" from "the connection
      // just dropped", which previously looked identical and silently
      // dropped you back to the Start Listening screen either way.
      userInitiatedClose: false,
      // Raw audio that couldn't be sent while disconnected -- see
      // bufferAudioChunk/flushPendingAudio above.
      pendingAudioChunks: [],
      pendingAudioSeconds: 0,
      // How many reconnect attempts in a row, and the pending retry
      // timer -- see scheduleReconnect below.
      reconnectAttempt: 0,
      reconnectTimer: null,
    }
    liveRef.current = state

    // Keep the backend awake for as long as this session runs --
    // see KEEP_ALIVE_INTERVAL_MS above. Errors here are ignored on
    // purpose: a failed keep-alive ping just means the NEXT real
    // request might have to wait through a cold start, same as if
    // this didn't exist at all -- not something to interrupt the
    // interview over.
    state.keepAliveTimer = setInterval(() => {
      fetch(`${API_BASE}/health`).catch(() => {})
    }, KEEP_ALIVE_INTERVAL_MS)

    try {
      const { data: sessionRow, error: sessionError } = await supabase
        .from('live_sessions')
        .insert({ user_id: session.user.id, track_id: selectedTrackId || null })
        .select('id')
        .single()
      if (sessionError) throw sessionError
      state.sessionId = sessionRow.id
    } catch (err) {
      console.error('Could not create live session row:', err.message)
    }

    connectWebSocket(state, false)

    try {
      const micCtx = new (window.AudioContext || window.webkitAudioContext)()
      const source = micCtx.createMediaStreamSource(stream)
      const processor = micCtx.createScriptProcessor(4096, 1, 1)
      state.micCtx = micCtx
      state.source = source
      state.processor = processor

      // Reads state.ws (not a captured local variable) so that when
      // connectWebSocket swaps in a fresh WebSocket after a reconnect,
      // this keeps working without the mic/audio graph needing to be
      // torn down and rebuilt.
      processor.onaudioprocess = (e) => {
        if (state.paused) return
        const input = e.inputBuffer.getChannelData(0)
        const ratio = micCtx.sampleRate / 16000
        const outLength = Math.floor(input.length / ratio)
        const pcm16 = new Int16Array(outLength)
        for (let i = 0; i < outLength; i++) {
          const srcIndex = Math.floor(i * ratio)
          let s = Math.max(-1, Math.min(1, input[srcIndex]))
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(pcm16.buffer)
        } else {
          // Connection is down (or still connecting) -- keep the
          // audio instead of throwing it away; it gets sent the
          // moment the connection is back. This is the actual fix for
          // "lost what I said during a connectivity blip."
          bufferAudioChunk(state, pcm16.buffer)
        }
      }
      source.connect(processor)
      processor.connect(micCtx.destination)
    } catch (err) {
      setError('Connect error: ' + err.message)
      setStatus('idle')
      state.userInitiatedClose = true
      if (state.keepAliveTimer) clearInterval(state.keepAliveTimer)
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
      try {
        state.ws && state.ws.close()
      } catch (e) {
        /* ignore */
      }
      try {
        stream.getTracks().forEach((t) => t.stop())
      } catch (e) {
        /* ignore */
      }
      liveRef.current = null
    }
  }

  // Opens the WebSocket to the backend's Deepgram relay. isReconnect
  // is false only for the very first connection of a session (which
  // triggers the "please say a sentence" calibration); every
  // reconnect after a dropped connection skips calibration -- asking
  // the interviewer to go quiet on cue mid-interview isn't realistic,
  // so the existing youSpeakerLabel guess is carried forward instead.
  // Use Recalibrate if "you"/"interviewer" end up looking swapped
  // after a reconnect.
  function connectWebSocket(state, isReconnect) {
    let ws
    try {
      ws = new WebSocket(`${WS_BASE}/ws/live-copilot-stream`)
    } catch (err) {
      scheduleReconnect(state)
      return
    }
    state.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      state.reconnectAttempt = 0
      if (isReconnect) {
        flushPendingAudio(state)
        if (mountedRef.current) {
          setConnectionState('connected')
          setReconnectAttempt(0)
        }
      } else {
        setStatus('calibrating')
        state.calibrationTimer = setTimeout(finishCalibration, CALIBRATION_MS)
      }
    }
    ws.onmessage = (event) => handleDeepgramMessage(event.data)
    ws.onerror = () => {
      // A close event normally follows right away -- the actual retry
      // happens in onclose below, so a single blip doesn't trigger
      // two separate reconnect attempts.
    }
    // Previously this silently reset back to "Start Listening" with no
    // explanation whenever the connection dropped mid-session -- which
    // is exactly what made a brief connectivity blip look like the
    // whole feature "crashed". Now, unless THIS was a deliberate close
    // (End Session / leaving the page), it reconnects automatically
    // instead of giving up.
    ws.onclose = () => {
      if (state.userInitiatedClose) return
      if (liveRef.current !== state) return // this session has already ended/been replaced
      scheduleReconnect(state)
    }
  }

  function scheduleReconnect(state) {
    if (state.userInitiatedClose) return
    if (liveRef.current !== state) return
    state.reconnectAttempt += 1
    if (mountedRef.current) {
      setConnectionState('reconnecting')
      setReconnectAttempt(state.reconnectAttempt)
    }
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * state.reconnectAttempt, RECONNECT_MAX_DELAY_MS)
    state.reconnectTimer = setTimeout(() => {
      if (liveRef.current !== state) return
      connectWebSocket(state, true)
    }, delay)
  }

  function finishCalibration() {
    const state = liveRef.current
    if (!state) return
    const counts = state.calibrationCounts
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
    // Whichever speaker number said the most during the calibration
    // window (where only the candidate should have been talking) is
    // "you" for the rest of this session. Falls back to "0" if
    // nothing was heard (mic issue) -- not fatal, just means speaker
    // labeling may be off until it self-corrects.
    state.youSpeakerLabel = entries.length > 0 ? entries[0][0] : '0'
    // If a second voice was already picked up during calibration too
    // (e.g. the interviewer said something while you were talking),
    // Swap Speakers can use it immediately without waiting to hear
    // them again.
    state.otherSpeakerLabel = entries.length > 1 ? entries[1][0] : null
    state.calibrating = false
    if (mountedRef.current) setStatus('live')
  }

  // After an unexpected reconnect, the NEW Deepgram connection's
  // speaker numbering could differ from before -- there's no way to
  // detect that automatically mid-interview, so this lets you fix it
  // by hand if "you" and "interviewer" start looking swapped. Same
  // mechanism as the original calibration, just re-run on demand.
  function recalibrate() {
    const state = liveRef.current
    if (!state) return
    if (state.calibrationTimer) clearTimeout(state.calibrationTimer)
    state.calibrating = true
    state.calibrationCounts = {}
    state.currentBuffer = null
    setStatus('calibrating')
    state.calibrationTimer = setTimeout(finishCalibration, CALIBRATION_MS)
  }

  // A faster fix than Recalibrate for the common case (labels just
  // swapped, e.g. after a reconnect) -- instant, no new "say a
  // sentence" window, since it just flips to the other label that's
  // already been heard rather than listening for a fresh one.
  function swapSpeakers() {
    const state = liveRef.current
    if (!state) return
    if (state.otherSpeakerLabel == null) {
      if (mountedRef.current) {
        setError('Swap needs to have heard a second voice at least once first -- try again once the interviewer has spoken.')
      }
      return
    }
    flushCurrentBuffer() // so the in-progress line isn't split across the swap with the wrong label on each half
    const prevYou = state.youSpeakerLabel
    state.youSpeakerLabel = state.otherSpeakerLabel
    state.otherSpeakerLabel = prevYou
    if (mountedRef.current) setError(null)
  }

  function togglePause() {
    const state = liveRef.current
    if (!state) return
    state.paused = !state.paused
    setPaused(state.paused)

    if (state.paused) {
      // See KEEP_ALIVE_WHILE_PAUSED_MS above -- without this, pausing
      // for 10+ seconds gets the connection killed by Deepgram with no
      // warning, which is exactly what made this look like a random
      // crash.
      state.pauseKeepAliveTimer = setInterval(() => {
        try {
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'KeepAlive' }))
          }
        } catch (e) {
          /* ignore -- if this fails the connection has bigger problems, ws.onclose will handle it */
        }
      }, KEEP_ALIVE_WHILE_PAUSED_MS)
    } else if (state.pauseKeepAliveTimer) {
      clearInterval(state.pauseKeepAliveTimer)
      state.pauseKeepAliveTimer = null
    }
  }

  // Pure teardown. The processor's onaudioprocess handler is
  // explicitly cleared (set to null) BEFORE disconnecting it -- on
  // some Chrome versions, the deprecated ScriptProcessorNode API keeps
  // the underlying mic device (and the tab's "mic in use" indicator)
  // alive until its callback is dropped, not just disconnected. This
  // was reported live (28 Sep): the Chrome tab still showed the mic as
  // active after clicking End Session.
  function stopSession() {
    const state = liveRef.current
    if (!state) return
    state.userInitiatedClose = true
    if (state.calibrationTimer) clearTimeout(state.calibrationTimer)
    if (state.keepAliveTimer) clearInterval(state.keepAliveTimer)
    if (state.pauseKeepAliveTimer) clearInterval(state.pauseKeepAliveTimer)
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    flushCurrentBuffer()
    try {
      state.ws && state.ws.close()
    } catch (e) {
      /* ignore */
    }
    try {
      if (state.processor) {
        state.processor.onaudioprocess = null
        state.processor.disconnect()
      }
    } catch (e) {
      /* ignore */
    }
    try {
      state.source && state.source.disconnect()
    } catch (e) {
      /* ignore */
    }
    try {
      state.micCtx && state.micCtx.close()
    } catch (e) {
      /* ignore */
    }
    try {
      state.stream &&
        state.stream.getTracks().forEach((t) => {
          t.stop()
          state.stream.removeTrack(t)
        })
    } catch (e) {
      /* ignore */
    }
    liveRef.current = null
  }

  async function handleEndSession() {
    const sid = liveRef.current?.sessionId
    stopSession()
    setPaused(false)
    if (sid) {
      const { error: updateError } = await supabase
        .from('live_sessions')
        .update({ ended_at: new Date().toISOString() })
        .eq('id', sid)
      if (updateError) console.error('Failed to close session:', updateError.message)
    }
    setStatus('ended')
  }

  function handleStartAnother() {
    setStatus('idle')
    setError(null)
    setTurns([])
    setSuggestions([])
    setShowEarlierSuggestions(false)
    setPaused(false)
    setConnectionState('connected')
    setReconnectAttempt(0)
  }

  const orderedSuggestions = suggestions.slice().reverse()

  return (
    <section>
      <h1>Live Interview Copilot</h1>
      <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
        For use DURING a real interview, not a simulated one. Best setup: your laptop's built-in
        speakers (not headphones) so this mic can hear both you and the interviewer, or just have your
        phone's mic nearby if it's in person.
      </p>

      {status === 'idle' && (
        <>
          <label className="auth-form" style={{ maxWidth: 420 }}>
            Which Track? (optional, gives better suggestions)
            <select value={selectedTrackId} onChange={(e) => setSelectedTrackId(e.target.value)}>
              <option value="">No Track / generic</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.role_title || 'Untitled role'}
                  {t.company_name ? ` @ ${t.company_name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <p>
            <button type="button" onClick={startSession}>
              Start Listening
            </button>
          </p>
        </>
      )}

      {status === 'preparing' && <p>Getting ready…</p>}

      {status === 'calibrating' && (
        <p>
          🎙️ Please say a sentence now (e.g. introduce yourself) — this tells us which voice is yours,
          for about {Math.round(CALIBRATION_MS / 1000)} seconds…
        </p>
      )}

      {status === 'live' && (
        <p>
          {paused ? '⏸️ Paused' : '🎙️ Listening'} — quick suggestions appear below when the interviewer
          asks something.{' '}
          <button type="button" onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </button>{' '}
          <button type="button" onClick={swapSpeakers}>
            Swap Speakers
          </button>{' '}
          <button type="button" onClick={recalibrate}>
            Recalibrate
          </button>{' '}
          <button type="button" onClick={handleEndSession}>
            End Session
          </button>
        </p>
      )}

      {connectionState === 'reconnecting' && (
        <p className="form-error">
          ⚠️ Connection lost — retrying (attempt {reconnectAttempt})… your mic is still recording, nothing
          you say is being lost, it'll catch up once the connection is back.
        </p>
      )}

      {error && <p className="form-error">{error}</p>}

      {(status === 'live' || status === 'ended') && orderedSuggestions.length > 0 && (
        <div>
          <strong>Suggestions (newest first):</strong>
          {/* Always show the latest 2 in full (compact styling, see
              App.css) so both fit on screen together without scrolling
              -- older ones collapse to a one-line summary behind a
              toggle, since mid-interview you mainly need THIS and the
              PREVIOUS question, not the full history at once. */}
          {orderedSuggestions.map((s, i) => {
            const questionNumber = orderedSuggestions.length - i
            const isLatest = i === 0
            const isRecent = i < 2
            if (!isRecent && !showEarlierSuggestions) {
              return null
            }
            if (!isRecent) {
              return (
                <div key={s.id} className="suggestion-card suggestion-card-collapsed">
                  <div className="suggestion-label">Question {questionNumber}</div>
                  <p className="suggestion-question">{s.question}</p>
                </div>
              )
            }
            return (
              <div key={s.id} className={isLatest ? 'suggestion-card is-latest' : 'suggestion-card'}>
                <div className="suggestion-label">
                  {isLatest ? 'LATEST — ' : ''}Question {questionNumber}
                  {s.streaming ? ' · typing…' : ''}
                </div>
                <p className="suggestion-question">{s.question}</p>
                {s.quickPointers.length > 0 && (
                  <ul>
                    {s.quickPointers.map((p, pi) => (
                      <li key={pi}>{p}</li>
                    ))}
                  </ul>
                )}
                {s.suggestedAnswer && <p className="suggestion-answer">{s.suggestedAnswer}</p>}
              </div>
            )
          })}
          {orderedSuggestions.length > 2 && (
            <button type="button" className="link-button" onClick={() => setShowEarlierSuggestions((v) => !v)}>
              {showEarlierSuggestions ? 'Hide earlier questions' : `Show ${orderedSuggestions.length - 2} earlier question${orderedSuggestions.length - 2 === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}

      {(status === 'live' || status === 'ended') && (turns.length > 0 || liveLine) && (
        <div className="transcript">
          <strong>Transcript:</strong>
          {turns.map((turn, i) => (
            <p key={i}>
              <strong>{turn.speaker === 'you' ? 'You' : 'Interviewer'}:</strong> {turn.text}
            </p>
          ))}
          {liveLine && (
            <p style={{ opacity: liveLine.interim ? 0.55 : 0.8, fontStyle: liveLine.interim ? 'italic' : 'normal' }}>
              <strong>{liveLine.speaker === 'you' ? 'You' : 'Interviewer'}:</strong> {liveLine.text}
            </p>
          )}
          {turns.length > 0 && status === 'live' && (
            <p style={{ marginTop: '0.3rem' }}>
              <button type="button" className="link-button" onClick={fixLastTurnSpeaker}>
                Wrong speaker on the last line? Fix it
              </button>
            </p>
          )}
        </div>
      )}

      {status === 'ended' && (
        <p>
          <button type="button" onClick={handleStartAnother}>
            Start another session
          </button>
        </p>
      )}
    </section>
  )
}

export default LiveCopilot
