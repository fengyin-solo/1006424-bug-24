import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'

const srcRoot = process.env.SMOKE_OUT || '/tmp/tscout'

function tryFile(basePath) {
  const candidates = [
    basePath,
    basePath + '.js',
    path.join(basePath, 'index.js'),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const resolved = tryFile(path.join(srcRoot, specifier.slice(2)))
    if (resolved) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true }
    }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const parent = new URL(context.parentURL).pathname
    const resolved = tryFile(path.resolve(path.dirname(parent), specifier))
    if (resolved) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
