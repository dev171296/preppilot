import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  matchQaEntriesSemantic,
  matchTrackKnowledgeSemantic,
  parseStreamedSuggestion,
} from '../lib/contextMatching.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL

// How many of the conversation's own prior messages to send to the
// backend as real chat turns (2 Nov, after Devanshu reported the
// widget "does not remember the previous interaction") -- 6 messages
// is 3 full exchanges, enough for a natural follow-up without letting
// the prompt grow unbounded over a long test session.
const CONVERSATION_HISTORY_LIMIT = 6

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
 * 2 Nov: actually conversational now -- recent turns are sent to the
 * backend as real chat messages (see conversation_history in
 * providers.py's stream_live_suggestion_chunks) so a follow-up like
 * "and if I missed the deadline?" gets answered as a follow-up. The
 * question used for RETRIEVAL (finding relevant chunks/Q&A) is also
 * widened with recent context -- see buildRetrievalQuery below -- so
 * a vague follow-up can still find the right material, while the
 * ORIGINAL question (not the widened one) is still what gets shown to
 * the reranker and sent as "the interviewer just asked" to the LLM.
 *
 * On purpose NOT wired to any backend chat-history table -- this is a
 * scratch testing tool, so history is plain React state that clears
 * on refresh (conversational memory lasts the session, not forever).
 */

// Turns this widget's own message list into the {role, content} shape
// the backend expects, oldest first, capped to the last N. Only
// completed (non-streaming) assistant turns are included -- including
// one still mid-stream would send a half-finished answer as if it
// were final.
function buildConversationHistory(priorMessages) {
  const history = []
  for (const m of priorMessages) {
    if (m.role === 'user' && m.text) {
      history.push({ role: 'user', content: m.text })
    } else if (m.role === 'assistant' && !m.streaming && m.suggestedAnswer) {
      history.push({ role: 'assistant', content: m.suggestedAnswer })
    }
  }
  return history.slice(-CONVERSATION_HISTORY_LIMIT)
}

// A simple, rule-based query rewrite for RETRIEVAL only (not for what's
// shown to the model as "the question"): folds the last exchange into
// the embedding text so a short follow-up ("and the gold one?", "what
// about after 7 days?") has enough words in it to actually match the
// right chunk, instead of being searched on its own three words. This
// is the RAG doc's "small model or rules for rewriting" option --
// rules chosen here over an extra LLM call to keep this fast.
function buildRetrievalQuery(priorMessages, question) {
  const lastUser = [...priorMessages].reverse().find((m) => m.role === 'user')
  const lastAssistant = [...priorMessages].reverse().find((m) => m.role === 'assistant' && !m.streaming && m.suggestedAnswer)
  const parts = []
  if (lastUser) parts.push(lastUser.text)
  if (lastAssistant) parts.push(lastAssistant.suggestedAnswer)
  parts.push(question)
  return parts.join('\n')
}
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

    // Captured BEFORE this turn's messages are appended below, so it's
    // genuinely "everything before this question" -- used for both the
    // backend conversation_history and the retrieval query rewrite.
    const priorMessages = messages
    const conversationHistory = buildConversationHistory(priorMessages)
    const retrievalQuery = buildRetrievalQuery(priorMessages, question)

    const userMsgId = ++messageIdRef.current
    const assistantMsgId = ++messageIdRef.current
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', text: question },
      { id: assistantMsgId, role: 'assistant', quickPointers: [], suggestedAnswer: '', streaming: true },
    ])

    let fullText = ''
    try {
      // QA matching uses the question as typed -- saved Q&A entries are
      // themselves short standalone questions, so widening the query
      // with prior turns tends to hurt that match more than help it.
      const matchedQa = await matchQaEntriesSemantic(API_BASE, question, qaEntries)
      const qaContext = matchedQa.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
      // Knowledge-base matching uses the WIDENED query for retrieval
      // (so a short follow-up can still find the right chunk) but the
      // ORIGINAL question for the reranker (see rerankQuestion in
      // matchTrackKnowledgeSemantic) and everything else downstream.
      const matchedKnowledge = await matchTrackKnowledgeSemantic(API_BASE, retrievalQuery, trackKnowledgeChunks, {
        rerankQuestion: question,
      })
      const knowledgeContext = matchedKnowledge.map((c) => c.chunk_text).join('\n\n')

      // Show EVERY context source actually sent for this question, not
      // just KB/Q&A -- Devanshu correctly flagged that a correct answer
      // could come from Notes/JD/Profile summary, which weren't shown
      // here before, making "none of the shown chunks had that info"
      // look like a retrieval bug when it was really a visibility gap.
      const contextUsed = {
        qa: matchedQa,
        knowledge: matchedKnowledge,
        notes: selectedTrack?.notes || '',
        jd: selectedTrack?.jd_text || '',
        profileSummary: profile?.summary || '',
      }
      if (mountedRef.current) {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, contextUsed } : m)))
      }
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
          conversation_history: conversationHistory,
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
                grounding (resume/JD/notes/knowledge base/saved Q&amp;A), same format. Remembers this
                conversation (follow-ups like "and if I missed it?" work), and shows exactly what
                context was used for each answer below it.
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
                  {m.contextUsed && (
                    <details className="chatbot-context-used">
                      <summary>
                        Context used ({m.contextUsed.qa.length} Q&amp;A, {m.contextUsed.knowledge.length} knowledge-base
                        {m.contextUsed.notes ? ', notes' : ''}
                        {m.contextUsed.jd ? ', JD' : ''}
                        {m.contextUsed.profileSummary ? ', profile' : ''})
                      </summary>
                      {/* Every source actually sent with this question, not just KB/Q&A --
                          a correct answer can come from Notes/JD/Profile just as validly. */}
                      {m.contextUsed.notes && (
                        <div className="chatbot-context-item">
                          <span className="chatbot-context-score">Track notes (sent in full, not chunked)</span>
                          <p>{m.contextUsed.notes.slice(0, 220)}{m.contextUsed.notes.length > 220 ? '…' : ''}</p>
                        </div>
                      )}
                      {m.contextUsed.jd && (
                        <div className="chatbot-context-item">
                          <span className="chatbot-context-score">Job description (sent in full, not chunked)</span>
                          <p>{m.contextUsed.jd.slice(0, 220)}{m.contextUsed.jd.length > 220 ? '…' : ''}</p>
                        </div>
                      )}
                      {m.contextUsed.profileSummary && (
                        <div className="chatbot-context-item">
                          <span className="chatbot-context-score">Profile summary (sent in full, not chunked)</span>
                          <p>{m.contextUsed.profileSummary.slice(0, 220)}{m.contextUsed.profileSummary.length > 220 ? '…' : ''}</p>
                        </div>
                      )}
                      {m.contextUsed.knowledge.map((c, i) => (
                        <div key={`k${i}`} className="chatbot-context-item">
                          <span className="chatbot-context-score">
                            KB · semantic {c._similarity.toFixed(2)}
                            {c._keywordScore > 0 ? ` · keyword ${c._keywordScore.toFixed(1)}` : ''}
                          </span>
                          <p>{c.chunk_text.slice(0, 220)}{c.chunk_text.length > 220 ? '…' : ''}</p>
                        </div>
                      ))}
                      {m.contextUsed.qa.map((e, i) => (
                        <div key={`q${i}`} className="chatbot-context-item">
                          <span className="chatbot-context-score">Saved Q&amp;A · similarity {e._similarity.toFixed(2)}</span>
                          <p>{e.question}</p>
                        </div>
                      ))}
                      {m.contextUsed.qa.length === 0 &&
                        m.contextUsed.knowledge.length === 0 &&
                        !m.contextUsed.notes &&
                        !m.contextUsed.jd &&
                        !m.contextUsed.profileSummary && <p className="chatbot-hint">No context was available or relevant for this question (general knowledge only).</p>}
                    </details>
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
