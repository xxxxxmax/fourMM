/**
 * viem ABI binding for TokenManagerHelper3.
 *
 * Only the methods fourMM uses are declared here — we don't need the full ABI.
 *
 * Source: docs/API-Documents.03-03-2026.md §TokenManagerHelper3 (V3)
 * Address: 0xF251F83e40a78868FcfA3FA4599Dad6494E46034 (BSC mainnet)
 */

export const tokenManagerHelper3Abi = [
  {
    type: 'function',
    name: 'getTokenInfo',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'version', type: 'uint256' },
      { name: 'tokenManager', type: 'address' },
      { name: 'quote', type: 'address' },
      { name: 'lastPrice', type: 'uint256' },
      { name: 'tradingFeeRate', type: 'uint256' },
      { name: 'minTradingFee', type: 'uint256' },
      { name: 'launchTime', type: 'uint256' },
      { name: 'offers', type: 'uint256' },
      { name: 'maxOffers', type: 'uint256' },
      { name: 'funds', type: 'uint256' },
      { name: 'maxFunds', type: 'uint256' },
      { name: 'liquidityAdded', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'tryBuy',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'funds', type: 'uint256' },
    ],
    outputs: [
      { name: 'tokenManager', type: 'address' },
      { name: 'quote', type: 'address' },
      { name: 'estimatedAmount', type: 'uint256' },
      { name: 'estimatedCost', type: 'uint256' },
      { name: 'estimatedFee', type: 'uint256' },
      { name: 'amountMsgValue', type: 'uint256' },
      { name: 'amountApproval', type: 'uint256' },
      { name: 'amountFunds', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'trySell',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [
      { name: 'tokenManager', type: 'address' },
      { name: 'quote', type: 'address' },
      { name: 'funds', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
  },
] as const
