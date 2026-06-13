import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

function vendorChunkName(id: string): string | null {
  if (!id.includes('node_modules')) return null
  if (id.includes('react-dom') || /node_modules\/react\//.test(id) || id.includes('scheduler')) return 'vendor-react'
  if (id.includes('lucide-react')) return 'vendor-icons'
  if (id.includes('dompurify') || id.includes('marked') || id.includes('highlight.js') || id.includes('katex')) return 'vendor-md'
  if (id.includes('mermaid') || id.includes('@mermaid-js') || id.includes('cytoscape') || id.includes('d3-') || id.includes('dagre') || id.includes('elkjs') || id.includes('khroma') || id.includes('roughjs') || id.includes('langium') || id.includes('chevrotain') || id.includes('lodash-es') || id.includes('dayjs')) return 'vendor-diagrams'
  if (id.includes('jsqr')) return 'vendor-qr'
  if (id.includes('@paper-design') || id.includes('three') || id.includes('shaders')) return 'vendor-shaders'
  if (id.includes('@bufbuild')) return 'vendor-protobuf'
  if (id.includes('jose')) return 'vendor-jose'
  if (id.includes('@elevenlabs') || id.includes('livekit-client') || id.includes('@livekit')) return 'vendor-voice'
  return 'vendor'
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8890',
      '/ws': { target: 'ws://localhost:8890', ws: true },
      '/uploads': 'http://localhost:8890',
    },
  },
  // SPA fallback: /mobile → index.html (Vite handles this for / but not sub-paths)
  appType: 'spa',
  build: {
    // Alte Chunk-Dateien beim Build NICHT loeschen (Default waere true). Sonst
    // zieht ein Build dem gerade laufenden Frontend seine lazy-Chunks unter den
    // Fuessen weg: der naechste dynamische Import 404t, lazyWithRetry ruft
    // window.location.reload(), die WebSocket reisst ab und ein laufender Stream
    // bricht ab. Das sah aus wie staendige "Server-Neustarts", war aber der
    // eigene Build. Mit false ueberleben alte Hashes, aktive Sessions laufen
    // weiter. Verwaiste Alt-Chunks raeumt scripts/prune-dist-assets.sh (>24h).
    emptyOutDir: false,
    // Smart-TV-Browser (Samsung Tizen, ~Chromium 69+) parsen kein optional
    // chaining / nullish coalescing — es2019 transpiliert das weg, damit der
    // Deck-Monitor auf dem TV überhaupt lädt. Moderne Browser kostet es nichts.
    target: 'es2019',
    // Remove crossorigin attribute — breaks loading behind Tailscale proxy
    modulePreload: false,
    rollupOptions: {
      output: {
        // Rolldown sammelt bei manualChunks sonst gemeinsame Runtime-Helper in
        // den ersten großen Vendor-Chunk ein. Dann lädt /mobile versehentlich
        // Mermaid. CodeSplitting mit nicht-rekursiven Gruppen hält Helper klein.
        strictExecutionOrder: true,
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [{
            name: (id: string) => vendorChunkName(id) || 'app',
            test: (id: string) => id.includes('node_modules'),
          }],
        },
      },
    },
  },
  html: {
    cspNonce: undefined,
  },
})
