import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-hot-toast')) return 'toast';
          if (id.includes('node_modules/socket.io-client')) return 'socket';
          if (id.includes('node_modules/recharts')) return 'recharts';
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react';
        },
      },
    },
  },
})