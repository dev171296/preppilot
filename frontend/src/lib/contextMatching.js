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
// How many candidates to hand to the backend's second-pass reranker
// (see matchTrackKnowledgeSemantic below) after the hybrid merge --
// kept well above MAX_TRACK_KNOWLEDGE_MATCHES so the reranker has real
// choices to make, but capped so the rerank call itself (one extra
// LLM round-trip) stays small and fast.
export const KB_RERANK_POOL_SIZE = 12
// How many candidates EACH of the two retrieval methods (semantic,
// keyword) contributes before they're merged (2 Nov hybrid-search
// pass, following T11's "retrieve wide, then narrow" pattern).
export const HYBRID_SHORTLIST_SIZE = 20

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

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
}

// Simplified TF-IDF-style keyword relevance (2 Nov hybrid-search pass,
// following the "semantic + keyword, merged" pattern from the RAG
// best-practices doc Devanshu shared: semantic search is weak on EXACT
// terms -- a specific code, acronym or product name -- when the
// surrounding wording differs enough that the embeddings don't end up
// close, even though the literal word is right there in both texts.
// Keyword overlap catches that directly. This isn't true BM25 (no
// document-length normalization), but captures the same core idea:
// a shared RARE term counts for more than a shared common one.
function keywordScores(queryText, chunkTexts) {
  const queryTokens = [...new Set(tokenize(queryText))]
  if (queryTokens.length === 0) return chunkTexts.map(() => 0)
  const chunkTokenLists = chunkTexts.map(tokenize)
  const n = chunkTokenLists.length
  const docFreq = {}
  for (const token of queryTokens) {
    docFreq[token] = chunkTokenLists.filter((toks) => toks.includes(token)).length
  }
  return chunkTokenLists.map((toks) => {
    let score = 0
    for (const token of queryTokens) {
      const count = toks.filter((t) => t === token).length
      if (count === 0) continue
      const idf = Math.log((n + 1) / (docFreq[token] + 1)) + 1
      score += count * idf
    }
    return score
  })
}

// Reciprocal Rank Fusion -- the doc's recommended default way to merge
// two ranked lists ("rank-based, no tuning", vs. weighted blending
// which needs per-query tuning to get right). A candidate's combined
// score is the sum of 1/(60+rank) across every list it appears in; 60
// is RRF's own standard constant, not something to tune per question.
// A candidate that ranks well in BOTH lists beats one that only one
// method liked.
function reciprocalRankFusion(rankedKeyLists) {
  const scores = new Map()
  for (const keys of rankedKeyLists) {
    keys.forEach((key, rank) => {
      scores.set(key, (scores.get(key) || 0) + 1 / (60 + rank))
    })
  }
  return scores
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
export async function matchTrackKnowledgeSemantic(apiBase, question, chunks, opts = {}) {
  // rerankQuestion/displayQuestion: when the caller rewrote `question`
  // into something longer for embedding purposes (e.g. the Chatbot
  // widget folding in recent conversation so "and the gold one?"
  // actually embeds as something findable -- see buildRetrievalQuery
  // in ChatbotWidget.jsx), the REAL current question should still be
  // what's shown to the reranker, not the rewritten blob. Defaults to
  // `question` itself, so existing callers (Live Copilot) are unaffected.
  const displayQuestion = opts.rerankQuestion || question
  // rerank: whether to make the extra LLM reranking call at all (2 Nov
  // latency fix). Live Copilot passes { rerank: false } -- during a
  // REAL interview, every suggestion already waits on 2 embedding
  // calls before it can even start streaming; the rerank call is a
  // THIRD network round-trip (a full, non-streamed LLM completion,
  // not just a quick lookup) that Devanshu reported made Live
  // Copilot noticeably slower, while the Chatbot widget (not latency-
  // sensitive -- it's a testing tool) felt fine with it. Defaults to
  // true so the Chatbot widget's quality-over-speed behavior is
  // unchanged; Live Copilot opts out explicitly instead.
  const useRerank = opts.rerank !== false
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

  // Hybrid search (2 Nov, following the shared RAG best-practices doc's
  // T11): two independent rankings over the SAME chunks -- semantic
  // (meaning, via embeddings) and keyword (exact terms, via a simple
  // TF-IDF-style score) -- since each catches relevant chunks the other
  // can miss. Neither list alone decides what's "in"; a chunk only
  // needs to rank well on EITHER to reach the merge step below.
  const semanticRanked = withEmbeddings
    .map((c) => ({ chunk: c, similarity: cosineSimilarity(questionEmbedding, c.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, HYBRID_SHORTLIST_SIZE)
  const kwScores = keywordScores(question, withEmbeddings.map((c) => c.chunk_text))
  const keywordRanked = withEmbeddings
    .map((c, i) => ({ chunk: c, keywordScore: kwScores[i] }))
    .filter((s) => s.keywordScore > 0)
    .sort((a, b) => b.keywordScore - a.keywordScore)
    .slice(0, HYBRID_SHORTLIST_SIZE)
  if (semanticRanked.length === 0 && keywordRanked.length === 0) return []

  // Merge via Reciprocal Rank Fusion. Note there's no MIN_SIMILARITY
  // floor applied here any more -- a chunk that's a strong KEYWORD
  // match (an exact code/term) but only a mediocre semantic one is
  // exactly the case hybrid search exists to rescue (see T11); cutting
  // it on cosine alone would defeat the point. The real relevance gate
  // is the reranker below, which can -- and is instructed to --
  // return nothing if genuinely none of the candidates are relevant.
  const semanticByKey = new Map(semanticRanked.map((s) => [s.chunk.id, s]))
  const keywordByKey = new Map(keywordRanked.map((s) => [s.chunk.id, s]))
  const rrfScores = reciprocalRankFusion([
    semanticRanked.map((s) => s.chunk.id),
    keywordRanked.map((s) => s.chunk.id),
  ])
  const merged = [...rrfScores.entries()]
    .map(([id, rrf]) => {
      const sEntry = semanticByKey.get(id)
      const kEntry = keywordByKey.get(id)
      return {
        chunk: (sEntry || kEntry).chunk,
        rrf,
        similarity: sEntry ? sEntry.similarity : 0,
        keywordScore: kEntry ? kEntry.keywordScore : 0,
      }
    })
    .sort((a, b) => b.rrf - a.rrf)

  // Second-pass reranking (unchanged idea from the first RAG-quality
  // pass, now fed the hybrid-merged shortlist instead of a cosine-only
  // one): hand the top candidates to the backend's rerank_chunks() (an
  // LLM read of the real question against each candidate) for a final
  // precision pass. Falls back to the RRF-merged order if the rerank
  // call fails for any reason, rather than losing the suggestion over it.
  const candidatePool = merged.slice(0, KB_RERANK_POOL_SIZE)
  let rerankedIndices = []
  if (useRerank) {
    try {
      const res = await fetch(`${apiBase}/api/rerank-chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: displayQuestion,
          candidates: candidatePool.map((s) => s.chunk.chunk_text),
          top_n: MAX_TRACK_KNOWLEDGE_MATCHES,
        }),
      })
      if (res.ok) {
        const rerankJson = await res.json()
        if (Array.isArray(rerankJson.indices)) rerankedIndices = rerankJson.indices
      }
    } catch {
      // Network hiccup -- candidatePool (RRF order) below covers it.
    }
  }

  const selected =
    rerankedIndices.length > 0
      ? rerankedIndices.map((i) => candidatePool[i]).filter(Boolean)
      : candidatePool.slice(0, MAX_TRACK_KNOWLEDGE_MATCHES)
  return selected.map((s) => ({ ...s.chunk, _similarity: s.similarity, _keywordScore: s.keywordScore }))
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
