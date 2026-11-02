import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { PharmacyProvider } from './lib/pharmacy.jsx'
import './styles/global.css'
import './styles/print.css'
import { installErrorReporter } from './lib/errorReporter'

// Screen crashes are reported to ARZ (see lib/errorReporter.js).
installErrorReporter();

// This is where React "starts" and attaches to the page.
//
// PharmacyProvider sits OUTSIDE the router on purpose: the shop's name is shown
// on the login screen too, which is not inside the app shell, and loading it
// once here means every screen reads the same values.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PharmacyProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PharmacyProvider>
  </React.StrictMode>
)
