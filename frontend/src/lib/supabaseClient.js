import { createClient } from '@supabase/supabase-js'

/**
 * One shared Supabase client for the whole frontend.
 *
 * These two values come from Vite's environment variables (must be
 * prefixed VITE_ or the browser bundle won't include them — Vite
 * strips anything else out on purpose, as a safety net). Only the
 * "anon" (public) key belongs here. It's safe for it to be visible
 * to anyone who opens dev tools: Supabase's Row Level Security (RLS)
 * policies on each table are the actual gatekeeper, not this key.
 * The separate "service_role" key bypasses RLS entirely and must
 * NEVER be used in frontend code — only from a trusted server, and
 * only if we ever need it there.
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase env vars missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
      'in frontend/.env (local dev) and in the Cloudflare Pages project settings (production).',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
