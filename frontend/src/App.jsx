import { NavLink, Route, Routes } from 'react-router-dom'
import Home from './pages/Home.jsx'
import MockInterview from './pages/MockInterview.jsx'
import { useAuth } from './lib/AuthContext.jsx'
import './App.css'

/**
 * The app's overall shell: a top bar with the two screens we have so
 * far (Home, Mock Interview), and whichever screen is currently
 * selected shown underneath. Real interview logic isn't built yet —
 * this is just the skeleton it will live in. Login/signup and the
 * one-time disclaimer now live inside the Home screen (see Task #10).
 */
function App() {
  const { session, signOut } = useAuth()

  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="brand">PrepPilot</span>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
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
          <Route path="/mock-interview" element={<MockInterview />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
