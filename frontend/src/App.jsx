import { NavLink, Route, Routes } from 'react-router-dom'
import Home from './pages/Home.jsx'
import Profile from './pages/Profile.jsx'
import Tracks from './pages/Tracks.jsx'
import Settings from './pages/Settings.jsx'
import MockInterview from './pages/MockInterview.jsx'
import LiveCopilot from './pages/LiveCopilot.jsx'
import { useAuth } from './lib/AuthContext.jsx'
import { ADMIN_EMAILS } from './lib/admin.js'
import RenderStatusBanner from './components/RenderStatusBanner.jsx'
import './App.css'

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
      <RenderStatusBanner />
      <header className="top-bar">
        <span className="brand">PrepPilot</span>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          {session && <NavLink to="/profile">Profile</NavLink>}
          {session && <NavLink to="/tracks">Tracks</NavLink>}
          {isAdmin && <NavLink to="/settings">Settings</NavLink>}
          {session && <NavLink to="/mock-interview">Mock Interview</NavLink>}
          {session && <NavLink to="/live-copilot">Live Copilot</NavLink>}
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
          <Route path="/live-copilot" element={<LiveCopilot />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
