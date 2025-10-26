import React, { useState, useEffect } from 'react';
import './Login.css';

interface LoginProps {
  onLoginSuccess: (userEmail: string) => void;
}

function Login({ onLoginSuccess }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    // Load theme preference
    const savedTheme = localStorage.getItem('lectra_theme') as 'light' | 'dark';
    if (savedTheme) {
      setTheme(savedTheme);
      applyTheme(savedTheme);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const initialTheme = prefersDark ? 'dark' : 'light';
      setTheme(initialTheme);
      applyTheme(initialTheme);
    }
  }, []);

  const applyTheme = (newTheme: 'light' | 'dark') => {
    if (newTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  };

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    applyTheme(newTheme);
    localStorage.setItem('lectra_theme', newTheme);
  };

  const handleLocalLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setTimeout(() => {
      if (email === 'admin' && password === 'admin123') {
        localStorage.setItem('lectra_user', JSON.stringify({ email, loginMethod: 'local' }));
        onLoginSuccess(email);
      } else {
        setError('❌ Invalid credentials. Use admin/admin123');
      }
      setLoading(false);
    }, 500);
  };

  return (
    <div className="login-container">
      <button onClick={toggleTheme} className="theme-toggle-login" title="Toggle theme">
        {theme === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode'}
      </button>
      
      <div className="login-box">
        <div className="login-header">
          <h1>🎓 Lectra Capture</h1>
          <p className="login-subtitle">AI-Powered Classroom Lecture Note Generator</p>
        </div>

        <form onSubmit={handleLocalLogin} className="login-form">
          <h2>Login</h2>

          <div className="form-group">
            <label htmlFor="email">Username or Email</label>
            <input
              id="email"
              type="text"
              placeholder="admin"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="form-input"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="form-input"
                required
              />
              <button
                type="button"
                className="toggle-password"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" disabled={loading} className="btn-login">
            {loading ? '⏳ Logging in...' : '🔓 Login'}
          </button>
        </form>

        <div className="login-info">
          <p>
            <strong>Demo Credentials:</strong>
          </p>
          <p>
            Username: <code>admin</code>
          </p>
          <p>
            Password: <code>admin123</code>
          </p>
        </div>

        <div className="auth0-badge">
          <p className="powered-by">Secured with</p>
          <p className="auth0-text">🔒 Local Authentication + Auth0 Ready</p>
        </div>
      </div>
    </div>
  );
}

export default Login;