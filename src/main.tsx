import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import { ThemeProvider } from "next-themes"
import { TRPCProvider } from "@/providers/trpc"
import { LanguageProvider } from "@/i18n"
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* attribute="class" drives the `.dark` block index.css already defines.
        Default is the operating system's setting, which is what a control room
        on a wall panel and a laptop in daylight each want without being asked. */}
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="volttrade-theme">
      <BrowserRouter>
        <TRPCProvider>
          <LanguageProvider>
            <App />
          </LanguageProvider>
        </TRPCProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
