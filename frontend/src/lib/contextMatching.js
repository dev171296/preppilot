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
// How many of this Track's knowledge-base chunks to actually send
// with a question. Raised from 4 (2 Nov RAG-quality pass) --
// Devanshu's knowledge bases can run 100k+ characters / 50+ chunks,
// and 4 was too few to reliably cover a broad question even with
// good retrieval. The 128k-token model context has plenty of room
// for more.
export const MAX_TRACK_KNOWLEDGE_MATCHES = 8
// Cosine similarity floor (2 Nov) -- below this, a chunk/entry is
// treated as "not actually relevant" and left out rather than
// force-included just because it was the least-bad of what's
// available. Deliberately LOW (not a strict cutoff) because a
// real relevant match should always comfortably clear it, and the
// cost of filtering out something genuinely useful is worse than
// occasionally letting through something marginal. Treat this as a
// starting point, not a final answer -- the Chatbot widget's
// "Context used" panel shows the actual similarity scores on real
// questions, which is the right way to tune this number with real
// data instead of guessing further.
export const MIN_SIMILARITY = 0.15
// How many cosine-shortlisted candidates to hand to the backend's
// second-pass reranker (see matchTrackKnowledgeSemantic below) --
// kept well above MAX_TRACK_KNOWLEDGE_MATCHES so the reranker has
// real choices to make, but capped so the rerank call itself (one
// extra LLM round-trip) stays small and fast.
export const KB_RERANK_POOL_SIZE = 12

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
    .filter((s) => s.similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
  // _similarity is attached (not just used to sort/filter) so callers --
  // right now just the Chatbot widget's "Context used" panel -- can show
  // real relevance scores instead of a black box. Harmless extra field
  // for existing callers that just read .question/.answer off these.
  return scored.slice(0, MAX_QA_MATCHES).map((s) => ({ ...s.entry, _similarity: s.similarity }))
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
    .filter((s) => s.similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
  if (scored.length === 0) return []

  // Stage 1 (above) is cosine similarity over embeddings -- fast, but
  // not always great at telling "topically related" apart from
  // "actually answers this question" once there are several
  // plausible candidates. Stage 2: hand the top candidate pool to the
  // backend's rerank_chunks() (an LLM read of the real question
  // against each candidate) to pick the genuinely best ones. If the
  // rerank call fails or returns nothing usable, fall back to plain
  // cosine order rather than losing the suggestion entirely over it.
  const candidatePool = scored.slice(0, KB_RERANK_POOL_SIZE)
  let rerankedIndices = []
  try {
    const res = await fetch(`${apiBase}/api/rerank-chunks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        candidates: candidatePool.map((s) => s.chunk.chunk_text),
        top_n: MAX_TRACK_KNOWLEDGE_MATCHES,
      }),
    })
    if (res.ok) {
      const rerankJson = await res.json()
      if (Array.isArray(rerankJson.indices)) rerankedIndices = rerankJson.indices
    }
  } catch {
    // Network hiccup -- candidatePool (cosine order) below covers it.
  }

  const selected =
    rerankedIndices.length > 0
      ? rerankedIndices.map((i) => candidatePool[i]).filter(Boolean)
      : candidatePool.slice(0, MAX_TRACK_KNOWLEDGE_MATCHES)
  return selected.map((s) => ({ ...s.chunk, _similarity: s.similarity }))
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
