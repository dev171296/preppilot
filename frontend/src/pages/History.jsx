import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'
import {
  KIND_LABELS,
  SESSION_KINDS,
  buildLiveLines,
  buildMockLines,
  countMatches,
  filterLines,
  formatDateTime,
  formatDuration,
  lineMatches,
  safeFileName,
  sessionMatches,
  sessionToText,
  sessionsToCsv,
  speakerLabel,
} from '../lib/transcripts.js'

// Supabase returns at most 1,000 rows per request, so bigger tables are
// read page by page. Session-id lists are also split into batches to
// keep each request's URL short.
const PAGE_SIZE = 1000
const ID_BATCH = 100

const EMPTY_FILTERS = {
  query: '',
  speaker: 'all',
  includeExtras: true,
  kind: 'all',
  trackId: 'all',
  from: '',
  to: '',
  minScore: '',
  maxScore: '',
  onlyWithSuggestions: false,
  minLines: '',
  sort: 'newest',
}

// Reads every row of a query, page by page. Sorts by created_at when the
// table has it; if it doesn't, retries unsorted (rows are re-sorted
// client-side by whatever timestamps exist).
async function fetchAllRows(table, columns, applyFilters) {
  async function run(ordered) {
    const rows = []
    for (let from = 0; ; from += PAGE_SIZE) {
      let q = supabase.from(table).select(columns)
      q = applyFilters ? applyFilters(q) : q
      if (ordered) q = q.order('created_at', { ascending: true })
      const { data, error } = await q.range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < PAGE_SIZE) break
    }
    return rows
  }
  try {
    return await run(true)
  } catch (err) {
    if (/created_at/i.test(err.message || '')) return run(false)
    throw err
  }
}

async function fetchForSessions(table, sessionIds) {
  const rows = []
  for (let i = 0; i < sessionIds.length; i += ID_BATCH) {
    const batch = sessionIds.slice(i, i + ID_BATCH)
    rows.push(...(await fetchAllRows(table, '*', (q) => q.in('session_id', batch))))
  }
  return rows
}

function groupBySession(rows) {
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.session_id)) map.set(r.session_id, [])
    map.get(r.session_id).push(r)
  }
  return map
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function todayStr(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function timeOnly(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Wraps every occurrence of `query` in <mark>.
function Highlight({ text, query }) {
  const q = (query || '').trim()
  if (!q) return text
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = String(text).split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) => (part.toLowerCase() === q.toLowerCase() ? <mark key={i}>{part}</mark> : part))
}

/**
 * History: every Live Copilot and Mock Interview session, with its full
 * transcript, filters, and export (copy / .txt / .csv). Reads only what
 * those screens already save in Supabase -- Live Copilot saves every
 * line plus the AI suggestion for each question; Mock Interview saves
 * each scored question + answer (not greetings/small talk).
 */
function History() {
  const { session } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tracks, setTracks] = useState([])
  const [sessions, setSessions] = useState([])
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  // Filters start open on a laptop, folded away on a phone (they're long).
  const [showFilters, setShowFilters] = useState(() => typeof window === 'undefined' || window.innerWidth > 700)
  // Inside one session:
  const [detailSpeaker, setDetailSpeaker] = useState('all')
  const [detailShowExtras, setDetailShowExtras] = useState(true)
  const [detailQuery, setDetailQuery] = useState('')
  const [detailOnlyMatching, setDetailOnlyMatching] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [trackRows, liveRows, mockRows] = await Promise.all([
          fetchAllRows('tracks', 'id, company_name, role_title'),
          fetchAllRows('live_sessions', '*'),
          fetchAllRows('interview_sessions', '*'),
        ])
        const liveIds = liveRows.map((s) => s.id)
        const mockIds = mockRows.map((s) => s.id)
        const [turnRows, suggestionRows, answerRows] = await Promise.all([
          fetchForSessions('live_turns', liveIds),
          fetchForSessions('live_suggestions', liveIds),
          fetchForSessions('interview_answers', mockIds),
        ])
        const turnsBy = groupBySession(turnRows)
        const suggBy = groupBySession(suggestionRows)
        const answersBy = groupBySession(answerRows)

        const all = [
          ...liveRows.map((s) => {
            const { lines, unlinkedSuggestions } = buildLiveLines(turnsBy.get(s.id), suggBy.get(s.id))
            return {
              kind: SESSION_KINDS.LIVE,
              id: s.id,
              key: `live:${s.id}`,
              trackId: s.track_id || null,
              startedAt: s.created_at || s.started_at || lines[0]?.at || null,
              endedAt: s.ended_at || lines[lines.length - 1]?.at || null,
              lines,
              unlinkedSuggestions,
            }
          }),
          ...mockRows.map((s) => {
            const lines = buildMockLines(answersBy.get(s.id))
            return {
              kind: SESSION_KINDS.MOCK,
              id: s.id,
              key: `mock:${s.id}`,
              trackId: s.track_id || null,
              startedAt: s.created_at || s.started_at || lines[0]?.at || null,
              endedAt: s.ended_at || lines[lines.length - 1]?.at || null,
              overallScore: s.overall_score ?? null,
              overallSummary: s.overall_summary || '',
              lines,
              unlinkedSuggestions: [],
            }
          }),
        ]
        if (!cancelled) {
          setTracks(trackRows)
          setSessions(all)
        }
      } catch (err) {
        if (!cancelled) setError('Could not load your history: ' + (err.message || String(err)))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [session])

  const trackLabelById = useMemo(() => {
    const m = new Map()
    for (const t of tracks) {
      const label = [t.role_title || 'Untitled role', t.company_name ? `@ ${t.company_name}` : ''].join(' ').trim()
      m.set(t.id, label)
    }
    return m
  }, [tracks])
  const trackLabel = (s) => (s.trackId ? trackLabelById.get(s.trackId) || 'Deleted track' : '')

  const visible = useMemo(() => {
    const list = sessions.filter((s) => sessionMatches(s, filters))
    const time = (s) => (s.startedAt ? Date.parse(s.startedAt) : 0)
    const matches = (s) => countMatches(s, filters.query, filters.speaker, filters.includeExtras)
    const sorters = {
      newest: (a, b) => time(b) - time(a),
      oldest: (a, b) => time(a) - time(b),
      longest: (a, b) => b.lines.length - a.lines.length,
      matches: (a, b) => matches(b) - matches(a) || time(b) - time(a),
      score: (a, b) => (b.overallScore ?? -1) - (a.overallScore ?? -1) || time(b) - time(a),
    }
    return list.sort(sorters[filters.sort] || sorters.newest)
  }, [sessions, filters])

  const selectedKey = searchParams.get('session')
  const selected = selectedKey ? sessions.find((s) => s.key === selectedKey) : null

  function setFilter(name, value) {
    setFilters((prev) => ({ ...prev, [name]: value }))
  }

  function openSession(s) {
    setDetailSpeaker('all')
    setDetailShowExtras(true)
    setDetailQuery(filters.query)
    setDetailOnlyMatching(false)
    setCopied(false)
    setSearchParams({ session: s.key })
    window.scrollTo(0, 0)
  }

  function closeSession() {
    setSearchParams({})
  }

  function downloadAllShown() {
    const items = visible.map((s) => ({ session: s, lines: s.lines, trackLabel: trackLabel(s) }))
    downloadFile(`preppilot-transcripts-${todayStr()}.csv`, sessionsToCsv(items), 'text/csv;charset=utf-8')
  }

  if (!session) return <p>Log in to see your history.</p>

  // ---------------- One session ----------------
  if (selectedKey) {
    if (loading) return <p>Loading…</p>
    if (!selected) {
      return (
        <section>
          <p>That session couldn't be found.</p>
          <button type="button" onClick={closeSession}>
            ← All sessions
          </button>
        </section>
      )
    }
    const shownLines = filterLines(selected.lines, {
      speaker: detailSpeaker,
      query: detailQuery,
      onlyMatching: detailOnlyMatching,
      includeExtras: detailShowExtras,
    })
    const label = trackLabel(selected)
    const baseName = safeFileName(
      `${KIND_LABELS[selected.kind]}-${(selected.startedAt || '').slice(0, 10)}-${label || 'no-track'}`,
    )
    const text = () => sessionToText(selected, shownLines, { trackLabel: label, includeExtras: detailShowExtras })
    const suggestionCount = selected.lines.filter((l) => l.extra?.kind === 'suggestion').length

    return (
      <section className="history">
        <p>
          <button type="button" onClick={closeSession}>
            ← All sessions
          </button>
        </p>
        <h1>
          {KIND_LABELS[selected.kind]} · {formatDateTime(selected.startedAt)}
        </h1>
        <p className="history-meta">
          {label || 'No track'}
          {formatDuration(selected.startedAt, selected.endedAt) &&
            ` · ${formatDuration(selected.startedAt, selected.endedAt)}`}
          {` · ${selected.lines.length} lines`}
          {selected.kind === SESSION_KINDS.LIVE && ` · ${suggestionCount} AI suggestions`}
          {selected.kind === SESSION_KINDS.MOCK && selected.overallScore != null && ` · Score ${selected.overallScore}/10`}
        </p>

        <div className="history-filters">
          <label>
            Show
            <select value={detailSpeaker} onChange={(e) => setDetailSpeaker(e.target.value)}>
              <option value="all">Everyone</option>
              <option value="interviewer">{speakerLabel(selected.kind, 'interviewer')} only</option>
              <option value="you">Me only</option>
            </select>
          </label>
          <label>
            Find in this transcript
            <input
              type="search"
              value={detailQuery}
              placeholder="Type a word…"
              onChange={(e) => setDetailQuery(e.target.value)}
            />
          </label>
          <label className="history-check">
            <input
              type="checkbox"
              checked={detailOnlyMatching}
              onChange={(e) => setDetailOnlyMatching(e.target.checked)}
            />{' '}
            Only lines that match
          </label>
          <label className="history-check">
            <input
              type="checkbox"
              checked={detailShowExtras}
              onChange={(e) => setDetailShowExtras(e.target.checked)}
            />{' '}
            {selected.kind === SESSION_KINDS.LIVE ? 'Show AI suggestions' : 'Show scores & feedback'}
          </label>
        </div>

        <p className="history-actions">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard
                ?.writeText(text())
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }}
          >
            {copied ? 'Copied ✓' : 'Copy transcript'}
          </button>
          <button type="button" onClick={() => downloadFile(`${baseName}.txt`, text(), 'text/plain;charset=utf-8')}>
            Download .txt
          </button>
          <button
            type="button"
            onClick={() =>
              downloadFile(
                `${baseName}.csv`,
                sessionsToCsv([{ session: selected, lines: shownLines, trackLabel: label }], {
                  includeExtras: detailShowExtras,
                }),
                'text/csv;charset=utf-8',
              )
            }
          >
            Download .csv (Excel)
          </button>
        </p>
        <p className="history-hint">Downloads and copies include exactly what's shown below.</p>

        {selected.kind === SESSION_KINDS.MOCK && detailShowExtras && selected.overallSummary && (
          <div className="history-summary">
            <strong>Overall feedback</strong>
            <p>{selected.overallSummary}</p>
          </div>
        )}

        {selected.kind === SESSION_KINDS.MOCK && (
          <p className="history-hint">
            Mock Interview saves each scored question and your answer (not greetings or small talk).
          </p>
        )}

        {shownLines.length === 0 && <p className="history-empty">Nothing to show with these settings.</p>}

        <div className="history-transcript">
          {shownLines.map((l, i) => (
            <div key={i} className={`history-line history-line-${l.speaker}`}>
              <div className="history-line-head">
                <strong>{speakerLabel(selected.kind, l.speaker)}</strong>
                {l.at && <span className="history-time">{timeOnly(l.at)}</span>}
              </div>
              <p className={lineMatches(l, detailQuery, false) && detailQuery.trim() ? 'is-match' : ''}>
                <Highlight text={l.text} query={detailQuery} />
              </p>
              {detailShowExtras && l.extra && (
                <div className="history-extra">
                  {l.extra.kind === 'feedback' && l.extra.score != null && (
                    <div className="history-extra-label">Score {l.extra.score}/10</div>
                  )}
                  {l.extra.kind === 'suggestion' && <div className="history-extra-label">AI suggestion</div>}
                  {l.extra.quickPointers.length > 0 && (
                    <ul>
                      {l.extra.quickPointers.map((p, pi) => (
                        <li key={pi}>
                          <Highlight text={p} query={detailQuery} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {(l.extra.suggestedAnswer || l.extra.detailedFeedback) && (
                    <p>
                      <Highlight text={l.extra.suggestedAnswer || l.extra.detailedFeedback} query={detailQuery} />
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {detailShowExtras && selected.unlinkedSuggestions.length > 0 && (
          <details className="history-unlinked">
            <summary>{selected.unlinkedSuggestions.length} more AI suggestions (couldn't be matched to a line)</summary>
            {selected.unlinkedSuggestions.map((e, i) => (
              <div key={i} className="history-extra">
                <ul>
                  {e.quickPointers.map((p, pi) => (
                    <li key={pi}>{p}</li>
                  ))}
                </ul>
                {e.suggestedAnswer && <p>{e.suggestedAnswer}</p>}
              </div>
            ))}
          </details>
        )}
      </section>
    )
  }

  // ---------------- Session list ----------------
  const activeFilterCount = Object.keys(EMPTY_FILTERS).filter(
    (k) => k !== 'sort' && filters[k] !== EMPTY_FILTERS[k],
  ).length

  return (
    <section className="history">
      <h1>History</h1>
      <p className="history-hint">Full transcripts of your Live Copilot and Mock Interview sessions.</p>

      <p>
        <button type="button" className="link-button" onClick={() => setShowFilters((v) => !v)}>
          {showFilters ? 'Hide filters' : `Show filters${activeFilterCount ? ` (${activeFilterCount} on)` : ''}`}
        </button>
      </p>

      {showFilters && (
        <div className="history-filters">
          <label className="history-wide">
            Search words in transcripts
            <input
              type="search"
              value={filters.query}
              placeholder="e.g. Salesforce, objection, notice period…"
              onChange={(e) => setFilter('query', e.target.value)}
            />
          </label>
          <label>
            Said by
            <select value={filters.speaker} onChange={(e) => setFilter('speaker', e.target.value)}>
              <option value="all">Anyone</option>
              <option value="interviewer">Interviewer</option>
              <option value="you">Me</option>
            </select>
          </label>
          <label className="history-check">
            <input
              type="checkbox"
              checked={filters.includeExtras}
              onChange={(e) => setFilter('includeExtras', e.target.checked)}
            />{' '}
            Also search AI suggestions &amp; feedback
          </label>

          <label>
            Type
            <select value={filters.kind} onChange={(e) => setFilter('kind', e.target.value)}>
              <option value="all">All</option>
              <option value={SESSION_KINDS.LIVE}>Live Copilot</option>
              <option value={SESSION_KINDS.MOCK}>Mock Interview</option>
            </select>
          </label>
          <label>
            Track
            <select value={filters.trackId} onChange={(e) => setFilter('trackId', e.target.value)}>
              <option value="all">All tracks</option>
              <option value="none">No track</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {trackLabelById.get(t.id)}
                </option>
              ))}
            </select>
          </label>

          <label>
            From
            <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
          </label>
          <div className="history-quick-dates">
            <button type="button" onClick={() => setFilters((p) => ({ ...p, from: todayStr(), to: todayStr() }))}>
              Today
            </button>
            <button type="button" onClick={() => setFilters((p) => ({ ...p, from: todayStr(-6), to: todayStr() }))}>
              Last 7 days
            </button>
            <button type="button" onClick={() => setFilters((p) => ({ ...p, from: todayStr(-29), to: todayStr() }))}>
              Last 30 days
            </button>
            <button type="button" onClick={() => setFilters((p) => ({ ...p, from: '', to: '' }))}>
              Any date
            </button>
          </div>

          <label>
            Mock score from
            <input
              type="number"
              min="0"
              max="10"
              step="0.5"
              value={filters.minScore}
              onChange={(e) => setFilter('minScore', e.target.value)}
            />
          </label>
          <label>
            to
            <input
              type="number"
              min="0"
              max="10"
              step="0.5"
              value={filters.maxScore}
              onChange={(e) => setFilter('maxScore', e.target.value)}
            />
          </label>
          <label>
            At least this many lines
            <input
              type="number"
              min="0"
              value={filters.minLines}
              onChange={(e) => setFilter('minLines', e.target.value)}
            />
          </label>
          <label className="history-check">
            <input
              type="checkbox"
              checked={filters.onlyWithSuggestions}
              onChange={(e) => setFilter('onlyWithSuggestions', e.target.checked)}
            />{' '}
            Only sessions with AI suggestions
          </label>

          <label>
            Sort by
            <select value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="longest">Longest first</option>
              <option value="matches">Most search matches</option>
              <option value="score">Highest mock score</option>
            </select>
          </label>
          <div>
            <button type="button" className="link-button" onClick={() => setFilters(EMPTY_FILTERS)}>
              Reset filters
            </button>
          </div>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      {loading && <p>Loading your sessions…</p>}

      {!loading && !error && (
        <p className="history-actions">
          <span>
            Showing {visible.length} of {sessions.length} sessions
          </span>
          {visible.length > 0 && (
            <button type="button" onClick={downloadAllShown}>
              Download all shown (.csv)
            </button>
          )}
        </p>
      )}

      {!loading && sessions.length === 0 && !error && (
        <p className="history-empty">No sessions yet. They appear here after you use Live Copilot or Mock Interview.</p>
      )}

      <div className="history-list">
        {visible.map((s) => {
          const firstQuestion = s.lines.find((l) => l.speaker === 'interviewer')?.text || ''
          const matches = countMatches(s, filters.query, filters.speaker, filters.includeExtras)
          const suggestionCount = s.lines.filter((l) => l.extra?.kind === 'suggestion').length
          return (
            <button key={s.key} type="button" className="history-card" onClick={() => openSession(s)}>
              <div className="history-card-top">
                <span className={`history-badge history-badge-${s.kind}`}>{KIND_LABELS[s.kind]}</span>
                <span>{formatDateTime(s.startedAt)}</span>
              </div>
              <div className="history-meta">
                {trackLabel(s) || 'No track'}
                {formatDuration(s.startedAt, s.endedAt) && ` · ${formatDuration(s.startedAt, s.endedAt)}`}
                {` · ${s.lines.length} lines`}
                {s.kind === SESSION_KINDS.LIVE && ` · ${suggestionCount} suggestions`}
                {s.kind === SESSION_KINDS.MOCK && s.overallScore != null && ` · Score ${s.overallScore}/10`}
                {matches > 0 && ` · ${matches} match${matches === 1 ? '' : 'es'}`}
              </div>
              {firstQuestion && (
                <div className="history-preview">
                  “{firstQuestion.length > 140 ? firstQuestion.slice(0, 140) + '…' : firstQuestion}”
                </div>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}

export default History
