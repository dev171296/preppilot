import { useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useAuth } from '../lib/AuthContext.jsx'

/**
 * Home screen. Shows one of three things depending on where the
 * visitor is in the login journey:
 *   1. Logged out            -> AuthForm (login / signup)
 *   2. Logged in, no         -> DisclaimerGate (must accept before
 *      disclaimer accepted      using the app)
 *   3. Logged in, accepted   -> a simple welcome/dashboard stub
 */
function Home() {
  const { session, profile, loading } = useAuth()

  if (loading) {
    return <p>Loading…</p>
  }

  if (!session) {
    return <AuthForm />
  }

  // `profile` can briefly be null right after signup, while the
  // database trigger that creates the row hasn't run yet (usually
  // instant, but the network round-trip isn't). Treat "no profile
  // yet" the same as "disclaimer not accepted" — safest default.
  if (!profile || !profile.disclaimer_accepted_at) {
    return <DisclaimerGate />
  }

  return (
    <section>
      <h1>Welcome back</h1>
      <p>You're signed in as {session.user.email}.</p>
      <p>There's nothing else here yet — Mock Interview is still a placeholder.</p>
    </section>
  )
}

/**
 * Login / signup form. Supabase's `auth.signUp` and
 * `auth.signInWithPassword` are the two calls that do the real work;
 * everything else here is just form state and showing errors.
 */
function AuthForm() {
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setBusy(true)
    try {
      if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password })
        if (signUpError) throw signUpError
        if (!data.session) {
          // Email confirmation is turned on for this Supabase project:
          // the account exists but isn't usable until they click the
          // link Supabase just emailed them.
          setInfo('Account created. Check your email to confirm it, then log in.')
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
        if (signInError) throw signInError
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1>{mode === 'login' ? 'Log in' : 'Create your account'}</h1>
      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        {info && <p className="form-info">{info}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
      </form>
      <p>
        {mode === 'login' ? (
          <>
            No account?{' '}
            <button type="button" className="link-button" onClick={() => setMode('signup')}>
              Sign up
            </button>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <button type="button" className="link-button" onClick={() => setMode('login')}>
              Log in
            </button>
          </>
        )}
      </p>
    </section>
  )
}

/**
 * Shown once, right after a person first logs in, until they accept
 * the disclaimer. Writing `disclaimer_accepted_at` is allowed by our
 * Supabase RLS policy ("update only where auth.uid() = id") because
 * they're updating their own row while logged in as themselves.
 */
function DisclaimerGate() {
  const { session, refreshProfile, signOut } = useAuth()
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleAccept() {
    setError(null)
    setBusy(true)
    try {
      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert({ id: session.user.id, disclaimer_accepted_at: new Date().toISOString() })
      if (upsertError) throw upsertError
      await refreshProfile()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1>Before you start</h1>
      <p>
        PrepPilot can listen to a live interview and show you quick, private text
        suggestions on your own screen. Use it thoughtfully — some interviewers or
        platforms may not allow this, and it's on you to know and follow the rules
        that apply to your situation.
      </p>
      <label className="disclaimer-check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        I understand and accept this.
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="disclaimer-actions">
        <button type="button" disabled={!checked || busy} onClick={handleAccept}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
        <button type="button" className="link-button" onClick={signOut}>
          Log out instead
        </button>
      </div>
    </section>
  )
}

export default Home
