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
      loadProfile(current?.user?.id).finally(() => setLoading(false))
    })

    // From here on, react any time login/logout/token-refresh happens.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      loadProfile(newSession?.user?.id)
    })

    return () => listener.subscription.unsubscribe()
  }, [loadProfile])

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
