import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

const API_BASE = import.meta.env.VITE_API_BASE_URL
// The backend URL is https://... (Render); a WebSocket to the same
// host just needs wss:// instead -- everything else about the address
// is identical.
const WS_BASE = API_BASE ? API_BASE.replace(/^http/, 'ws') : ''

const CALIBRATION_MS = 6000
const QUICK_POINTS_MARKER = 'QUICK POINTS:'
const SUGGESTED_ANSWER_MARKER = 'SUGGESTED ANSWER:'

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

/**
 * Live Interview Copilot: listens during a REAL interview (not
 * simulated) through one mic, tells your voice apart from the
 * interviewer's (Deepgram diarization + a short one-time calibration
 * step), and shows quick suggested replies the moment the interviewer
 * finishes asking something -- silently, text-only, never speaking
 * back. Suggestions stream in live (typed-out, not a sudden
 * paragraph); the newest suggestion is pinned at the top, visually
 * separate from earlier ones, so it's easy to glance at mid-call.
 */
function LiveCopilot() {
  const { session } = useAuth()

  const [tracks, setTracks] = useState([])
  const [selectedTrackId, setSelectedTrackId] = useState('')
  // idle | preparing | calibrating | live | ended
  const [status, setStatus] = useState('idle')
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState(null)
  const [turns, setTurns] = useState([])
  const [suggestions, setSuggestions] = useState([]) // {id, question, quickPointers, suggestedAnswer, streaming}

  const liveRef = useRef(null)
  const mountedRef = useRef(true)
  const suggestionIdRef = useRef(0)

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
      .select('id, company_name, role_title, resume_path, jd_text, jd_path')
      .order('created_at', { ascending: false })
      .then(({ data, error: fetchError }) => {
        if (!fetchError) setTracks(data || [])
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
    setTurns((prev) => [...prev, { speaker, text }])
    const sid = liveRef.current?.sessionId
    let turnId = null
    if (sid) {
      const { data, error: insertError } = await supabase
        .from('live_turns')
        .insert({ session_id: sid, speaker, text })
        .select('id')
        .single()
      if (insertError) console.error('Failed to save turn:', insertError.message)
      else turnId = data.id
    }
    if (speaker === 'interviewer') {
      requestSuggestion(text, turnId)
    }
  }

  // Reads the streamed response chunk by chunk, updating this one
  // suggestion entry's text as it grows -- this is what makes it
  // appear "typed" live instead of arriving as one sudden paragraph.
  async function requestSuggestion(question, turnId) {
    const id = ++suggestionIdRef.current
    const placeholder = { id, question, quickPointers: [], suggestedAnswer: '', streaming: true }
    if (mountedRef.current) setSuggestions((prev) => [...prev, placeholder])

    let fullText = ''
    try {
      const res = await fetch(`${API_BASE}/api/live-suggestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          company_name: selectedTrack?.company_name || '',
          role_title: selectedTrack?.role_title || '',
          jd_text: liveRef.current?.jdText || '',
          resume_text: liveRef.current?.resumeText || '',
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

    if (parsed.type === 'UtteranceEnd') {
      flushCurrentBuffer()
      return
    }
    if (parsed.type !== 'Results' || !parsed.is_final) return

    const alt = parsed.channel?.alternatives?.[0]
    const words = alt?.words || []
    if (words.length === 0 || !alt.transcript) return

    // Deepgram tags each WORD with a speaker number; take whichever
    // speaker said most of this chunk as this chunk's speaker.
    const counts = {}
    for (const w of words) counts[w.speaker] = (counts[w.speaker] || 0) + 1
    const speakerLabel = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]

    if (state.calibrating) {
      state.calibrationCounts[speakerLabel] = (state.calibrationCounts[speakerLabel] || 0) + words.length
      return
    }

    const speakerTag = speakerLabel === state.youSpeakerLabel ? 'you' : 'interviewer'

    if (state.currentBuffer && state.currentBuffer.speaker === speakerTag) {
      state.currentBuffer.text += ' ' + alt.transcript
    } else {
      flushCurrentBuffer()
      state.currentBuffer = { speaker: speakerTag, text: alt.transcript }
    }
  }

  async function startSession() {
    setError(null)
    setTurns([])
    setSuggestions([])
    setPaused(false)
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
      calibrating: true,
      calibrationCounts: {},
      currentBuffer: null,
      paused: false,
    }
    liveRef.current = state

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

    try {
      const ws = new WebSocket(`${WS_BASE}/ws/live-copilot-stream`)
      state.ws = ws
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        setStatus('calibrating')
        state.calibrationTimer = setTimeout(finishCalibration, CALIBRATION_MS)
      }
      ws.onmessage = (event) => handleDeepgramMessage(event.data)
      ws.onerror = () => {
        setError('Connection to the live-listening service failed.')
      }
      ws.onclose = () => {
        setStatus((s) => (s === 'idle' || s === 'ended' ? s : 'idle'))
      }

      const micCtx = new (window.AudioContext || window.webkitAudioContext)()
      const source = micCtx.createMediaStreamSource(stream)
      const processor = micCtx.createScriptProcessor(4096, 1, 1)
      state.micCtx = micCtx
      state.source = source
      state.processor = processor

      processor.onaudioprocess = (e) => {
        if (state.paused) return
        if (ws.readyState !== WebSocket.OPEN) return
        const input = e.inputBuffer.getChannelData(0)
        const ratio = micCtx.sampleRate / 16000
        const outLength = Math.floor(input.length / ratio)
        const pcm16 = new Int16Array(outLength)
        for (let i = 0; i < outLength; i++) {
          const srcIndex = Math.floor(i * ratio)
          let s = Math.max(-1, Math.min(1, input[srcIndex]))
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        ws.send(pcm16.buffer)
      }
      source.connect(processor)
      processor.connect(micCtx.destination)
    } catch (err) {
      setError('Connect error: ' + err.message)
      setStatus('idle')
      try {
        stream.getTracks().forEach((t) => t.stop())
      } catch (e) {
        /* ignore */
      }
      liveRef.current = null
    }
  }

  function finishCalibration() {
    const state = liveRef.current
    if (!state) return
    const counts = state.calibrationCounts
    const entries = Object.entries(counts)
    // Whichever speaker number said the most during the calibration
    // window (where only the candidate should have been talking) is
    // "you" for the rest of this session. Falls back to "0" if
    // nothing was heard (mic issue) -- not fatal, just means speaker
    // labeling may be off until it self-corrects.
    state.youSpeakerLabel = entries.length > 0 ? entries.sort((a, b) => b[1] - a[1])[0][0] : '0'
    state.calibrating = false
    if (mountedRef.current) setStatus('live')
  }

  function togglePause() {
    const state = liveRef.current
    if (!state) return
    state.paused = !state.paused
    setPaused(state.paused)
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
    if (state.calibrationTimer) clearTimeout(state.calibrationTimer)
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
    setPaused(false)
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
          <button type="button" onClick={handleEndSession}>
            End Session
          </button>
        </p>
      )}

      {error && <p className="form-error">{error}</p>}

      {(status === 'live' || status === 'ended') && orderedSuggestions.length > 0 && (
        <div>
          <strong>Suggestions (newest first):</strong>
          {orderedSuggestions.map((s, i) => {
            const questionNumber = orderedSuggestions.length - i
            const isLatest = i === 0
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
        </div>
      )}

      {(status === 'live' || status === 'ended') && turns.length > 0 && (
        <div className="transcript">
          <strong>Transcript:</strong>
          {turns.map((turn, i) => (
            <p key={i}>
              <strong>{turn.speaker === 'you' ? 'You' : 'Interviewer'}:</strong> {turn.text}
            </p>
          ))}
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
