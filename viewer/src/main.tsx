import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { BrowserRouter, Routes, Route } from 'react-router'
import { GoogleFonts } from 'tapestry-core-client/src/components/lib/icon'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GoogleFonts />
    <BrowserRouter>
      <Routes>
        {/* Match any path so the viewer also works when served from a sub-directory
            (e.g. embedded in a WordPress plugin at /wp-content/plugins/.../viewer/). */}
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
