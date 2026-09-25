import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

const MAX_RESUME_BYTES = 5 * 1024 * 1024 // 5 MB — keep uploads small and fast

/**
 * The Profile screen. Everything here is optional — headline, summary,
 * target role/company, and a resume file. Nothing here is used yet by
 * the interview logic (that doesn't exist yet), but the plan is: once
 * a mock interview is built, whatever's filled in here gets passed to
 * the LLM as context, so questions can be tailored (e.g. "you're
 * targeting a Frontend Engineer role at Google" shapes what's asked).
 */
function Profile() {
  const { session, profile, loading, refreshProfile } = useAuth()

  const [headline, setHeadline] = useState('')
  const [summary, setSummary] = useState('')
  const [targetRole, setTargetRole] = useState('')
  const [targetCompany, setTargetCompany] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const [resumeFile, setResumeFile] = useState(null)
  const [resumeUrl, setResumeUrl] = useState(null)
  const [resumeBusy, setResumeBusy] = useState(false)
  const [resumeError, setResumeError] = useState(null)

  // Fill the form once the profile has loaded (or changes elsewhere).
  useEffect(() => {
    if (!profile) return
    setHeadline(profile.headline ?? '')
    setSummary(profile.summary ?? '')
    setTargetRole(profile.target_role ?? '')
    setTargetCompany(profile.target_company ?? '')
  }, [profile])

  // The resume bucket is private, so we can't just link to the file —
  // we ask Supabase for a short-lived signed URL each time we need one.
  useEffect(() => {
    if (!profile?.resume_path) {
      setResumeUrl(null)
      return
    }
    let cancelled = false
    supabase.storage
      .from('resumes')
      .createSignedUrl(profile.resume_path, 60 * 10) // valid 10 minutes
      .then(({ data, error: urlError }) => {
        if (cancelled) return
        if (urlError) {
          console.error('Failed to get resume URL:', urlError.message)
          return
        }
        setResumeUrl(data.signedUrl)
      })
    return () => {
      cancelled = true
    }
  }, [profile?.resume_path])

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
        target_role: targetRole || null,
        target_company: targetCompany || null,
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

  async function handleResumeChange(e) {
    const file = e.target.files?.[0]
    setResumeFile(null)
    if (!file) return

    setResumeError(null)
    if (file.type !== 'application/pdf') {
      setResumeError('Please choose a PDF file.')
      return
    }
    if (file.size > MAX_RESUME_BYTES) {
      setResumeError('That file is larger than 5 MB — please choose a smaller PDF.')
      return
    }
    setResumeFile(file)
  }

  async function handleResumeUpload() {
    if (!resumeFile) return
    setResumeBusy(true)
    setResumeError(null)
    try {
      // Stored at "<user id>/resume.pdf" — the storage policies only
      // let each person read/write inside a folder named after their
      // own id, so this path is what makes that enforceable.
      const path = `${session.user.id}/resume.pdf`
      const { error: uploadError } = await supabase.storage
        .from('resumes')
        .upload(path, resumeFile, { upsert: true, contentType: 'application/pdf' })
      if (uploadError) throw uploadError

      const { error: profileError } = await supabase
        .from('profiles')
        .upsert({ id: session.user.id, resume_path: path })
      if (profileError) throw profileError

      await refreshProfile()
      setResumeFile(null)
    } catch (err) {
      setResumeError(err.message)
    } finally {
      setResumeBusy(false)
    }
  }

  async function handleResumeRemove() {
    if (!profile?.resume_path) return
    setResumeBusy(true)
    setResumeError(null)
    try {
      const { error: removeError } = await supabase.storage.from('resumes').remove([profile.resume_path])
      if (removeError) throw removeError
      const { error: profileError } = await supabase
        .from('profiles')
        .upsert({ id: session.user.id, resume_path: null })
      if (profileError) throw profileError
      await refreshProfile()
    } catch (err) {
      setResumeError(err.message)
    } finally {
      setResumeBusy(false)
    }
  }

  return (
    <section>
      <h1>Your profile</h1>
      <p>
        Everything below is optional. Once mock interviews are built, whatever you fill
        in here will be used to tailor the questions you get asked.
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
        <label>
          Target role
          <input
            type="text"
            placeholder="e.g. Senior Backend Engineer"
            value={targetRole}
            onChange={(e) => setTargetRole(e.target.value)}
          />
        </label>
        <label>
          Target company
          <input
            type="text"
            placeholder="e.g. Google (leave blank if not sure yet)"
            value={targetCompany}
            onChange={(e) => setTargetCompany(e.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        {saved && <p className="form-info">Saved.</p>}
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>

      <h2>Resume</h2>
      {profile?.resume_path ? (
        <p>
          A resume is on file.{' '}
          {resumeUrl && (
            <a href={resumeUrl} target="_blank" rel="noreferrer">
              View it
            </a>
          )}
          {' · '}
          <button type="button" className="link-button" onClick={handleResumeRemove} disabled={resumeBusy}>
            Remove
          </button>
        </p>
      ) : (
        <p>No resume uploaded yet (PDF, up to 5 MB).</p>
      )}
      <input type="file" accept="application/pdf" onChange={handleResumeChange} />
      {resumeFile && (
        <p>
          <button type="button" onClick={handleResumeUpload} disabled={resumeBusy}>
            {resumeBusy ? 'Uploading…' : `Upload ${resumeFile.name}`}
          </button>
        </p>
      )}
      {resumeError && <p className="form-error">{resumeError}</p>}
    </section>
  )
}

export default Profile
