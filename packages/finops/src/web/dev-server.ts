import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(dirname, '../..')
const outDir = path.join(packageRoot, 'dist/web')
const host = argValue('--host') ?? process.env.HOST ?? '127.0.0.1'
const port = Number(argValue('--port') ?? process.env.PORT ?? 4173)

await buildWeb()

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`)
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname
  const filePath = safeJoin(outDir, pathname)

  if (!filePath) {
    response.writeHead(404).end('Not found')
    return
  }

  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) {
      response.writeHead(404).end('Not found')
      return
    }
    response.writeHead(200, { 'Content-Type': contentType(filePath) })
    createReadStream(filePath).pipe(response)
  } catch {
    response.writeHead(404).end('Not found')
  }
})

server.listen(port, host, () => {
  console.log(`wanman FinOps app: http://${host}:${port}/`)
})

async function buildWeb(): Promise<void> {
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })
  await build({
    entryPoints: [path.join(packageRoot, 'src/web/app.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    outfile: path.join(outDir, 'app.js'),
    sourcemap: true,
  })
  await fs.copyFile(path.join(packageRoot, 'src/web/index.html'), path.join(outDir, 'index.html'))
  await fs.copyFile(path.join(packageRoot, 'src/web/styles.css'), path.join(outDir, 'styles.css'))
  if (process.env.WANMAN_FINOPS_RUNTIME_DATA) {
    await fs.copyFile(process.env.WANMAN_FINOPS_RUNTIME_DATA, path.join(outDir, 'runtime-data.json'))
  }
}

function safeJoin(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname)
  const resolved = path.resolve(root, `.${decoded}`)
  return resolved.startsWith(root) ? resolved : null
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.map':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
