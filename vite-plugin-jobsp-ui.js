import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(fileURLToPath(new URL(import.meta.url)))

let scanChild = null
let scanStarting = false

function scanProcessRunning() {
  if (!scanChild) return false
  return scanChild.exitCode === null && scanChild.signalCode === null
}

function isLocalhost(req) {
  const a = req.socket?.remoteAddress || ''
  return (
    a === '127.0.0.1' ||
    a === '::1' ||
    a === '::ffff:127.0.0.1' ||
    a.endsWith('127.0.0.1')
  )
}

function setupMiddleware(server) {
  server.middlewares.use((req, res, next) => {
    if (req.method !== 'POST') {
      return next()
    }

    if (req.url === '/__jobsp/api/reset-scan') {
      if (!isLocalhost(req)) {
        res.statusCode = 403
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'Solo localhost' }))
        return
      }
      ;(async () => {
        const gen = path.join(projectRoot, 'public', 'generated')
        await rm(gen, { recursive: true, force: true })
        await mkdir(gen, { recursive: true })
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            ok: true,
            message: 'Resultados borrados (public/generated). Podés correr un scan nuevo.',
          }),
        )
      })().catch((e) => {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
      })
      return
    }

    if (req.url === '/__jobsp/api/start-scan') {
      if (!isLocalhost(req)) {
        res.statusCode = 403
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'Solo localhost' }))
        return
      }
      if (scanProcessRunning() || scanStarting) {
        res.statusCode = 409
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: 'Ya hay un scan en curso.' }))
        return
      }
      scanStarting = true
      ;(async () => {
        try {
        const genDir = path.join(projectRoot, 'public', 'generated')
        await mkdir(genDir, { recursive: true })
        const liveLogPath = path.join(genDir, 'live-scan.log')
        const out = createWriteStream(liveLogPath, { flags: 'w' })
        const stamp = new Date().toISOString()
        out.write(`[jobsp-ui] Log en vivo — scan iniciado ${stamp}\n\n`)

        const scriptPath = path.join(projectRoot, 'scripts', 'scan.mjs')
        const child = spawn(process.execPath, [scriptPath], {
          cwd: projectRoot,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        scanChild = child

        let logEnded = false
        function endOut(code, signal) {
          if (logEnded) return
          logEnded = true
          try {
            out.write(
              `\n\n--- fin proceso ${new Date().toISOString()} (código ${code ?? '?'}${signal ? ` · señal ${signal}` : ''}) ---\n`,
            )
            out.end()
          } catch {
            try {
              out.end()
            } catch {
              /* noop */
            }
          }
        }

        child.stdout.on('data', (chunk) => {
          try {
            out.write(chunk)
          } catch {
            /* noop */
          }
        })
        child.stderr.on('data', (chunk) => {
          try {
            out.write(chunk)
          } catch {
            /* noop */
          }
        })
        child.on('close', (code, signal) => {
          if (scanChild === child) scanChild = null
          endOut(code, signal)
        })
        child.on('error', (err) => {
          console.error('[jobsp-ui] scan spawn error:', err)
          if (scanChild === child) scanChild = null
          try {
            out.write(`\n[jobsp-ui] Error al arrancar: ${String(err.message || err)}\n`)
          } catch {
            /* noop */
          }
          endOut(null, null)
        })

        res.statusCode = 202
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            ok: true,
            message:
              'Scan arrancó en segundo plano. La salida de consola se va escribiendo abajo en «Log en vivo».',
          }),
        )
        } finally {
          scanStarting = false
        }
      })().catch((e) => {
        scanStarting = false
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
      })
      return
    }

    next()
  })
}

export function jobspUiPlugin() {
  return {
    name: 'jobsp-ui',
    configureServer(server) {
      setupMiddleware(server)
    },
    configurePreviewServer(server) {
      setupMiddleware(server)
    },
  }
}
