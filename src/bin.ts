#!/usr/bin/env node
/**
 * fourMM CLI entry point.
 *
 * Force exit after serve() resolves so fire-and-forget background tasks
 * (trackInBackground) don't keep the process alive for 30+ seconds.
 */

import { cli } from './cli.js'

cli.serve().then(() => {
  // Give background tasks 2s grace period to flush DataStore writes,
  // then exit regardless of pending HTTP handles.
  setTimeout(() => process.exit(0), 2_000).unref()
})

