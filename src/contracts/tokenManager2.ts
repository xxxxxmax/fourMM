/**
 * viem ABI binding for TokenManager2.
 *
 * Only the methods fourMM trade commands need: buyTokenAMAP, sellToken, createToken.
 * Address is resolved at runtime via Helper3.getTokenInfo().tokenManager.
 */

export const tokenManager2Abi = [
  // ---- Buy ----
  {
    type: 'function',
    name: 'buyTokenAMAP',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'funds', type: 'uint256' },
      { name: 'minAmount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'buyTokenAMAP',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'funds', type: 'uint256' },
      { name: 'minAmount', type: 'uint256' },
    ],
    outputs: [],
  },
  // ---- Sell ----
  {
    type: 'function',
    name: 'sellToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  // ---- Create ----
  {
    type: 'function',
    name: 'createToken',
    stateMutability: 'payable',
    inputs: [
      { name: 'createArg', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  // ---- Events (for TxTracker / receipt parsing) ----
  {
    type: 'event',
    name: 'TokenCreate',
    inputs: [
      { name: 'creator', type: 'address', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      { name: 'requestId', type: 'uint256', indexed: false },
      { name: 'name', type: 'string', indexed: false },
      { name: 'symbol', type: 'string', indexed: false },
      { name: 'totalSupply', type: 'uint256', indexed: false },
      { name: 'launchTime', type: 'uint256', indexed: false },
      { name: 'launchFee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TokenPurchase',
    inputs: [
      { name: 'token', type: 'address', indexed: false },
      { name: 'account', type: 'address', indexed: false },
      { name: 'price', type: 'uint256', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'cost', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'offers', type: 'uint256', indexed: false },
      { name: 'funds', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TokenSale',
    inputs: [
      { name: 'token', type: 'address', indexed: false },
      { name: 'account', type: 'address', indexed: false },
      { name: 'price', type: 'uint256', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'cost', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'offers', type: 'uint256', indexed: false },
      { name: 'funds', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LiquidityAdded',
    inputs: [
      { name: 'base', type: 'address', indexed: false },
      { name: 'offers', type: 'uint256', indexed: false },
      { name: 'quote', type: 'address', indexed: false },
      { name: 'funds', type: 'uint256', indexed: false },
    ],
  },
] as const
