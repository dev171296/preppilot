import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

const MAX_RESUME_BYTES = 5 * 1024 * 1024 // 5 MB — matches the Supabase Storage bucket's own limit

const ALLOWED_RESUME_TYPES = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

/**
 * A "Track" is one specific thing you're preparing for — a company and
 * a role, with its own resume — kept separate from every other one.
 * Example: "Backend Engineer @ Google" and "Data Analyst @ Meta" are
 * two different Tracks, each with their own target info and resume,
 * instead of one shared set of "target role/company" fields on your
 * main profile. This is where a mock interview (once built) will pull
 * its company/role/resume context from.
 */
function Tracks() {
  const { session, loading: authLoading } = useAuth()

  const [tracks, setTracks] = useState([])
  const [fetching, setFetching] = useState(true)
  const [listError, setListError] = useState(null)

  const [companyName, setCompanyName] = useState('')
  const [roleTitle, setRoleTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)

  async function loadTracks() {
    setFetching(true)
    setListError(null)
    const { data, error } = await supabase
      .from('tracks')
      .select('id, company_name, role_title, resume_path, created_at')
      .order('created_at', { ascending: false })
    if (error) {
      setListError(error.message)
    } else {
      setTracks(data)
    }
    setFetching(false)
  }

  useEffect(() => {
    if (session) loadTracks()
  }, [session])

  if (authLoading) return <p>Loading…</p>
  if (!session) return <p>Log in to view your Tracks.</p>

  async function handleAdd(e) {
    e.preventDefault()
    setAddError(null)
    if (!companyName.trim() && !roleTitle.trim()) {
      setAddError('Add at least a company or a role.')
      return
    }
    setAdding(true)
    try {
      const { error } = await supabase.from('tracks').insert({
        user_id: session.user.id,
        company_name: companyName.trim() || null,
        role_title: roleTitle.trim() || null,
      })
      if (error) throw error
      setCompanyName('')
      setRoleTitle('')
      await loadTracks()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(track) {
    if (track.resume_path) {
      await supabase.storage.from('resumes').remove([track.resume_path])
    }
    await supabase.from('tracks').delete().eq('id', track.id)
    loadTracks()
  }

  if (fetching) return <p>Loading…</p>

  return (
    <section>
      <h1>Your Tracks</h1>
      <p>Each Track is one company + role you're preparing for, with its own resume.</p>

      {listError && <p className="form-error">{listError}</p>}

      {tracks.length === 0 && <p>No Tracks yet — add your first one below.</p>}
      {tracks.map((track) => (
        <TrackCard
          key={track.id}
          track={track}
          userId={session.user.id}
          onChanged={loadTracks}
          onDelete={() => handleDelete(track)}
        />
      ))}

      <h2>Add a Track</h2>
      <form onSubmit={handleAdd} className="auth-form">
        <label>
          Company
          <input
            type="text"
            placeholder="e.g. Google"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
          />
        </label>
        <label>
          Role
          <input
            type="text"
            placeholder="e.g. Backend Engineer"
            value={roleTitle}
            onChange={(e) => setRoleTitle(e.target.value)}
          />
        </label>
        {addError && <p className="form-error">{addError}</p>}
        <button type="submit" disabled={adding}>
          {adding ? 'Adding…' : 'Add Track'}
        </button>
      </form>
    </section>
  )
}

/**
 * One Track's card: its company/role (shown, not editable here to keep
 * this simple — delete and re-add to change), and its own resume
 * upload, separate from every other Track's resume.
 */
function TrackCard({ track, userId, onChanged, onDelete }) {
  const [resumeUrl, setResumeUrl] = useState(null)
  const [resumeFile, setResumeFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!track.resume_path) {
      setResumeUrl(null)
      return
    }
    let cancelled = false
    supabase.storage
      .from('resumes')
      .createSignedUrl(track.resume_path, 60 * 10)
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
  }, [track.resume_path])

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    setResumeFile(null)
    setError(null)
    if (!file) return
    if (!ALLOWED_RESUME_TYPES[file.type]) {
      setError('Please choose a PDF or Word document (.pdf, .doc, .docx).')
      return
    }
    if (file.size > MAX_RESUME_BYTES) {
      setError('That file is larger than 5 MB — please choose a smaller file.')
      return
    }
    setResumeFile(file)
  }

  async function handleUpload() {
    if (!resumeFile) return
    setBusy(true)
    setError(null)
    try {
      const ext = ALLOWED_RESUME_TYPES[resumeFile.type]
      // One resume per Track, at "<user id>/<track id>.<ext>" — storage
      // policies restrict access by user id folder; the track id in
      // the filename is what keeps different Tracks' resumes separate.
      const path = `${userId}/${track.id}.${ext}`
      if (track.resume_path && track.resume_path !== path) {
        await supabase.storage.from('resumes').remove([track.resume_path])
      }
      const { error: uploadError } = await supabase.storage
        .from('resumes')
        .upload(path, resumeFile, { upsert: true, contentType: resumeFile.type })
      if (uploadError) throw uploadError

      const { error: trackError } = await supabase.from('tracks').update({ resume_path: path }).eq('id', track.id)
      if (trackError) throw trackError

      setResumeFile(null)
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleRemoveResume() {
    setBusy(true)
    setError(null)
    try {
      await supabase.storage.from('resumes').remove([track.resume_path])
      const { error: trackError } = await supabase.from('tracks').update({ resume_path: null }).eq('id', track.id)
      if (trackError) throw trackError
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="track-card">
      <div className="track-card-header">
        <strong>
          {track.role_title || 'Untitled role'}
          {track.company_name ? ` @ ${track.company_name}` : ''}
        </strong>
        <button type="button" className="link-button" onClick={onDelete}>
          Delete
        </button>
      </div>

      {track.resume_path ? (
        <p>
          Resume: {track.resume_path.split('.').pop().toUpperCase()}
          {resumeUrl && (
            <>
              {' · '}
              <a href={resumeUrl} target="_blank" rel="noreferrer">
                View
              </a>
            </>
          )}
          {' · '}
          <button type="button" className="link-button" onClick={handleRemoveResume} disabled={busy}>
            Remove
          </button>
        </p>
      ) : (
        <p>No resume for this Track yet.</p>
      )}
      <input
        type="file"
        accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={handleFileChange}
      />
      {resumeFile && (
        <p>
          <button type="button" onClick={handleUpload} disabled={busy}>
            {busy ? 'Uploading…' : `Upload ${resumeFile.name}`}
          </button>
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}

export default Tracks
