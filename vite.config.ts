import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

/**
 * Microsoft Entra only accepts redirect URIs served over HTTPS (the sole
 * exception being the literal `http://localhost`), so the dev server speaks
 * HTTPS by default. That keeps the registered redirect URI identical in
 * development and production.
 *
 * Certificates, in order of preference:
 *  1. `certs/localhost.pem` + `certs/localhost-key.pem` — generate these with
 *     mkcert for a locally-trusted cert and no browser warning.
 *  2. Otherwise an auto-generated self-signed cert, which works fine but makes
 *     the browser ask you to accept it once.
 *
 * Set `HTTPS=0` to fall back to plain HTTP (used by the test suite).
 */
/**
 * Where the app will be served from. Defaults to the root of an origin; set
 * `BASE_PATH=/nextwise/` to build for a subfolder of an existing site. It has
 * to be baked in at build time because it rewrites every asset URL, and it is
 * also what `appUrl()` reads to work out the OAuth redirect URI. Leading and
 * trailing slashes are enforced, since Vite silently misbehaves without them.
 */
const basePath = (() => {
  const raw = process.env.BASE_PATH?.trim()
  if (!raw || raw === '/') return '/'
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`
})()

const httpsDisabled = process.env.HTTPS === '0'
const certPath = new URL('./certs/localhost.pem', import.meta.url)
const keyPath = new URL('./certs/localhost-key.pem', import.meta.url)
const hasLocalCert = existsSync(certPath) && existsSync(keyPath)

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    // basic-ssl only needs to step in when there is no mkcert pair to use.
    ...(!httpsDisabled && !hasLocalCert ? [basicSsl()] : []),
  ],
  server: {
    port: 5173,
    // Fail loudly instead of silently moving to another port: the port is part
    // of the redirect URI registered in Entra, so a silent change breaks auth.
    strictPort: true,
    https:
      !httpsDisabled && hasLocalCert
        ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
        : undefined,
  },
  preview: {
    port: 4178,
    strictPort: true,
  },
})
