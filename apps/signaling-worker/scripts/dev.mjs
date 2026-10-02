#!/usr/bin/env node
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const wranglerArgs = ['dev']

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--host') {
    const next = args[i + 1]
    if (next && !next.startsWith('-')) {
      // Forward valid wrangler `--host <domain>`
      wranglerArgs.push('--host', next)
      i++
    } else {
      // Map bare Vite-style `--host` to wrangler's `--ip 0.0.0.0`
      wranglerArgs.push('--ip', '0.0.0.0')
    }
  } else {
    wranglerArgs.push(arg)
  }
}

const child = spawn('wrangler', wranglerArgs, {
  stdio: 'inherit',
})

process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
