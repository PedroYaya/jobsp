import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { jobspUiPlugin } from './vite-plugin-jobsp-ui.js'

export default defineConfig({
  plugins: [vue(), jobspUiPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
