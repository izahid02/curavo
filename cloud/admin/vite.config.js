import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The ARZ control panel.  `npm run build` writes dist/, which the cloud server
// (cloud/server/curavo_cloud/main.py) serves at /.  In development the panel
// runs on :5180 and forwards API calls to a local cloud server on :8100.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    port: 5180,
    proxy: { '/admin/api': { target: 'http://localhost:8100', changeOrigin: true } },
  },
})
