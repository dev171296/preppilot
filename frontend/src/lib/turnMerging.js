// Pure helpers for Live Copilot's turn handling (2 Nov hygiene pass).
// Kept free of React/Supabase so they can be unit-tested with plain
// node, and so LiveCopilot.jsx reads as "what happens" rather than
// "how each rule is computed".

// Once the interviewer has started a question, keep treating
// further interviewer speech as PART OF THE SAME question until the
// candidate actually responds -- but only within this long of the
// interviewer's previous segment, so two genuinely separate questions
// asked minutes apart (with the candidate silent in between) don't
// get glued together forever.
export const MERGE_MAX_GAP_MS = 20000

// A candidate turn this short ("okay", "yes sure", "mm-hmm") is an
// acknowledgement, not an answer -- it doesn't end the interviewer's
// question, so their next segment still merges into it. Also covers
// a stray word that diarization briefly mis-tagged as the candidate
// in the middle of the interviewer's sentence.
export const SHORT_INTERJECTION_MAX_WORDS = 3

// An interviewer turn with fewer words than this ("okay", "great",
// "right") doesn't trigger a suggestion on its own -- it still shows
// in the transcript, and still merges with whatever they say next.
// Saves the limited per-minute token budget for actual questions.
export const MIN_QUESTION_WORDS = 3

export function countWords(text) {
  return (text || '').split(/\s+/).filter(Boolean).length
}

// Should a newly completed interviewer segment be merged into the
// currently "open" interviewer question (instead of starting a new one)?
export function shouldMergeIntoOpenQuestion(openQuestion, nowMs) {
  if (!openQuestion) return false
  return nowMs - openQuestion.lastSegmentAt < MERGE_MAX_GAP_MS
}

// Does this completed candidate turn count as the candidate actually
// responding (which closes the interviewer's open question)?
export function candidateTurnClosesQuestion(text) {
  return countWords(text) > SHORT_INTERJECTION_MAX_WORDS
}

export function isWorthASuggestion(text) {
  return countWords(text) >= MIN_QUESTION_WORDS
}

export const SUGGESTION_ERROR_MARKER = '[LIVE_SUGGESTION_ERROR:'

// Rate-limit messages say e.g. "Please try again in 7.66s" / "try
// again in 1m2.5s" (Groq) or "Please retry in 12.3s" (Gemini).
// Returns whole seconds to wait, or null.
export function parseRetryAfterSeconds(message) {
  const m = /(?:try again|retry) in (?:(\d+)m)?([\d.]+)s/i.exec(message || '')
  if (!m) return null
  const minutes = m[1] ? parseInt(m[1], 10) : 0
  return Math.ceil(minutes * 60 + parseFloat(m[2]))
}

export function isRateLimitError(message) {
  return /rate.?limit|429|resource.?exhausted|quota/i.test(message || '')
}

// Splits the backend's raw reply into {text, error}. The backend
// appends "[LIVE_SUGGESTION_ERROR: ...]" when Groq fails; anything
// else is the normal suggestion text.
export function splitSuggestionError(fullText) {
  const idx = (fullText || '').indexOf(SUGGESTION_ERROR_MARKER)
  if (idx === -1) return { text: fullText || '', error: null }
  const raw = fullText.slice(idx + SUGGESTION_ERROR_MARKER.length).replace(/\]\s*$/, '').trim()
  return { text: fullText.slice(0, idx), error: raw || 'Unknown error' }
}

// A short, readable version of an error for the suggestion card.
export function friendlySuggestionError(raw) {
  if (isRateLimitError(raw)) {
    return 'This model\'s free per-minute limit was reached — switching to another model in the dropdown also works.'
  }
  const s = String(raw || 'Unknown error')
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

// "Interview on this laptop" mode without headphones: the mic also
// hears the interviewer through the speakers, so the mic channel can
// produce a (garbled) copy of what the Meet tab channel just said.
// True when most of the mic text's words were just said by the
// interviewer -- such a line is dropped instead of being shown as the
// candidate speaking (which would also wrongly "close" the question).
export const ECHO_WORD_OVERLAP = 0.6
export function isLikelyEcho(micText, recentInterviewerText) {
  const micWords = (micText || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || []
  if (micWords.length < 2) return false
  const heard = new Set((recentInterviewerText || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [])
  if (heard.size === 0) return false
  const overlap = micWords.filter((w) => heard.has(w)).length / micWords.length
  return overlap >= ECHO_WORD_OVERLAP
}
