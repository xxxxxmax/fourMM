// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PancakeSwap V2 Router interface (subset)
/// @dev BSC mainnet: 0x10ED43C718714eb63d5aA57B78B54704E256024E
interface IPancakeRouter02 {
    function WETH() external pure returns (address);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);
}
