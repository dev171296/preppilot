import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  matchQaEntriesSemantic,
  matchTrackKnowledgeSemantic,
  parseStreamedSuggestion,
} from '../lib/contextMatching.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL

/**
 * A small floating "test chatbot" -- a round icon pinned to the
 * bottom-right corner of every screen that expands into a chat panel.
 * Type a question, optionally pick a Track, and get back exactly what
 * Live Copilot would suggest for that question (same backend
 * endpoint, same resume/JD/notes/knowledge-base/Q&A grounding, same
 * quick-points + suggested-answer format) -- without needing a real
 * mic session running.
 *
 * Why this exists: the main way to check "is my Notes/Knowledge base
 * text actually being used?" was to run a full live mic session.
 * This gives a much faster way to poke at the same pipeline directly.
 *
 * On purpose NOT wired to any backend chat-history table -- this is a
 * scratch testing tool, so history is plain React state that clears
 * on refresh.
 */
function ChatbotWidget() {
  const { session, profile } = useAuth()
  const [open, setOpen] = useState(false)
  const [tracks, setTracks] = useState([])
  const [selectedTrackId, setSelectedTrackId] = useState('')
  const [qaEntries, setQaEntries] = useState([])
  const [trackKnowledgeChunks, setTrackKnowledgeChunks] = useState([])
  const [messages, setMessages] = useState([]) // {id, role: 'user' | 'assistant', text?, quickPointers?, suggestedAnswer?, streaming?}
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const messageIdRef = useRef(0)
  const scrollRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Only load Tracks/Q&A once the panel is actually opened, and only
  // once per session after that -- no point querying Supabase for a
  // widget that's sitting collapsed on every single page.
  useEffect(() => {
    if (!open || !session || tracks.length > 0) return
    supabase
      .from('tracks')
      .select('id, company_name, role_title, jd_text, notes')
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session])

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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, open])

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId)

  async function handleSend() {
    const question = input.trim()
    if (!question || sending) return
    setInput('')
    setSending(true)

    const userMsgId = ++messageIdRef.current
    const assistantMsgId = ++messageIdRef.current
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', text: question },
      { id: assistantMsgId, role: 'assistant', quickPointers: [], suggestedAnswer: '', streaming: true },
    ])

    let fullText = ''
    try {
      const matchedQa = await matchQaEntriesSemantic(API_BASE, question, qaEntries)
      const qaContext = matchedQa.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
      const matchedKnowledge = await matchTrackKnowledgeSemantic(API_BASE, question, trackKnowledgeChunks)
      const knowledgeContext = matchedKnowledge.map((c) => c.chunk_text).join('\n\n')
      const res = await fetch(`${API_BASE}/api/live-suggestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          company_name: selectedTrack?.company_name || '',
          role_title: selectedTrack?.role_title || '',
          jd_text: selectedTrack?.jd_text || '',
          resume_text: '',
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
          setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, ...parsed, streaming: true } : m)))
        }
      }
    } catch (err) {
      if (mountedRef.current) {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, suggestedAnswer: 'Error: ' + err.message, streaming: false } : m))
        )
      }
      setSending(false)
      return
    }

    const final = parseStreamedSuggestion(fullText)
    if (mountedRef.current) {
      setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, ...final, streaming: false } : m)))
    }
    setSending(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Not shown at all when logged out -- there's no resume/JD/Track
  // context to ground anything with, and the backend route needs a
  // question either way.
  if (!session || !API_BASE) return null

  return (
    <div className="chatbot-widget">
      {open && (
        <div className="chatbot-panel">
          <div className="chatbot-panel-header">
            <span>Test chatbot</span>
            <button type="button" className="link-button" onClick={() => setOpen(false)} aria-label="Close chatbot">
              Close
            </button>
          </div>
          <div className="chatbot-panel-subheader">
            <select
              value={selectedTrackId}
              onChange={(e) => setSelectedTrackId(e.target.value)}
              aria-label="Track context for the test chatbot"
            >
              <option value="">No Track context (general only)</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.company_name || 'Untitled'} {t.role_title ? `- ${t.role_title}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="chatbot-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <p className="chatbot-hint">
                Type a question below to see exactly what Live Copilot would suggest for it -- same
                grounding (resume/JD/notes/knowledge base/saved Q&amp;A), same format. Good for testing
                whether a Track's context is actually being used, without running a live session.
              </p>
            )}
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="chatbot-message chatbot-message-user">
                  {m.text}
                </div>
              ) : (
                <div key={m.id} className="chatbot-message chatbot-message-assistant">
                  {m.quickPointers && m.quickPointers.length > 0 && (
                    <ul>
                      {m.quickPointers.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  )}
                  {m.suggestedAnswer && <p className="chatbot-suggested-answer">{m.suggestedAnswer}</p>}
                  {m.streaming && !m.suggestedAnswer && (!m.quickPointers || m.quickPointers.length === 0) && (
                    <p className="chatbot-hint">Thinking...</p>
                  )}
                </div>
              )
            )}
          </div>
          <div className="chatbot-input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a question to test..."
              rows={2}
              disabled={sending}
            />
            <button type="button" onClick={handleSend} disabled={sending || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="chatbot-fab"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close test chatbot' : 'Open test chatbot'}
      >
        {open ? '✕' : '💬'}
      </button>
    </div>
  )
}

export default ChatbotWidget
