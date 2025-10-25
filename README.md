
# Lectra Capture Demo (VS Code / macOS)

This is a tiny Vite + React (TypeScript) app with a mock Express API so you can test
camera/mic capture and chunked uploads locally on macOS with VS Code.

## Requirements
- Node 18+ (macOS): `node -v`
- VS Code (or any editor)
- Camera + Microphone permissions granted to your browser

## Quick Start
```bash
cd lectra-capture-demo
npm install
npm run start:all
```
- API: http://localhost:8787
- Web: http://localhost:5173 (proxy `/api` → API)

## Notes
- The mock API stores chunks under your system temp dir and simply reports how many it got on finalize.
- The front-end avoids accessing `process` at runtime; it uses layered fallbacks for API base resolution.
- To run the tiny resolver tests in the browser console:
  ```js
  window.__LECTRA_RUN_TESTS__ = true
  location.reload()
  ```

## Troubleshooting
- If the preview stays black on Safari, click once in the page to give a user gesture, then Start.
- If you run the API elsewhere, set a meta tag in index.html:
  ```html
  <meta name="lectra-api-base" content="https://api.your.app">
  ```
  Or set `window.__LECTRA_API_BASE__` in the console before the app mounts.
