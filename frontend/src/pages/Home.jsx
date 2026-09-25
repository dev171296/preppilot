import { Link } from 'react-router-dom'

/**
 * Placeholder home screen. Once Supabase Auth is wired in (Task #10),
 * this will show a sign-in form for a logged-out visitor and a real
 * dashboard for a logged-in one. For now it's just a landing stub so
 * the app has somewhere to open to.
 */
function Home() {
  return (
    <section>
      <h1>Welcome to PrepPilot</h1>
      <p>
        Your interview prep and live-interview copilot. Login isn't wired up
        yet — that's next.
      </p>
      <p>
        <Link to="/mock-interview">Try the Mock Interview screen →</Link>
      </p>
    </section>
  )
}

export default Home
