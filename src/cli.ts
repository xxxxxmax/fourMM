/**
 * ALMM — Autonomous Liquidity Market Maker
 *
 * Root CLI definition. Command groups are mounted here.
 */

import { Cli } from 'incur'
import { config } from './commands/config.js'
import { ows } from './commands/ows.js'
import { query } from './commands/query.js'
import { token } from './commands/token.js'
import { tools } from './commands/tools.js'
import { trade } from './commands/trade.js'
import { transfer } from './commands/transfer.js'
import { wallet } from './commands/wallet.js'

export const cli = Cli.create('almm', {
  version: '0.1.0',
  description:
    'Autonomous Liquidity Market Maker — agent-first CLI for Four.meme market making on BSC.',
})
  .command(config)
  .command(ows)
  .command(wallet)
  .command(token)
  .command(query)
  .command(transfer)
  .command(trade)
  .command(tools)
