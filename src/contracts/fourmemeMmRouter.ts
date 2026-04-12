/**
 * viem ABI binding for FourmemeMmRouter.
 *
 * 3 functions (createAndDevBuy dropped — see Router contract comments).
 * Address is set via const.ts FOURMEME_MM_ROUTER after deployment.
 */

export const fourmemeMmRouterAbi = [
  {
    type: 'function',
    name: 'volume',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'minTokenOut', type: 'uint256' },
      { name: 'minBnbBack', type: 'uint256' },
    ],
    outputs: [
      { name: 'tokenBought', type: 'uint256' },
      { name: 'bnbBack', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'turnover',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'minTokenOut', type: 'uint256' },
    ],
    outputs: [{ name: 'tokenBought', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'volumePancake',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'minTokenOut', type: 'uint256' },
      { name: 'minBnbBack', type: 'uint256' },
    ],
    outputs: [
      { name: 'tokenBought', type: 'uint256' },
      { name: 'bnbBack', type: 'uint256' },
    ],
  },
] as const
