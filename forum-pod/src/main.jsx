import React from 'react'
import ReactDOM from 'react-dom/client'
import PodlinkApp from './app.jsx'
import './pwa-install.js'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PodlinkApp />
  </React.StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`)
      .catch((err) => console.warn('Service worker registration failed:', err))
  })
}
