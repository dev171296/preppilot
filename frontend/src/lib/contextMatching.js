// Shared by Live Copilot and the test Chatbot widget: both need to
// turn a free-text question into the small, most-relevant slice of
// saved Q&A entries / Track knowledge-base chunks to send the LLM,
// rather than the whole thing every time (see MAX_QA_MATCHES /
// MAX_TRACK_KNOWLEDGE_MATCHES below). Pulled out of LiveCopilot.jsx
// (2 Nov) so the Chatbot widget tests the EXACT same retrieval code
// path Live Copilot actually uses, instead of a second copy that
// could quietly drift out of sync with it.

export const QUICK_POINTS_MARKER = 'QUICK POINTS:'
export const SUGGESTED_ANSWER_MARKER = 'SUGGESTED ANSWER:'
export const MAX_QA_MATCHES = 3
// How many of this Track's knowledge-base chunks (see Tracks.jsx's
// "Knowledge base" section) to pull in per question -- kept small
// since these get sent on every live suggestion request, same
// reasoning as MAX_QA_MATCHES above.
export const MAX_TRACK_KNOWLEDGE_MATCHES = 4

// Real semantic search (30 Sep upgrade, replacing keyword-overlap
// matching). Cosine similarity is the standard way to compare two
// embedding vectors -- 1 means "same meaning", 0 means "unrelated".
export function cosineSimilarity(a, b) {
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
export async function matchQaEntriesSemantic(apiBase, question, qaEntries) {
  const withEmbeddings = qaEntries.filter((e) => Array.isArray(e.embedding) && e.embedding.length > 0)
  if (withEmbeddings.length === 0) return []
  let questionEmbedding
  try {
    const res = await fetch(`${apiBase}/api/embed-text`, {
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
export async function matchTrackKnowledgeSemantic(apiBase, question, chunks) {
  const withEmbeddings = chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
  if (withEmbeddings.length === 0) return []
  let questionEmbedding
  try {
    const res = await fetch(`${apiBase}/api/embed-text`, {
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
export function parseStreamedSuggestion(fullText) {
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
