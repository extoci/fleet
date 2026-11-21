import { defineConfig } from 'vite'
import { holocron } from '@holocron.so/vite'

export default defineConfig({
  plugins: [holocron({ pagesDir: './pages' })],
  build: { reportCompressedSize: false },
  environments: {
    // Spiceflow's dependency tracer misses Rolldown's __require('scheduler').
    ssr: { resolve: { noExternal: ['scheduler'] } },
  },
})
