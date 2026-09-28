import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

// The backend (Render) lives at a different domain from this frontend
// (Cloudflare Pages), so unlike /status (served BY the backend, same
// origin) this needs the full URL and the backend needs CORS enabled
// for this domain (see main.py).
const API_BASE = import.meta.env.VITE_API_BASE_URL

// ---- Shared with /status's Gemini Live implementation (main.py) ----
function downsampleTo16kPCM16(float32Samples, inputSampleRate) {
  const ratio = inputSampleRate / 16000
  const outLength = Math.floor(float32Samples.length / ratio)
  const pcm16 = new Int16Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIndex = Math.floor(i * ratio)
    let s = Math.max(-1, Math.min(1, float32Samples[srcIndex]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm16
}

function pcm16ToBase64(int16Array) {
  const bytes = new Uint8Array(int16Array.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToInt16Array(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer)
}

function buildSystemInstruction({ headline, summary, companyName, roleTitle, resumeText, jdText }) {
  const lines = [
    "You are conducting a realistic mock job interview. Speak naturally, ask one " +
      "question at a time, and wait for the candidate's full spoken answer before " +
      'responding or moving on. Ask a mix of behavioral and role-specific technical ' +
      'questions, follow up naturally on what they say, and be professional and ' +
      'encouraging. Do not mention that you are scoring or evaluating the answers.',
  ]
  if (companyName || roleTitle) {
    lines.push(
      `The candidate is preparing for a ${roleTitle || 'role'} position` +
        (companyName ? ` at ${companyName}` : '') +
        '.',
    )
  }
  if (headline) lines.push(`Candidate headline: ${headline}`)
  if (summary) lines.push(`Candidate summary: ${summary}`)
  if (jdText) lines.push(`Job description for this role:\n${jdText}`)
  if (resumeText) lines.push(`Candidate resume:\n${resumeText}`)
  lines.push('Start by briefly greeting the candidate, then ask your first question.')
  return lines.join('\n\n')
}

/**
 * Mock Interview screen. Stage A (live voice conversation) plus Stage
 * B (scoring): while you talk, each finished answer quietly gets a
 * score + a couple of quick pointers from Groq (a different provider
 * from Gemini, which is busy running the live voice side, so scoring
 * never competes with it for rate limits) shown in a side panel. When
 * you end the interview, everything gets rolled up into one
 * end-of-session report with an overall score and summary.
 */
function MockInterview() {
  const { session, profile } = useAuth()

  const [tracks, setTracks] = useState([])
  const [selectedTrackId, setSelectedTrackId] = useState('')
  // idle | preparing | live | ending | ended
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)
  // Chronological {speaker: 'you' | 'gemini', text} turns -- appended
  // to the last entry while the same speaker keeps talking, so this
  // array always strictly alternates speakers. That alternation is
  // also what makes answer-segmentation below possible: turn N-3 is
  // the question, N-2 is the answer, once turn N-1 (a NEW gemini turn)
  // shows the candidate has finished answering.
  const [turns, setTurns] = useState([])
  const [answerScores, setAnswerScores] = useState([]) // {question, answer, score, quickPointers, detailedFeedback}
  const [sessionReport, setSessionReport] = useState(null) // {overallScore, overallSummary}

  const liveRef = useRef(null)
  const turnsRef = useRef([])
  const answerScoresRef = useRef([])
  const scoredThroughRef = useRef(-1) // index (in turns) of the last 'you' turn already scored
  const mountedRef = useRef(true)

  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

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

  // Make sure the mic/session actually get torn down if the person
  // navigates away mid-interview, not just when they click End. This
  // does NOT run the scoring/report flow -- that's only for a
  // deliberate "End Interview" click.
  useEffect(() => {
    return () => stopInterview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId)

  // Whenever a fresh gemini turn appears right after a 'you' turn,
  // that 'you' turn is a finished answer -- score it. Runs on every
  // turns update but only fires once per answer (scoredThroughRef).
  useEffect(() => {
    const n = turns.length
    if (n < 3) return
    if (turns[n - 1].speaker !== 'gemini') return
    const answerIdx = n - 2
    if (turns[answerIdx].speaker !== 'you') return
    if (answerIdx <= scoredThroughRef.current) return
    scoredThroughRef.current = answerIdx
    const question = turns[n - 3]?.text || ''
    const answer = turns[answerIdx].text
    scoreAnswer(question, answer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns])

  if (!session) return <p>Log in to start a mock interview.</p>
  if (!API_BASE) {
    return <p className="form-error">Mock Interview isn't configured yet (missing API base URL).</p>
  }

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

  function appendTurn(speaker, text) {
    setTurns((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].speaker === speaker) {
        const copy = prev.slice()
        copy[copy.length - 1] = { speaker, text: copy[copy.length - 1].text + text }
        return copy
      }
      return [...prev, { speaker, text }]
    })
  }

  // Scoring is a nice-to-have layered on top of the actual interview
  // -- if it fails (bad key, provider hiccup, rate limit) that should
  // never interrupt or crash the live conversation, just silently skip
  // that one answer's feedback.
  async function scoreAnswer(question, answer) {
    if (!answer || !answer.trim()) return
    try {
      const res = await fetch(`${API_BASE}/api/score-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question || '',
          answer,
          company_name: selectedTrack?.company_name || '',
          role_title: selectedTrack?.role_title || '',
          jd_text: selectedTrack?.jd_text || '',
        }),
      })
      const json = await res.json()
      if (!json.ok) return
      const entry = {
        question: question || '',
        answer,
        score: json.score,
        quickPointers: json.quick_pointers || [],
        detailedFeedback: json.detailed_feedback || '',
      }
      // Mutate the ref directly (not just via setState) so a later
      // `await scoreAnswer(...)` in finalizeSession can rely on
      // answerScoresRef.current already reflecting this answer the
      // moment this function returns -- state updates alone would lag
      // a render behind.
      answerScoresRef.current = [...answerScoresRef.current, entry]
      if (mountedRef.current) setAnswerScores(answerScoresRef.current)

      const sid = liveRef.current?.sessionId
      if (sid) {
        const { error: insertError } = await supabase.from('interview_answers').insert({
          session_id: sid,
          question_text: entry.question,
          answer_transcript: entry.answer,
          score: entry.score,
          quick_pointers: entry.quickPointers,
          detailed_feedback: entry.detailedFeedback,
        })
        if (insertError) console.error('Failed to save answer score:', insertError.message)
      }
    } catch (err) {
      console.error('Scoring error:', err.message)
    }
  }

  // Runs the moment "End Interview" is clicked (audio is already torn
  // down by then): scores any trailing answer that never got a
  // follow-up question, asks for one overall narrative summary, saves
  // the session row, and shows the report.
  async function finalizeSession() {
    const t = turnsRef.current
    const lastIdx = t.length - 1
    if (lastIdx >= 0 && t[lastIdx].speaker === 'you' && lastIdx > scoredThroughRef.current) {
      scoredThroughRef.current = lastIdx
      const question = t[lastIdx - 1]?.text || ''
      await scoreAnswer(question, t[lastIdx].text)
    }

    const scores = answerScoresRef.current
    const overallScore =
      scores.length > 0
        ? Math.round((scores.reduce((sum, a) => sum + (Number(a.score) || 0), 0) / scores.length) * 10) / 10
        : null

    let overallSummary = ''
    if (scores.length > 0) {
      try {
        const res = await fetch(`${API_BASE}/api/score-session-summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            answers: scores.map((a) => ({
              question: a.question,
              score: a.score,
              detailed_feedback: a.detailedFeedback,
            })),
          }),
        })
        const json = await res.json()
        if (json.ok) overallSummary = json.overall_summary
      } catch (err) {
        console.error('Summary error:', err.message)
      }
    }

    const sid = liveRef.current?.sessionId
    if (sid) {
      const { error: updateError } = await supabase
        .from('interview_sessions')
        .update({ ended_at: new Date().toISOString(), overall_score: overallScore, overall_summary: overallSummary })
        .eq('id', sid)
      if (updateError) console.error('Failed to save session report:', updateError.message)
    }

    if (!mountedRef.current) return
    setSessionReport({ overallScore, overallSummary })
    setStatus('ended')
  }

  async function startInterview() {
    setError(null)
    setTurns([])
    setAnswerScores([])
    answerScoresRef.current = []
    scoredThroughRef.current = -1
    setSessionReport(null)
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

    let tokenData
    try {
      const res = await fetch(`${API_BASE}/api/realtime-test/gemini_live`, { method: 'POST' })
      tokenData = await res.json()
    } catch (err) {
      setError('Token request error: ' + err.message)
      setStatus('idle')
      return
    }
    if (!tokenData.ok) {
      setError(tokenData.error)
      setStatus('idle')
      return
    }

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      setError('Mic error: ' + err.message)
      setStatus('idle')
      return
    }

    const state = { stream, playHead: 0, scheduledSources: [], sessionId: null }
    liveRef.current = state

    // Create the interview_sessions row now -- scoring/session
    // tracking is a nice-to-have, so a failure here is logged but
    // never blocks the actual interview from starting.
    try {
      const { data: sessionRow, error: sessionError } = await supabase
        .from('interview_sessions')
        .insert({ user_id: session.user.id, track_id: selectedTrackId })
        .select('id')
        .single()
      if (sessionError) throw sessionError
      state.sessionId = sessionRow.id
    } catch (err) {
      console.error('Could not create interview session row:', err.message)
    }

    const playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 })
    state.playCtx = playCtx

    function playAudioChunk(int16Array) {
      const float32 = new Float32Array(int16Array.length)
      for (let i = 0; i < int16Array.length; i++) float32[i] = int16Array[i] / 0x8000
      const buffer = playCtx.createBuffer(1, float32.length, 24000)
      buffer.copyToChannel(float32, 0)
      const src = playCtx.createBufferSource()
      src.buffer = buffer
      src.connect(playCtx.destination)
      const startAt = Math.max(playCtx.currentTime, state.playHead)
      src.start(startAt)
      state.playHead = startAt + buffer.duration
      state.scheduledSources.push(src)
      src.onended = () => {
        const i = state.scheduledSources.indexOf(src)
        if (i !== -1) state.scheduledSources.splice(i, 1)
      }
    }

    function stopQueuedAudioForInterruption() {
      for (const src of state.scheduledSources) {
        try {
          src.stop()
        } catch (e) {
          /* already stopped */
        }
      }
      state.scheduledSources = []
      state.playHead = playCtx.currentTime
    }

    try {
      const { GoogleGenAI, Modality } = await import('https://esm.sh/@google/genai')
      const ai = new GoogleGenAI({ apiKey: tokenData.token })
      const systemInstructionText = buildSystemInstruction({
        headline: profile?.headline,
        summary: profile?.summary,
        companyName: selectedTrack?.company_name,
        roleTitle: selectedTrack?.role_title,
        resumeText,
        jdText,
      })

      const liveSession = await ai.live.connect({
        model: tokenData.model,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: systemInstructionText }] },
        },
        callbacks: {
          onopen: () => setStatus('live'),
          onmessage: (message) => {
            const content = message.serverContent
            if (!content) return
            if (content.interrupted) {
              stopQueuedAudioForInterruption()
            }
            if (content.inputTranscription?.text) {
              appendTurn('you', content.inputTranscription.text)
            }
            if (content.outputTranscription?.text) {
              appendTurn('gemini', content.outputTranscription.text)
            }
            if (content.modelTurn?.parts) {
              for (const part of content.modelTurn.parts) {
                if (part.inlineData?.data) {
                  playAudioChunk(base64ToInt16Array(part.inlineData.data))
                }
              }
            }
          },
          onerror: (err) => {
            setError('Live API error: ' + (err?.message || err))
            setStatus('idle')
          },
          onclose: () => {
            setStatus((s) => (s === 'live' ? 'idle' : s))
          },
        },
      })
      state.session = liveSession

      const micCtx = new (window.AudioContext || window.webkitAudioContext)()
      const source = micCtx.createMediaStreamSource(stream)
      const processor = micCtx.createScriptProcessor(4096, 1, 1)
      state.micCtx = micCtx
      state.source = source
      state.processor = processor

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        const pcm16 = downsampleTo16kPCM16(input, micCtx.sampleRate)
        liveSession.sendRealtimeInput({
          audio: { data: pcm16ToBase64(pcm16), mimeType: 'audio/pcm;rate=16000' },
        })
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

  // Pure teardown -- audio/mic/websocket only, no scoring or status
  // changes. Used both by the unmount cleanup effect and by a
  // deliberate "End Interview" click (which separately drives the
  // scoring/report flow via finalizeSession).
  function stopInterview() {
    const state = liveRef.current
    if (!state) return
    try {
      state.session && state.session.close()
    } catch (e) {
      /* ignore */
    }
    try {
      state.processor && state.processor.disconnect()
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
      state.playCtx && state.playCtx.close()
    } catch (e) {
      /* ignore */
    }
    try {
      state.stream && state.stream.getTracks().forEach((t) => t.stop())
    } catch (e) {
      /* ignore */
    }
    liveRef.current = null
  }

  async function handleEndInterview() {
    stopInterview()
    setStatus('ending')
    await finalizeSession()
  }

  function handleStartAnother() {
    setStatus('idle')
    setError(null)
    setTurns([])
    setAnswerScores([])
    answerScoresRef.current = []
    scoredThroughRef.current = -1
    setSessionReport(null)
  }

  return (
    <section>
      <h1>Mock Interview</h1>

      {tracks.length === 0 && status === 'idle' && (
        <p>
          Add a Track first (company + role) on the <a href="/tracks">Tracks</a> page to start a mock
          interview.
        </p>
      )}

      {tracks.length > 0 && status === 'idle' && (
        <>
          <label className="auth-form" style={{ maxWidth: 420 }}>
            Which Track?
            <select value={selectedTrackId} onChange={(e) => setSelectedTrackId(e.target.value)}>
              <option value="">Choose one…</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.role_title || 'Untitled role'}
                  {t.company_name ? ` @ ${t.company_name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
            Tip: use headphones if you can — it keeps the interviewer's voice out of your mic, which
            makes your transcript much cleaner.
          </p>
          <p>
            <button type="button" onClick={startInterview} disabled={!selectedTrackId}>
              Start Interview
            </button>
          </p>
        </>
      )}

      {status === 'preparing' && <p>Getting ready… (reading resume/JD, connecting to Gemini)</p>}

      {status === 'live' && (
        <p>
          🎙️ Live — talk now.{' '}
          <button type="button" onClick={handleEndInterview}>
            End Interview
          </button>
        </p>
      )}

      {status === 'ending' && <p>Wrapping up — scoring your last answer and preparing your report…</p>}

      {error && <p className="form-error">{error}</p>}

      {(status === 'live' || status === 'ending') && turns.length > 0 && (
        <div className="transcript">
          {turns.map((turn, i) => (
            <p key={i}>
              <strong>{turn.speaker === 'you' ? 'You' : 'Interviewer'}:</strong> {turn.text}
            </p>
          ))}
        </div>
      )}

      {status === 'live' && answerScores.length > 0 && (
        <div className="transcript">
          <strong>Quick feedback so far:</strong>
          {answerScores.map((a, i) => (
            <p key={i}>
              {typeof a.score === 'number' ? `Score: ${a.score}/10 — ` : ''}
              {a.quickPointers.join(' · ')}
            </p>
          ))}
        </div>
      )}

      {status === 'ended' && sessionReport && (
        <div>
          <h2>Session Report</h2>
          <p>
            <strong>Overall score:</strong>{' '}
            {sessionReport.overallScore !== null ? `${sessionReport.overallScore}/10` : 'Not enough scored answers'}
          </p>
          {sessionReport.overallSummary && <p>{sessionReport.overallSummary}</p>}

          {answerScores.length > 0 && (
            <>
              <h3>Per-answer detail</h3>
              {answerScores.map((a, i) => (
                <div className="track-card" key={i}>
                  <p>
                    <strong>Q:</strong> {a.question || '(question not captured)'}
                  </p>
                  <p>
                    <strong>Your answer:</strong> {a.answer}
                  </p>
                  <p>
                    <strong>Score:</strong> {typeof a.score === 'number' ? `${a.score}/10` : '—'}
                  </p>
                  {a.quickPointers.length > 0 && (
                    <p>
                      <strong>Quick pointers:</strong> {a.quickPointers.join(' · ')}
                    </p>
                  )}
                  {a.detailedFeedback && (
                    <p>
                      <strong>Feedback:</strong> {a.detailedFeedback}
                    </p>
                  )}
                </div>
              ))}
            </>
          )}

          <p>
            <button type="button" onClick={handleStartAnother}>
              Start another interview
            </button>
          </p>
        </div>
      )}
    </section>
  )
}

export default MockInterview
