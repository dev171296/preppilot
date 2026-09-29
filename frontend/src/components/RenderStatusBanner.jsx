import { useEffect, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE_URL

// Render's free tier puts the backend to sleep after ~15 minutes with
// no requests, and waking it back up takes roughly this long. This is
// just what we've observed in practice, not a number Render publishes
// anywhere official -- if it consistently takes longer or shorter,
// adjust it here.
const EXPECTED_WAKE_SECONDS = 50

// How long we give the FIRST /health check before assuming the
// backend is asleep rather than just being a bit slow on an already-
// awake normal request.
const QUICK_CHECK_MS = 2500

// How often to re-check while we think it's still waking up.
const POLL_INTERVAL_MS = 4000

/**
 * A small banner shown at the top of the app while the Render backend
 * looks like it might still be waking up from a cold start.
 *
 * Why this exists: Devanshu noticed a few times that the app "didn't
 * respond" right after opening it -- what was actually happening is
 * Render's free hosting tier had put the backend to sleep from
 * inactivity, and the very first request has to wait for it to boot
 * back up (can take under a minute). Nothing was broken; there was
 * just no visible sign anything was happening, so it looked frozen.
 *
 * How it decides what to show: on load, it pings the backend's
 * /health endpoint (a tiny "are you alive" route that already existed
 * for the /status page). If that answers quickly, the backend was
 * already awake and this banner never appears at all. If it doesn't
 * answer within a couple of seconds, we assume it's asleep, show a
 * countdown from ~50s, and keep quietly re-checking /health in the
 * background every few seconds. As soon as a check succeeds -- even
 * before the countdown reaches zero, or even after it does -- the
 * banner switches to a brief "ready" message and disappears.
 */
function RenderStatusBanner() {
  const [status, setStatus] = useState('checking') // 'checking' | 'waking' | 'awake'
  const [secondsLeft, setSecondsLeft] = useState(EXPECTED_WAKE_SECONDS)

  useEffect(() => {
    if (!API_BASE) return undefined

    let cancelled = false
    let pollTimeoutId = null
    let markWakingId = null

    async function checkHealth() {
      try {
        const res = await fetch(`${API_BASE}/health`)
        if (!cancelled && res.ok) {
          setStatus('awake')
          return true
        }
      } catch {
        // Not answering yet -- treated the same as "still asleep"
        // below, keep polling rather than showing an error; a cold
        // backend and a network hiccup look identical from here.
      }
      return false
    }

    async function pollUntilAwake() {
      const awake = await checkHealth()
      if (!cancelled && !awake) {
        pollTimeoutId = setTimeout(pollUntilAwake, POLL_INTERVAL_MS)
      }
    }

    // Only switch to the "might be asleep" banner if the FIRST check
    // hasn't come back within QUICK_CHECK_MS -- an already-awake
    // backend normally answers in well under a second, so this stays
    // invisible for the common case.
    markWakingId = setTimeout(() => {
      if (!cancelled) setStatus((s) => (s === 'checking' ? 'waking' : s))
    }, QUICK_CHECK_MS)

    pollUntilAwake()

    return () => {
      cancelled = true
      clearTimeout(pollTimeoutId)
      clearTimeout(markWakingId)
    }
  }, [])

  useEffect(() => {
    if (status !== 'waking') return undefined
    const tick = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0))
    }, 1000)
    return () => clearInterval(tick)
  }, [status])

  if (status !== 'waking') return null

  return (
    <div className="render-status-banner" role="status">
      {secondsLeft > 0 ? (
        <>
          Backend might be waking up from sleep (free hosting) — usually ready in about{' '}
          <strong>{secondsLeft}s</strong>. If a page doesn't respond right now, this is probably
          why — it'll check again automatically and this message will disappear once it's ready.
        </>
      ) : (
        <>Still waking up — hang tight, this can occasionally take a little longer than usual.</>
      )}
    </div>
  )
}

export default RenderStatusBanner
