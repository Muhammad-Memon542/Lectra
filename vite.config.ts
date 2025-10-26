
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787'
    },
    host: true, // allow LAN access
    allowedHosts: [
      'teacher.lectra.work', // ✅ add your custom domain here
      'localhost',
    ],

  }
})
