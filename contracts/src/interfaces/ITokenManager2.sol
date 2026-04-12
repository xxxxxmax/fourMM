// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Four.meme TokenManager V2 interface
/// @notice Only the methods FourmemeMmRouter needs to call.
/// @dev Addresses from docs/API-Documents: BSC 0x5c952063c7fc8610FFDB798152D69F0B9550762b
interface ITokenManager2 {
    /// @notice Buy tokens spending a specific amount of quote (BNB).
    /// @param token Token contract address
    /// @param funds Amount of BNB (wei) to spend
    /// @param minAmount Minimum tokens to receive (slippage guard)
    function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) external payable;

    /// @notice Buy tokens for a specific recipient.
    function buyTokenAMAP(address token, address to, uint256 funds, uint256 minAmount) external payable;

    /// @notice Sell tokens back to the bonding curve.
    /// @dev Caller must ERC20.approve(tokenManager, amount) first.
    /// @param token Token contract address
    /// @param amount Amount of tokens to sell
    function sellToken(address token, uint256 amount) external;

    /// @notice Create a new token on Four.meme.
    /// @param createArg Encoded creation parameters (from Four.meme REST API)
    /// @param signature Server-side signature authorizing creation
    function createToken(bytes calldata createArg, bytes calldata signature) external payable;
}
