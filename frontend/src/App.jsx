import { NavLink, Route, Routes } from 'react-router-dom'
import Home from './pages/Home.jsx'
import MockInterview from './pages/MockInterview.jsx'
import './App.css'

/**
 * The app's overall shell: a top bar with the two screens we have so
 * far (Home, Mock Interview), and whichever screen is currently
 * selected shown underneath. Login/signup and the real interview
 * logic aren't built yet — this is just the skeleton they'll live in.
 */
function App() {
  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="brand">PrepPilot</span>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/mock-interview">Mock Interview</NavLink>
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
