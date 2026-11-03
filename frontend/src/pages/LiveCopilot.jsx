import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  embedQuery,
  matchQaEntriesSemantic,
  matchTrackKnowledgeSemantic,
  parseStreamedSuggestion,
} from '../lib/contextMatching.js'
import {
  candidateTurnClosesQuestion,
  friendlySuggestionError,
  isRateLimitError,
  isWorthASuggestion,
  parseRetryAfterSeconds,
  shouldMergeIntoOpenQuestion,
  splitSuggestionError,
} from '../lib/turnMerging.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL
// The backend URL is https://... (Render); a WebSocket to the same
// host just needs wss:// instead -- everything else about the address
// is identical.
const WS_BASE = API_BASE ? API_BASE.replace(/^http/, 'ws') : ''

const CALIBRATION_MS = 6000

// Backstop for UtteranceEnd not firing (see utteranceFlushTimer's
// comment in startSession) -- kept above the backend's own
// utterance_end_ms (1500ms, in providers.py) so Deepgram's real
// UtteranceEnd message wins the race when it does show up. Reset on
// EVERY transcript message (interim too, not just final), so it can
// only fire after real silence -- never in the middle of a long,
// pause-free sentence that Deepgram hasn't finalized yet.
const UTTERANCE_FALLBACK_MS = 3500

// How much retrieved material to send per live question -- small on
// purpose to fit Groq's free-tier 8,000 tokens/minute (see
// LIVE_CONTEXT_CAPS in providers.py).
const LIVE_KNOWLEDGE_MATCHES = 4
const LIVE_QA_MATCHES = 2

// If Groq says "rate limited, try again in N s" and N is at most this,
// the card waits and retries once by itself.
const RATE_LIMIT_AUTO_RETRY_MAX_S = 40

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
// cosineSimilarity / matchQaEntriesSemantic / matchTrackKnowledgeSemantic /
// parseStreamedSuggestion moved to ../lib/contextMatching.js (2 Nov) so the
// Chatbot test widget (ChatbotWidget.jsx) can reuse the exact same
// retrieval code Live Copilot uses, instead of a second copy of it.

// How many of this session's own prior exchanges to send to the backend
// as real chat turns, same idea and same limit as ChatbotWidget.jsx's
// CONVERSATION_HISTORY_LIMIT -- enough for a natural follow-up ("and the
// second one?") without letting the prompt grow unbounded over a long
// interview. Added so Live Copilot has conversation memory too (it did
// not before), with NO extra network round-trip: conversation_history is
// just additional JSON in the same POST already sent to /api/live-suggestion.
const CONVERSATION_HISTORY_LIMIT = 6

// Turns the suggestions already collected this session into the
// {role, content} shape the backend expects, oldest first, capped to
// the last N. Only completed (non-streaming) suggestions are included
// -- a still-streaming one would send a half-finished answer as if it
// were final, and the one currently being requested isn't in this list
// yet anyway (it's added to `suggestions` after this read happens).
function buildConversationHistory(priorSuggestions) {
  const history = []
  for (const s of priorSuggestions) {
    if (s.streaming) continue
    if (s.question) history.push({ role: 'user', content: s.question })
    if (s.suggestedAnswer) history.push({ role: 'assistant', content: s.suggestedAnswer })
  }
  return history.slice(-CONVERSATION_HISTORY_LIMIT)
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
  const liveRef = useRef(null)
  const mountedRef = useRef(true)
  const suggestionIdRef = useRef(0)
  const turnIdRef = useRef(0)
  // Always-current mirror of `suggestions`, read by requestSuggestion
  // when building conversation_history below -- requestSuggestion can
  // be invoked from a websocket callback bound on an earlier render,
  // so reading the `suggestions` state variable directly there could
  // see a stale list; the ref is kept in sync on every render instead.
  const suggestionsRef = useRef([])
  // The interviewer's current, still-"open" question: further
  // interviewer speech merges into it until the candidate replies (see
  // appendCompletedTurn). { localTurnId, dbTurnId, text,
  // lastSegmentAt, suggestionId, controller } | null.
  const openQuestionRef = useRef(null)
  // Latest Track/Q&A/profile data for runSuggestion (see the comment
  // there on why it can't just read state). Updated every render.
  const latestContextRef = useRef({ qaEntries: [], trackKnowledgeChunks: [], selectedTrack: null, profile: null })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    suggestionsRef.current = suggestions
  }, [suggestions])

  useEffect(() => {
    latestContextRef.current = {
      qaEntries,
      trackKnowledgeChunks,
      selectedTrack: tracks.find((t) => t.id === selectedTrackId) || null,
      profile,
    }
  }, [qaEntries, trackKnowledgeChunks, tracks, selectedTrackId, profile])


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

  // Was previously placed AFTER the early returns below -- a real
  // Rules-of-Hooks violation (a Hook must run in the same order on
  // every render): on a render where `session` or API_BASE is
  // missing, this Hook simply wasn't called at all, which can make
  // React's internal Hook bookkeeping mismatch between renders and
  // crash with "Rendered fewer hooks than expected". Caught by
  // oxlint's react-hooks/rules-of-hooks check during the 2 Nov
  // hygiene pass; moved above the early returns to fix it.
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

  // Saves one completed turn to Supabase (fire-and-forget from the
  // caller's point of view). Resolves to the new row's id, or null.
  async function saveTurn(speaker, text, localTurnId) {
    const sid = liveRef.current?.sessionId
    if (!sid) return null
    const { data, error: insertError } = await supabase
      .from('live_turns')
      .insert({ session_id: sid, speaker, text })
      .select('id')
      .single()
    if (insertError) {
      console.error('Failed to save turn:', insertError.message)
      return null
    }
    if (mountedRef.current) {
      setTurns((prev) => prev.map((t) => (t.localTurnId === localTurnId ? { ...t, dbTurnId: data.id } : t)))
    }
    return data.id
  }

  function updateSavedTurnText(dbTurnId, text) {
    if (!dbTurnId) return
    supabase
      .from('live_turns')
      .update({ text })
      .eq('id', dbTurnId)
      .then(({ error: updateError }) => {
        if (updateError) console.error('Failed to update merged turn:', updateError.message)
      })
  }

  // A completed utterance (already coalesced by speaker in
  // handleDeepgramMessage below) is added to the transcript and saved.
  //
  // HOW INTERVIEWER QUESTIONS ARE GROUPED (2 Nov hygiene pass, replacing
  // the earlier 1.5s "grace window", which couldn't work: it started
  // when the FIRST part of a question ended, but the second part only
  // arrives once it is fully spoken, usually well after 1.5s, so the
  // two never merged):
  //   - Deepgram's utterance_end_ms (1.5s of silence, backend) decides
  //     when a segment has ended.
  //   - The interviewer's segments keep merging into ONE "open
  //     question" until the candidate actually replies (more than a
  //     short "okay"; see turnMerging.js). Each time more is added,
  //     the suggestion already requested for the shorter version is
  //     cancelled and a new one is requested for the full text --
  //     exactly "stop processing the first one and process both
  //     together".
  async function appendCompletedTurn(speaker, text) {
    const now = Date.now()

    if (speaker === 'interviewer') {
      const open = openQuestionRef.current
      if (shouldMergeIntoOpenQuestion(open, now)) {
        open.text = `${open.text} ${text}`.trim()
        open.lastSegmentAt = now
        setTurns((prev) => prev.map((t) => (t.localTurnId === open.localTurnId ? { ...t, text: open.text } : t)))
        updateSavedTurnText(open.dbTurnId, open.text)
        cancelSuggestionFor(open)
        startSuggestionFor(open)
        return
      }

      const localTurnId = ++turnIdRef.current
      const question = { localTurnId, dbTurnId: null, text, lastSegmentAt: now, suggestionId: null, controller: null }
      openQuestionRef.current = question
      setTurns((prev) => [...prev, { speaker, text, localTurnId, dbTurnId: null }])
      // Ask for the suggestion straight away -- don't wait for the
      // database insert first (that used to add a round-trip of delay).
      startSuggestionFor(question)
      const dbTurnId = await saveTurn(speaker, text, localTurnId)
      question.dbTurnId = dbTurnId
      // More may have been merged in while the insert was in flight.
      if (dbTurnId && question.text !== text) updateSavedTurnText(dbTurnId, question.text)
      return
    }

    // The candidate spoke. A real reply closes the interviewer's open
    // question; a short "okay"/"yes" (or a single mis-tagged word)
    // doesn't, so the interviewer's next words still merge into it.
    if (candidateTurnClosesQuestion(text)) {
      openQuestionRef.current = null
    }
    const localTurnId = ++turnIdRef.current
    setTurns((prev) => [...prev, { speaker, text, localTurnId, dbTurnId: null }])
    saveTurn(speaker, text, localTurnId)
  }

  // Requests a suggestion for an open question's CURRENT text, unless
  // it's too short to be a real question (e.g. "okay" -- see
  // MIN_QUESTION_WORDS). Remembers the request so a later merge can
  // cancel it.
  function startSuggestionFor(question) {
    if (!isWorthASuggestion(question.text)) return
    const controller = new AbortController()
    question.controller = controller
    question.suggestionId = requestSuggestion(question.text, question, question.localTurnId, controller.signal)
  }

  // Cancels the in-flight request (if any) and removes its card.
  function cancelSuggestionFor(question) {
    if (question.controller) question.controller.abort()
    const oldId = question.suggestionId
    if (oldId != null && mountedRef.current) {
      setSuggestions((prev) => prev.filter((s) => s.id !== oldId))
    }
    question.controller = null
    question.suggestionId = null
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
  // a suggestion is requested for it now.
  // NOTE: side effects (the supabase update, possibly requestSuggestion)
  // deliberately happen OUTSIDE the setTurns updater below -- a setState
  // updater function should stay pure, since React can invoke it more
  // than once (e.g. under StrictMode in dev) to check for exactly this.
  function fixLastTurnSpeaker() {
    if (turns.length === 0) return
    const last = turns[turns.length - 1]
    const flipped = last.speaker === 'you' ? 'interviewer' : 'you'
    setTurns((prev) => [...prev.slice(0, -1), { ...last, speaker: flipped }])

    const open = openQuestionRef.current
    if (last.speaker === 'interviewer' && flipped === 'you') {
      if (open && open.localTurnId === last.localTurnId) {
        cancelSuggestionFor(open)
        openQuestionRef.current = null
      }
      setSuggestions((prev) => prev.filter((s) => s.localTurnId !== last.localTurnId))
    }
    if (last.speaker === 'you' && flipped === 'interviewer') {
      // It really was the interviewer: make it the open question (so
      // anything more they say merges into it) and ask now.
      const question = {
        localTurnId: last.localTurnId,
        dbTurnId: last.dbTurnId,
        text: last.text,
        lastSegmentAt: Date.now(),
        suggestionId: null,
        controller: null,
      }
      openQuestionRef.current = question
      startSuggestionFor(question)
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

  // "Retry" on a failed card: drop it and ask again for that turn.
  function retrySuggestion(s) {
    const turn = turns.find((t) => t.localTurnId === s.localTurnId)
    if (!turn) return
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id))
    const open = openQuestionRef.current
    if (open && open.localTurnId === turn.localTurnId) {
      cancelSuggestionFor(open)
      startSuggestionFor(open)
    } else {
      requestSuggestion(turn.text, { dbTurnId: turn.dbTurnId }, turn.localTurnId, undefined)
    }
  }

  // Creates the suggestion card right away (showing "thinking…") and
  // fills it in once the reply is COMPLETE -- per Devanshu's request
  // (2 Nov) the text is no longer shown growing live; the full quick
  // points + answer appear at once. Returns the card's id
  // synchronously so a merge can cancel it.
  //   turnRef: an object whose .dbTurnId is read at save time (it may
  //            only become known after the request started).
  //   signal:  AbortSignal -- aborted when this question gets merged
  //            with more of the interviewer's speech.
  function requestSuggestion(question, turnRef, localTurnId, signal, attempt = 1) {
    const id = ++suggestionIdRef.current
    const placeholder = {
      id,
      question,
      quickPointers: [],
      suggestedAnswer: '',
      streaming: true,
      error: null,
      retryInSeconds: null,
      localTurnId,
    }
    if (mountedRef.current) setSuggestions((prev) => [...prev, placeholder])
    runSuggestion(id, question, turnRef, signal, attempt)
    return id
  }

  async function runSuggestion(id, question, turnRef, signal, attempt) {
    const updateCard = (patch) => {
      if (mountedRef.current) setSuggestions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
    }
    // Read the latest Track/Q&A/profile data from a ref, not from this
    // render's variables: this function is reached from the websocket
    // handler bound when the session STARTED, so plain state here could
    // be stale (e.g. knowledge-base chunks that finished loading just
    // after you pressed Start would otherwise never be used).
    const ctx = latestContextRef.current

    let fullText = ''
    let failure = null
    try {
      // Embed the question ONCE and reuse it for both lookups (used to
      // be two identical embedding requests). Lookups run in parallel,
      // and Live Copilot skips the extra LLM rerank for speed.
      const queryEmbedding = await embedQuery(API_BASE, question)
      const [matchedQa, matchedKnowledge] = await Promise.all([
        matchQaEntriesSemantic(API_BASE, question, ctx.qaEntries, { queryEmbedding }),
        matchTrackKnowledgeSemantic(API_BASE, question, ctx.trackKnowledgeChunks, { rerank: false, queryEmbedding }),
      ])
      // Fewer, better chunks: the whole prompt has to fit Groq's
      // 8,000-tokens-per-minute free tier (see LIVE_CONTEXT_CAPS in
      // providers.py), so send the top few rather than everything.
      const qaContext = matchedQa
        .slice(0, LIVE_QA_MATCHES)
        .map((e) => `Q: ${e.question}\nA: ${e.answer}`)
        .join('\n\n')
      const knowledgeContext = matchedKnowledge
        .slice(0, LIVE_KNOWLEDGE_MATCHES)
        .map((c) => c.chunk_text)
        .join('\n\n')
      // Read from the ref, not the `suggestions` state variable --
      // see suggestionsRef's comment above. No extra round-trip: this
      // just adds a field to the POST body already being sent below.
      const conversationHistory = buildConversationHistory(suggestionsRef.current)
      if (signal?.aborted) return
      const res = await fetch(`${API_BASE}/api/live-suggestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          question,
          company_name: ctx.selectedTrack?.company_name || '',
          role_title: ctx.selectedTrack?.role_title || '',
          jd_text: liveRef.current?.jdText || '',
          resume_text: liveRef.current?.resumeText || '',
          qa_context: qaContext,
          profile_summary: ctx.profile?.summary || '',
          track_notes: ctx.selectedTrack?.notes || '',
          knowledge_context: knowledgeContext,
          conversation_history: conversationHistory,
        }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // Accumulate only -- the card is filled in once, below.
        fullText += decoder.decode(value, { stream: true })
      }
    } catch (err) {
      // A merge cancelled this request on purpose: its card is already
      // gone and a new request has replaced it -- nothing to show.
      if (signal?.aborted || err?.name === 'AbortError') return
      failure = err?.message || 'Network error'
    }
    if (signal?.aborted) return

    const { text, error: backendError } = splitSuggestionError(fullText)
    const final = parseStreamedSuggestion(text)
    const gotSomething = final.quickPointers.length > 0 || final.suggestedAnswer
    const errorText = backendError || failure || (gotSomething ? null : 'No suggestion came back.')

    if (errorText && !gotSomething) {
      // Rate-limited: wait out Groq's "try again in Ns" and retry once
      // automatically, instead of leaving an empty card mid-interview.
      const waitS = parseRetryAfterSeconds(errorText)
      if (isRateLimitError(errorText) && attempt === 1 && waitS != null && waitS <= RATE_LIMIT_AUTO_RETRY_MAX_S) {
        updateCard({ error: friendlySuggestionError(errorText), retryInSeconds: waitS })
        setTimeout(() => {
          if (signal?.aborted || !mountedRef.current) return
          updateCard({ error: null, retryInSeconds: null })
          runSuggestion(id, question, turnRef, signal, attempt + 1)
        }, waitS * 1000)
        return
      }
      console.error('Suggestion error:', errorText)
      updateCard({ streaming: false, error: friendlySuggestionError(errorText), retryInSeconds: null })
      return
    }

    updateCard({ ...final, streaming: false, error: null, retryInSeconds: null })

    const sid = liveRef.current?.sessionId
    if (sid) {
      const { error: insertError } = await supabase.from('live_suggestions').insert({
        session_id: sid,
        turn_id: turnRef?.dbTurnId ?? null,
        // Saved as plain strings ("point — explanation"), the same
        // shape this column has always held, whatever its SQL type.
        quick_pointers: final.quickPointers.map((p) => (p.explanation ? `${p.point} — ${p.explanation}` : p.point)),
        suggested_answer: final.suggestedAnswer,
      })
      if (insertError) console.error('Failed to save suggestion:', insertError.message)
    }
  }

  function flushCurrentBuffer() {
    const state = liveRef.current
    if (!state) return
    if (state.utteranceFlushTimer) {
      clearTimeout(state.utteranceFlushTimer)
      state.utteranceFlushTimer = null
    }
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
      // Someone is still talking -- push the safety-net flush back so
      // it can't cut a long, pause-free sentence in half just because
      // Deepgram hasn't sent a "final" for it yet (a likely cause of
      // mid-sentence splits like "could you tell me about | time you
      // had to...").
      if (state.currentBuffer) {
        if (state.utteranceFlushTimer) clearTimeout(state.utteranceFlushTimer)
        state.utteranceFlushTimer = setTimeout(() => flushCurrentBuffer(), UTTERANCE_FALLBACK_MS)
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
    // Reset the safety-net flush timer (see utteranceFlushTimer's
    // comment above) every time a new final chunk extends this turn,
    // so it only fires after a real gap with nothing further arriving.
    if (state.utteranceFlushTimer) clearTimeout(state.utteranceFlushTimer)
    state.utteranceFlushTimer = setTimeout(() => flushCurrentBuffer(), UTTERANCE_FALLBACK_MS)
  }

  async function startSession() {
    setError(null)
    setTurns([])
    setSuggestions([])
    setPaused(false)
    setConnectionState('connected')
    setReconnectAttempt(0)
    setStatus('preparing')
    openQuestionRef.current = null

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
      // Safety-net timer: normally a turn flushes when Deepgram's
      // own UtteranceEnd message arrives (after utterance_end_ms of
      // silence -- see providers.py), but UtteranceEnd isn't
      // guaranteed to fire for every pause (Deepgram's own docs note
      // cases where it's delayed or skipped). Without this, a turn
      // that UtteranceEnd never flushes just sits in currentBuffer
      // forever -- no suggestion is ever requested for it -- until
      // something else flushes it (e.g. the OTHER speaker starting
      // to talk, which is what made it look like a question only
      // got answered after asking the interviewer to repeat it).
      // This timer guarantees a flush within UTTERANCE_FALLBACK_MS of
      // the last final chunk even if UtteranceEnd never shows up.
      utteranceFlushTimer: null,
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
    if (state.utteranceFlushTimer) {
      clearTimeout(state.utteranceFlushTimer)
      state.utteranceFlushTimer = null
    }
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
    openQuestionRef.current = null
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
    setConnectionState('connected')
    setReconnectAttempt(0)
    if (openQuestionRef.current) cancelSuggestionFor(openQuestionRef.current)
    openQuestionRef.current = null
  }

  // LAYOUT (3 Nov, "single page, no inner scroll box, nothing
  // distracting"): during a session the screen shows ONLY the
  // interviewer's questions and their answers, NEWEST FIRST, right
  // under the controls -- so the current answer is always in the same
  // place at the top and nothing ever needs scrolling. The candidate's
  // own speech is never shown live; the full two-sided transcript
  // (with the speaker fix) sits collapsed at the bottom for afterwards.
  const answeredQuestions = turns
    .filter((t) => t.speaker === 'interviewer')
    .map((turn) => ({ turn, suggestion: suggestions.find((s) => s.localTurnId === turn.localTurnId) }))
    .filter((q) => q.suggestion)
    .reverse()
  const interviewerSpeakingNow = liveLine && liveLine.speaker === 'interviewer' ? liveLine.text : ''
  const sessionActive = status === 'live' || status === 'ended'

  return (
    <section>
      {!sessionActive && (
        <>
          <h1>Live Interview Copilot</h1>
          <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
            For use DURING a real interview, not a simulated one. Best setup: your laptop's built-in
            speakers (not headphones) so this mic can hear both you and the interviewer, or just have
            your phone's mic nearby if it's in person.
          </p>
        </>
      )}

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
        <p className="copilot-controls">
          <span>{paused ? '⏸️ Paused' : '🎙️ Listening'}</span>
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

      {sessionActive && (
        <div className="copilot-answers">
          {/* One fixed-height line, so the answer below never jumps
              while the interviewer is mid-sentence. */}
          {status === 'live' && (
            <p className="copilot-hearing">
              {interviewerSpeakingNow ? `Interviewer: …${interviewerSpeakingNow.slice(-140)}` : '\u00a0'}
            </p>
          )}
          {answeredQuestions.length === 0 && status === 'live' && (
            <p className="copilot-empty">Answers will appear here when the interviewer asks something.</p>
          )}
          {answeredQuestions.map(({ turn, suggestion: s }, i) => (
            <div
              key={s.id}
              className={['suggestion-card', i === 0 ? 'is-latest' : 'is-earlier'].join(' ')}
            >
              <p className="suggestion-question">{turn.text}</p>
              {s.streaming && !s.retryInSeconds && <div className="suggestion-label">thinking…</div>}
              {s.retryInSeconds != null && (
                <p className="suggestion-error">
                  {s.error} Retrying automatically in ~{s.retryInSeconds}s…
                </p>
              )}
              {!s.streaming && s.error && (
                <p className="suggestion-error">
                  Couldn't get a suggestion: {s.error}{' '}
                  <button type="button" className="link-button" onClick={() => retrySuggestion(s)}>
                    Retry
                  </button>
                </p>
              )}
              {s.quickPointers.length > 0 && (
                <table className="suggestion-points-table">
                  <tbody>
                    {s.quickPointers.map((p, pi) => (
                      <tr key={pi}>
                        <td className="suggestion-point-cell">{p.point}</td>
                        <td className="suggestion-explanation-cell">{p.explanation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {s.suggestedAnswer && <p className="suggestion-answer">{s.suggestedAnswer}</p>}
            </div>
          ))}

          {turns.length > 0 && (
            <details className="copilot-transcript">
              <summary>Full transcript ({turns.length} lines)</summary>
              {turns.map((t) => (
                <p key={t.localTurnId} className={`feed-turn feed-turn-${t.speaker}`}>
                  <strong>{t.speaker === 'you' ? 'You' : 'Interviewer'}:</strong> {t.text}
                </p>
              ))}
              {status === 'live' && (
                <button type="button" className="link-button" onClick={fixLastTurnSpeaker}>
                  Wrong speaker on the last line? Fix it
                </button>
              )}
            </details>
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
