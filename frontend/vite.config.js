import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite is the tool that runs the React dev server and builds the app.
export default defineConfig({
  plugins: [react()],
  build: {
    // Production build output goes here; FastAPI serves this folder directly.
    outDir: 'dist',
  },
  server: {
    port: 5173,
    // Forward any request starting with /api to the FastAPI backend,
    // so the frontend and backend feel like one system during development.
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
})
