import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

// The backend (Render) lives at a different domain from this frontend
// (Cloudflare Pages), so unlike /status (served BY the backend, same
// origin) this needs the full URL and the backend needs CORS enabled
// for this domain (see main.py).
const API_BASE = import.meta.env.VITE_API_BASE_URL

// ---- Shared with /status's Gemini Live implementation (main.py) ----
// Same math, same reasoning: the mic gives us Float32 samples at
// whatever rate the browser feels like (44.1kHz, 48kHz, ...); Gemini
// Live wants 16kHz 16-bit integers. This does a simple "skip samples"
// resample rather than anything fancier -- good enough for speech.
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

/**
 * Builds the instructions Gemini gets before the conversation starts.
 * This is the whole trick behind "Gemini improvises the questions
 * live" -- there's no fixed question list anywhere; instead Gemini is
 * told who the candidate is and what role/company they're aiming for,
 * and asked to run a real interview itself.
 */
function buildSystemInstruction({ headline, summary, companyName, roleTitle, resumeText }) {
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
  if (resumeText) lines.push(`Candidate resume:\n${resumeText}`)
  lines.push('Start by briefly greeting the candidate, then ask your first question.')
  return lines.join('\n\n')
}

/**
 * The real Mock Interview screen: pick which Track you're practicing
 * for, start a live voice conversation with Gemini (primed with that
 * Track's company/role/resume plus your general profile), talk, and
 * end it whenever you're done. No scoring/rating yet -- that's the
 * next step, once this core live-conversation part is confirmed
 * working end to end.
 */
function MockInterview() {
  const { session, profile } = useAuth()

  const [tracks, setTracks] = useState([])
  const [selectedTrackId, setSelectedTrackId] = useState('')
  const [status, setStatus] = useState('idle') // idle | preparing | live
  const [error, setError] = useState(null)
  const [youText, setYouText] = useState('')
  const [geminiText, setGeminiText] = useState('')

  // All the mutable audio/session plumbing lives in a ref, not state --
  // it's updated from audio callbacks many times a second and doesn't
  // need to trigger re-renders itself (only youText/geminiText/status do).
  const liveRef = useRef(null)

  useEffect(() => {
    if (!session) return
    supabase
      .from('tracks')
      .select('id, company_name, role_title, resume_path')
      .order('created_at', { ascending: false })
      .then(({ data, error: fetchError }) => {
        if (!fetchError) setTracks(data || [])
      })
  }, [session])

  // Make sure the mic/session actually get torn down if the person
  // navigates away mid-interview, not just when they click End.
  useEffect(() => {
    return () => stopInterview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!session) return <p>Log in to start a mock interview.</p>
  if (!API_BASE) {
    return <p className="form-error">Mock Interview isn't configured yet (missing API base URL).</p>
  }

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId)

  async function extractResumeText(track) {
    if (!track?.resume_path) return ''
    const { data, error: urlError } = await supabase.storage.from('resumes').createSignedUrl(track.resume_path, 300)
    if (urlError) throw new Error('Could not read resume: ' + urlError.message)
    const res = await fetch(`${API_BASE}/api/extract-resume-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: data.signedUrl, filename: track.resume_path }),
    })
    const json = await res.json()
    if (!json.ok) throw new Error(json.error || 'Could not read resume text')
    return json.text
  }

  async function startInterview() {
    setError(null)
    setYouText('')
    setGeminiText('')
    setStatus('preparing')

    let resumeText = ''
    try {
      resumeText = await extractResumeText(selectedTrack)
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      setError('Mic error: ' + err.message)
      setStatus('idle')
      return
    }

    const state = { stream, playHead: 0, scheduledSources: [] }
    liveRef.current = state

    // 24kHz mono PCM16 is what Live API audio output always uses,
    // regardless of the 16kHz we send it (per Google's own docs).
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

    // Per Google's docs: on an interruption, the CLIENT must stop
    // playback and clear queued audio itself -- the server only tells
    // us it happened, it doesn't silence our speakers for us.
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
              setYouText((t) => t + content.inputTranscription.text)
            }
            if (content.outputTranscription?.text) {
              setGeminiText((t) => t + content.outputTranscription.text)
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
    setStatus('idle')
  }

  return (
    <section>
      <h1>Mock Interview</h1>

      {tracks.length === 0 && (
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
          <p>
            <button type="button" onClick={startInterview} disabled={!selectedTrackId}>
              Start Interview
            </button>
          </p>
        </>
      )}

      {status === 'preparing' && <p>Getting ready… (reading resume, connecting to Gemini)</p>}

      {status === 'live' && (
        <p>
          🎙️ Live — talk now.{' '}
          <button type="button" onClick={stopInterview}>
            End Interview
          </button>
        </p>
      )}

      {error && <p className="form-error">{error}</p>}

      {(youText || geminiText) && (
        <div className="transcript">
          {youText && (
            <p>
              <strong>You:</strong> {youText}
            </p>
          )}
          {geminiText && (
            <p>
              <strong>Interviewer:</strong> {geminiText}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

export default MockInterview
