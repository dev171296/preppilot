// Pure helpers for the History page (transcripts of Live Copilot and
// Mock Interview sessions): turning saved rows into one common "lines"
// shape, filtering, and exporting. No React/Supabase in here, so it
// can be tested with plain node.
//
// A "line" is one thing someone said:
//   { speaker: 'interviewer' | 'you', text, at, extra }
// where `extra` (optional) is what PrepPilot added for that line:
//   Live Copilot  -> the AI suggestion shown for an interviewer question
//                    { kind: 'suggestion', quickPointers: [..], suggestedAnswer }
//   Mock Interview -> the score/feedback for your answer
//                    { kind: 'feedback', score, quickPointers: [..], detailedFeedback }

export const SESSION_KINDS = { LIVE: 'live', MOCK: 'mock' }

export const KIND_LABELS = {
  live: 'Live Copilot',
  mock: 'Mock Interview',
}

// quick_pointers has been saved in a few shapes over time: plain
// strings, {point, explanation} objects, or a JSON string of either.
export function normalizeQuickPointers(value) {
  let list = value
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = list ? [list] : []
    }
  }
  if (!Array.isArray(list)) return []
  return list
    .map((p) => {
      if (typeof p === 'string') return p.trim()
      if (p && typeof p === 'object') {
        const point = (p.point || '').trim()
        const explanation = (p.explanation || '').trim()
        return explanation ? `${point} — ${explanation}` : point
      }
      return ''
    })
    .filter(Boolean)
}

function byTime(a, b) {
  const ta = a.created_at ? Date.parse(a.created_at) : 0
  const tb = b.created_at ? Date.parse(b.created_at) : 0
  return ta - tb
}

// Live Copilot: one line per saved turn; each interviewer turn gets the
// suggestion that was saved for it (matched by turn id). Suggestions
// that couldn't be linked to a turn are returned separately.
export function buildLiveLines(turns, suggestions) {
  const byTurn = new Map()
  const unlinked = []
  for (const s of [...(suggestions || [])].sort(byTime)) {
    const extra = {
      kind: 'suggestion',
      quickPointers: normalizeQuickPointers(s.quick_pointers),
      suggestedAnswer: s.suggested_answer || '',
    }
    // If a question was re-answered (e.g. after a merge), keep the latest.
    if (s.turn_id != null) byTurn.set(s.turn_id, extra)
    else unlinked.push(extra)
  }
  const lines = [...(turns || [])].sort(byTime).map((t) => ({
    speaker: t.speaker === 'you' ? 'you' : 'interviewer',
    text: t.text || '',
    at: t.created_at || null,
    extra: byTurn.get(t.id) || null,
  }))
  return { lines, unlinkedSuggestions: unlinked }
}

// Mock Interview only saves each scored question + your answer (not
// greetings or small talk), so the transcript is those pairs.
export function buildMockLines(answers) {
  const lines = []
  for (const a of [...(answers || [])].sort(byTime)) {
    if (a.question_text) {
      lines.push({ speaker: 'interviewer', text: a.question_text, at: a.created_at || null, extra: null })
    }
    lines.push({
      speaker: 'you',
      text: a.answer_transcript || '',
      at: a.created_at || null,
      extra: {
        kind: 'feedback',
        score: a.score ?? null,
        quickPointers: normalizeQuickPointers(a.quick_pointers),
        detailedFeedback: a.detailed_feedback || '',
      },
    })
  }
  return lines
}

export function speakerLabel(kind, speaker) {
  if (speaker === 'you') return 'You'
  return kind === SESSION_KINDS.MOCK ? 'AI interviewer' : 'Interviewer'
}

function extraText(extra) {
  if (!extra) return ''
  if (extra.kind === 'suggestion') return [...extra.quickPointers, extra.suggestedAnswer].join(' ')
  return [...extra.quickPointers, extra.detailedFeedback].join(' ')
}

function includesText(haystack, needle) {
  return haystack.toLowerCase().includes(needle)
}

// Does this line contain the search text? `includeExtras` also searches
// the AI suggestion / feedback attached to it.
export function lineMatches(line, query, includeExtras = true) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  if (includesText(line.text, q)) return true
  return includeExtras && includesText(extraText(line.extra), q)
}

// Speaker filter inside one session: 'all' | 'interviewer' | 'you'.
export function filterLines(lines, { speaker = 'all', query = '', onlyMatching = false, includeExtras = true } = {}) {
  return lines.filter((l) => {
    if (speaker !== 'all' && l.speaker !== speaker) return false
    if (onlyMatching && !lineMatches(l, query, includeExtras)) return false
    return true
  })
}

// Start of the given local calendar day, and the end of it.
function dayStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}
function dayEnd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}

// Session-list filters:
//   kind: 'all' | 'live' | 'mock'
//   trackId: 'all' | 'none' | <track id>
//   from / to: 'YYYY-MM-DD' or ''
//   query: text that must appear somewhere in the transcript
//   speaker: limits the text search to one side ('all' | 'interviewer' | 'you')
//   includeExtras: also search AI suggestions/feedback
//   minScore / maxScore: Mock Interview overall score range ('' = any)
//   onlyWithSuggestions: Live Copilot sessions that produced at least one suggestion
//   minLines: sessions with at least this many lines
export function sessionMatches(session, f) {
  if (f.kind && f.kind !== 'all' && session.kind !== f.kind) return false
  if (f.trackId && f.trackId !== 'all') {
    if (f.trackId === 'none' ? session.trackId : session.trackId !== f.trackId) return false
  }
  const started = session.startedAt ? Date.parse(session.startedAt) : null
  if (f.from && (started == null || started < dayStart(f.from))) return false
  if (f.to && (started == null || started > dayEnd(f.to))) return false
  if (f.minScore !== '' && f.minScore != null) {
    if (session.kind !== SESSION_KINDS.MOCK || session.overallScore == null) return false
    if (Number(session.overallScore) < Number(f.minScore)) return false
  }
  if (f.maxScore !== '' && f.maxScore != null) {
    if (session.kind !== SESSION_KINDS.MOCK || session.overallScore == null) return false
    if (Number(session.overallScore) > Number(f.maxScore)) return false
  }
  if (f.onlyWithSuggestions && !session.lines.some((l) => l.extra?.kind === 'suggestion')) return false
  if (f.minLines && session.lines.length < Number(f.minLines)) return false
  const q = (f.query || '').trim()
  if (q) {
    const pool = filterLines(session.lines, { speaker: f.speaker || 'all' })
    if (!pool.some((l) => lineMatches(l, q, f.includeExtras !== false))) return false
  }
  return true
}

export function countMatches(session, query, speaker = 'all', includeExtras = true) {
  const q = (query || '').trim()
  if (!q) return 0
  return filterLines(session.lines, { speaker }).filter((l) => lineMatches(l, q, includeExtras)).length
}

export function formatDateTime(iso) {
  if (!iso) return 'Unknown time'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Unknown time'
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return ''
  const ms = Date.parse(endIso) - Date.parse(startIso)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'under 1 min'
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} h ${mins % 60} min`
}

// Plain-text transcript for one session (what "Copy" / ".txt" give you).
export function sessionToText(session, lines, { trackLabel = '', includeExtras = true } = {}) {
  const out = []
  out.push(`${KIND_LABELS[session.kind]} — ${formatDateTime(session.startedAt)}`)
  if (trackLabel) out.push(`Track: ${trackLabel}`)
  const dur = formatDuration(session.startedAt, session.endedAt)
  if (dur) out.push(`Duration: ${dur}`)
  if (session.kind === SESSION_KINDS.MOCK && session.overallScore != null) {
    out.push(`Overall score: ${session.overallScore}/10`)
  }
  if (session.kind === SESSION_KINDS.MOCK && session.overallSummary && includeExtras) {
    out.push('', 'Overall feedback:', session.overallSummary)
  }
  out.push('')
  for (const l of lines) {
    out.push(`${speakerLabel(session.kind, l.speaker)}: ${l.text}`)
    if (includeExtras && l.extra) {
      if (l.extra.kind === 'suggestion') {
        for (const p of l.extra.quickPointers) out.push(`    • ${p}`)
        if (l.extra.suggestedAnswer) out.push(`    Suggested answer: ${l.extra.suggestedAnswer}`)
      } else {
        if (l.extra.score != null) out.push(`    Score: ${l.extra.score}/10`)
        for (const p of l.extra.quickPointers) out.push(`    • ${p}`)
        if (l.extra.detailedFeedback) out.push(`    Feedback: ${l.extra.detailedFeedback}`)
      }
    }
    out.push('')
  }
  return out.join('\n').trim() + '\n'
}

export function csvEscape(value) {
  const s = value == null ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// One row per line, across one or many sessions (opens in Excel/Sheets).
export function sessionsToCsv(items, { includeExtras = true } = {}) {
  const header = ['Session type', 'Session started', 'Track', 'Line #', 'Speaker', 'Text']
  if (includeExtras) header.push('AI quick points', 'AI suggested answer', 'Score', 'Feedback')
  const rows = [header]
  for (const { session, lines, trackLabel } of items) {
    lines.forEach((l, i) => {
      const row = [
        KIND_LABELS[session.kind],
        session.startedAt || '',
        trackLabel || '',
        i + 1,
        speakerLabel(session.kind, l.speaker),
        l.text,
      ]
      if (includeExtras) {
        const e = l.extra
        row.push(
          e ? e.quickPointers.join(' | ') : '',
          e?.kind === 'suggestion' ? e.suggestedAnswer : '',
          e?.kind === 'feedback' && e.score != null ? e.score : '',
          e?.kind === 'feedback' ? e.detailedFeedback : '',
        )
      }
      rows.push(row)
    })
  }
  // Leading BOM so Excel opens Hindi/Devanagari text correctly.
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'
}

export function safeFileName(text) {
  return (text || 'transcript').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'transcript'
}
