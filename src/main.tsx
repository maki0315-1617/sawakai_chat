import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  ;(window as unknown as { __installPrompt?: Event }).__installPrompt = event
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const registerWorker = () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
      })
      .catch((error) => console.error('Service worker registration failed', error))
  }
  if (document.readyState === 'complete') registerWorker()
  else window.addEventListener('load', registerWorker)
}
