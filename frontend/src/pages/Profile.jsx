import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

/**
 * The Profile screen — your general bio, not tied to any one company
 * or role. Headline and summary only; target role/company and resume
 * now live per-Track instead (see the Tracks screen), since those are
 * really about a specific application, not you in general.
 */
function Profile() {
  const { session, profile, loading, refreshProfile } = useAuth()

  const [headline, setHeadline] = useState('')
  const [summary, setSummary] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!profile) return
    setHeadline(profile.headline ?? '')
    setSummary(profile.summary ?? '')
  }, [profile])

  if (loading) return <p>Loading…</p>
  if (!session) return <p>Log in to view your profile.</p>

  async function handleSave(e) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    setSaving(true)
    try {
      const { error: upsertError } = await supabase.from('profiles').upsert({
        id: session.user.id,
        headline: headline || null,
        summary: summary || null,
      })
      if (upsertError) throw upsertError
      await refreshProfile()
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h1>Your profile</h1>
      <p>
        Your general bio — not tied to any specific company or role. For company/role-
        specific prep (and resume), see <a href="/tracks">Tracks</a>.
      </p>

      <form onSubmit={handleSave} className="auth-form">
        <label>
          Headline
          <input
            type="text"
            placeholder="e.g. Frontend Engineer, 3 yrs experience"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
          />
        </label>
        <label>
          Summary
          <textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
        {error && <p className="form-error">{error}</p>}
        {saved && <p className="form-info">Saved.</p>}
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>

      <QAEntries userId={session.user.id} />
    </section>
  )
}

/**
 * Interview Q&A bank: your own facts and stock answers ("who was your
 * last client", "why the gap in your resume", "what's your notice
 * period") that Live Copilot can draw on. Devanshu's own request (29
 * Sep) -- generic personal facts that don't belong on any one Track,
 * but that a suggested answer should still be able to use.
 *
 * Live Copilot doesn't blindly dump this whole list into every
 * suggestion prompt -- it keyword-matches each interviewer question
 * against these and only includes the closest few, so this list can
 * grow long without bloating (or slowing down) every request.
 */
function QAEntries({ userId }) {
  const [entries, setEntries] = useState([])
  const [fetching, setFetching] = useState(true)
  const [listError, setListError] = useState(null)

  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)

  async function loadEntries() {
    setFetching(true)
    setListError(null)
    const { data, error } = await supabase
      .from('qa_entries')
      .select('id, question, answer, created_at')
      .order('created_at', { ascending: true })
    if (error) setListError(error.message)
    else setEntries(data)
    setFetching(false)
  }

  useEffect(() => {
    loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleAdd(e) {
    e.preventDefault()
    setAddError(null)
    if (!question.trim() || !answer.trim()) {
      setAddError('Both a question and an answer are needed.')
      return
    }
    setAdding(true)
    try {
      const { error } = await supabase
        .from('qa_entries')
        .insert({ user_id: userId, question: question.trim(), answer: answer.trim() })
      if (error) throw error
      setQuestion('')
      setAnswer('')
      await loadEntries()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(id) {
    await supabase.from('qa_entries').delete().eq('id', id)
    loadEntries()
  }

  return (
    <div style={{ marginTop: '2rem' }}>
      <h2>Interview Q&amp;A bank</h2>
      <p>
        Generic facts and stock answers Live Copilot can pull from — things like "who was
        your last client", "why the gap in your resume", or "what's your notice period".
        Only the questions closest to what the interviewer actually asks get used each
        time, so it's fine to add many.
      </p>

      {listError && <p className="form-error">{listError}</p>}
      {fetching && <p>Loading…</p>}

      {!fetching &&
        entries.map((e) => (
          <div className="track-card" key={e.id}>
            <p>
              <strong>Q:</strong> {e.question}
            </p>
            <p>
              <strong>A:</strong> {e.answer}
            </p>
            <button type="button" className="link-button" onClick={() => handleDelete(e.id)}>
              Delete
            </button>
          </div>
        ))}

      <h3>Add an entry</h3>
      <form onSubmit={handleAdd} className="auth-form">
        <label>
          Question
          <input
            type="text"
            placeholder="e.g. Who was your last client?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <label>
          Answer
          <textarea
            rows={3}
            placeholder="e.g. A fintech startup called..."
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
        {addError && <p className="form-error">{addError}</p>}
        <button type="submit" disabled={adding}>
          {adding ? 'Adding…' : 'Add entry'}
        </button>
      </form>
    </div>
  )
}

export default Profile
