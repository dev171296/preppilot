import { NavLink, Route, Routes } from 'react-router-dom'
import Home from './pages/Home.jsx'
import Profile from './pages/Profile.jsx'
import Tracks from './pages/Tracks.jsx'
import Settings from './pages/Settings.jsx'
import MockInterview from './pages/MockInterview.jsx'
import { useAuth } from './lib/AuthContext.jsx'
import './App.css'

// Kept in sync with the same list in Settings.jsx — only these
// accounts see the Settings nav link at all (not just blocked from
// using the page, hidden entirely, since it's not relevant to anyone
// else).
const ADMIN_EMAILS = ['fromdevanshu@gmail.com']

/**
 * The app's overall shell: a top bar with the screens we have so far,
 * and whichever screen is currently selected shown underneath.
 * Login/signup and the one-time disclaimer live inside Home (Task
 * #10); Profile is your general bio (Phase 2); Tracks holds each
 * company/role you're preparing for with its own resume; Settings
 * (key vault) is Phase 1, admin-only.
 */
function App() {
  const { session, signOut } = useAuth()
  const isAdmin = session && ADMIN_EMAILS.includes(session.user.email)

  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="brand">PrepPilot</span>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          {session && <NavLink to="/profile">Profile</NavLink>}
          {session && <NavLink to="/tracks">Tracks</NavLink>}
          {isAdmin && <NavLink to="/settings">Settings</NavLink>}
          <NavLink to="/mock-interview">Mock Interview</NavLink>
          {session && (
            <button type="button" className="link-button" onClick={signOut}>
              Log out
            </button>
          )}
        </nav>
      </header>

      <main className="page-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/tracks" element={<Tracks />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/mock-interview" element={<MockInterview />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
