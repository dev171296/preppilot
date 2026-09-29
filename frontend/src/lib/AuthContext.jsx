import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient.js'

/**
 * Shares "who is logged in" with the whole app, in one place, instead
 * of every screen re-checking Supabase itself.
 *
 * - `session` is Supabase's own object for "is someone logged in and
 *   with which token" — null when logged out.
 * - `profile` is OUR row from the `profiles` table for that person
 *   (headline, summary, `disclaimer_accepted_at`) — general bio only.
 *   Company/role-specific info (target role, target company, resume)
 *   lives per-Track instead, loaded separately by the Tracks screen.
 *   `profile` is kept separate from `session` because `session` is
 *   about authentication (proving who you are) and `profile` is about
 *   our own app data about that person.
 */
const AuthContext = createContext(undefined)

// Auto-logout after a fixed 2-hour window from login, regardless of
// activity -- separate from (and shorter than) whatever token-refresh
// Supabase itself does under the hood to keep you signed in quietly.
// Stored in localStorage (not sessionStorage) so the clock keeps
// running across a page refresh or closing/reopening the tab within
// those 2 hours, rather than resetting every time the app reloads.
const LOGIN_WINDOW_MS = 2 * 60 * 60 * 1000 // 2 hours
const LOGIN_AT_KEY = 'preppilot_login_at'
const AUTO_LOGOUT_CHECK_MS = 60 * 1000 // check once a minute

function getLoginAt() {
  try {
    const raw = localStorage.getItem(LOGIN_AT_KEY)
    return raw ? parseInt(raw, 10) : null
  } catch {
    return null
  }
}

function setLoginAtIfMissing() {
  try {
    if (!localStorage.getItem(LOGIN_AT_KEY)) {
      localStorage.setItem(LOGIN_AT_KEY, String(Date.now()))
    }
  } catch {
    // localStorage unavailable (e.g. private browsing) -- auto-logout
    // just won't have a start time to count from in that case.
  }
}

function clearLoginAt() {
  try {
    localStorage.removeItem(LOGIN_AT_KEY)
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null)
      return
    }
    const { data, error } = await supabase
      .from('profiles')
      .select('id, headline, summary, disclaimer_accepted_at, created_at')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      console.error('Failed to load profile:', error.message)
      setProfile(null)
      return
    }
    setProfile(data)
  }, [])

  useEffect(() => {
    // On first load, ask Supabase "is there already a logged-in session?"
    // (e.g. the person closed the tab and came back — Supabase keeps
    // the session in the browser's storage so they don't have to log
    // in again every time).
    supabase.auth.getSession().then(({ data: { session: current } }) => {
      setSession(current)
      if (current) setLoginAtIfMissing()
      loadProfile(current?.user?.id).finally(() => setLoading(false))
    })

    // From here on, react any time login/logout/token-refresh happens.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      if (newSession) {
        // Only records a start time the FIRST time we see a session --
        // Supabase also fires this on its own silent token refreshes,
        // which must NOT reset the 2-hour window.
        setLoginAtIfMissing()
      } else {
        clearLoginAt()
      }
      loadProfile(newSession?.user?.id)
    })

    return () => listener.subscription.unsubscribe()
  }, [loadProfile])

  // The actual 2-hour auto-logout: checks once a minute (rather than
  // one long setTimeout) so it still works correctly even if the tab
  // was backgrounded for a while, which can delay a long setTimeout.
  useEffect(() => {
    if (!session) return undefined
    const check = () => {
      const loginAt = getLoginAt()
      if (loginAt && Date.now() - loginAt >= LOGIN_WINDOW_MS) {
        supabase.auth.signOut()
      }
    }
    check()
    const id = setInterval(check, AUTO_LOGOUT_CHECK_MS)
    return () => clearInterval(id)
  }, [session])

  const refreshProfile = useCallback(() => loadProfile(session?.user?.id), [session, loadProfile])

  const signOut = useCallback(() => supabase.auth.signOut(), [])

  return (
    <AuthContext.Provider value={{ session, profile, loading, refreshProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return ctx
}
