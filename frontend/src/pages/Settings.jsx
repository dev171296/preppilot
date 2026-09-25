import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

// Only these accounts can see/use this page. There's no proper "roles"
// system yet (that's more than this needs right now, with one admin) —
// if PrepPilot ever has other admins, this list is where they'd be added,
// or it'd be worth replacing with a real is_admin column.
const ADMIN_EMAILS = ['fromdevanshu@gmail.com']

// Matches the provider keys the backend already reads from Render's
// environment variables (see providers.py) — kept as a fixed list
// rather than free text so entries here line up with real providers.
const PROVIDERS = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'nvidia', label: 'NVIDIA' },
  { value: 'groq', label: 'Groq' },
  { value: 'deepgram', label: 'Deepgram' },
]

const STATUSES = ['active', 'standby', 'disabled']

function maskKey(value) {
  if (!value) return ''
  if (value.length <= 4) return '••••'
  return `••••${value.slice(-4)}`
}

/**
 * Admin-only key vault: a place to keep track of multiple API keys per
 * provider (e.g. a backup NVIDIA key to switch to if the main one hits
 * its rate limit) with a status per key. IMPORTANT: right now this is
 * storage + bookkeeping only — the live backend still reads its keys
 * from Render's environment variables, completely separately. Wiring
 * the backend to actually use whichever key here is marked "active"
 * is a deliberately separate next step, not done yet.
 */
function Settings() {
  const { session, loading } = useAuth()

  const [keys, setKeys] = useState([])
  const [fetching, setFetching] = useState(true)
  const [listError, setListError] = useState(null)

  const [provider, setProvider] = useState(PROVIDERS[0].value)
  const [label, setLabel] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)

  async function loadKeys() {
    setFetching(true)
    setListError(null)
    const { data, error } = await supabase
      .from('provider_keys')
      .select('id, provider, label, key_value, status, created_at')
      .order('provider', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) {
      setListError(error.message)
    } else {
      setKeys(data)
    }
    setFetching(false)
  }

  useEffect(() => {
    if (session) loadKeys()
  }, [session])

  if (loading) return <p>Loading…</p>
  if (!session) return <p>Log in to view this page.</p>
  if (!ADMIN_EMAILS.includes(session.user.email)) {
    return <p>This page is only available to the PrepPilot admin account.</p>
  }

  async function handleAdd(e) {
    e.preventDefault()
    setAddError(null)
    if (!label.trim() || !keyValue.trim()) {
      setAddError('Label and key are both required.')
      return
    }
    setAdding(true)
    try {
      const { error } = await supabase.from('provider_keys').insert({
        owner_id: session.user.id,
        provider,
        label: label.trim(),
        key_value: keyValue.trim(),
        status: 'standby',
      })
      if (error) throw error
      setLabel('')
      setKeyValue('')
      await loadKeys()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleStatusChange(id, status) {
    await supabase.from('provider_keys').update({ status }).eq('id', id)
    loadKeys()
  }

  async function handleDelete(id) {
    await supabase.from('provider_keys').delete().eq('id', id)
    loadKeys()
  }

  return (
    <section>
      <h1>Settings — Key vault</h1>
      <p>
        Keep track of multiple API keys per provider here. This is bookkeeping only for
        now: the live app still uses the keys set in Render's environment variables —
        nothing added here is actually used by requests yet. Wiring that up is a
        separate next step.
      </p>

      <h2>Add a key</h2>
      <form onSubmit={handleAdd} className="auth-form">
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input
            type="text"
            placeholder="e.g. Backup key 2"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Key value
          <input
            type="password"
            placeholder="Paste the API key"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            autoComplete="off"
          />
        </label>
        {addError && <p className="form-error">{addError}</p>}
        <button type="submit" disabled={adding}>
          {adding ? 'Adding…' : 'Add key'}
        </button>
      </form>

      <h2>Your keys</h2>
      {fetching && <p>Loading…</p>}
      {listError && <p className="form-error">{listError}</p>}
      {!fetching && keys.length === 0 && <p>No keys added yet.</p>}
      {keys.length > 0 && (
        <table className="key-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Label</th>
              <th>Key</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{PROVIDERS.find((p) => p.value === k.provider)?.label ?? k.provider}</td>
                <td>{k.label}</td>
                <td>
                  <code>{maskKey(k.key_value)}</code>
                </td>
                <td>
                  <select value={k.status} onChange={(e) => handleStatusChange(k.id, e.target.value)}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button type="button" className="link-button" onClick={() => handleDelete(k.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default Settings
