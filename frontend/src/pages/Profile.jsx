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
    </section>
  )
}

export default Profile
