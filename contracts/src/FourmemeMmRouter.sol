// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {ITokenManager2} from "./interfaces/ITokenManager2.sol";
import {ITokenManagerHelper3} from "./interfaces/ITokenManagerHelper3.sol";
import {IPancakeRouter02} from "./interfaces/IPancakeRouter02.sol";

/// @title FourmemeMmRouter v2 — Atomic market-making router for Four.meme on BSC
/// @author fourMM (Four.meme Market Maker)
/// @notice Stateless pass-through that bundles buy + sell into a single atomic
///         transaction. No admin, no fees. Single bool for reentrancy guard.
///
/// v2 changes vs v1 (0x5A3A9981...):
///   - Reentrancy guard on all external functions
///   - Reset ERC20 approval to 0 after sell in volume()
///   - volumePancake uses swapExactTokensForETHSupportingFeeOnTransferTokens
///     for compatibility with fee-on-transfer graduated tokens
contract FourmemeMmRouter {
    // ================================================================
    // State (minimal — just the reentrancy lock)
    // ================================================================

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "ReentrancyGuard: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    // ================================================================
    // Immutables
    // ================================================================

    ITokenManagerHelper3 public immutable HELPER;
    IPancakeRouter02 public immutable PANCAKE_ROUTER;

    // ================================================================
    // Errors
    // ================================================================

    error InsufficientTokensOut(uint256 got, uint256 minExpected);
    error InsufficientBnbBack(uint256 got, uint256 minExpected);
    error TokenNotOnBondingCurve();
    error TokenNotGraduated();
    error ZeroAmount();
    error BnbRefundFailed();

    // ================================================================
    // Constructor
    // ================================================================

    constructor(address _helper, address _pancakeRouter) {
        HELPER = ITokenManagerHelper3(_helper);
        PANCAKE_ROUTER = IPancakeRouter02(_pancakeRouter);
    }

    // ================================================================
    // volume() — atomic round-trip on bonding curve
    // ================================================================

    function volume(
        address token,
        uint256 minTokenOut,
        uint256 minBnbBack
    ) external payable nonReentrant returns (uint256 tokenBought, uint256 bnbBack) {
        if (msg.value == 0) revert ZeroAmount();

        (, address mgr,,,,,,,,,, bool graduated) = HELPER.getTokenInfo(token);
        if (graduated) revert TokenNotOnBondingCurve();

        ITokenManager2 tm = ITokenManager2(mgr);

        // Buy
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        tm.buyTokenAMAP{value: msg.value}(token, address(this), msg.value, minTokenOut);
        tokenBought = IERC20(token).balanceOf(address(this)) - balBefore;

        if (tokenBought < minTokenOut) {
            revert InsufficientTokensOut(tokenBought, minTokenOut);
        }

        // Sell
        IERC20(token).approve(mgr, tokenBought);
        uint256 bnbBefore = address(this).balance;
        tm.sellToken(token, tokenBought);
        bnbBack = address(this).balance - bnbBefore;

        // Reset approval to 0 (hygiene — prevent dangling allowance)
        IERC20(token).approve(mgr, 0);

        if (bnbBack < minBnbBack) {
            revert InsufficientBnbBack(bnbBack, minBnbBack);
        }

        _refundBnb(msg.sender);
    }

    // ================================================================
    // turnover() — buy and forward tokens to a recipient
    // ================================================================

    function turnover(
        address token,
        address recipient,
        uint256 minTokenOut
    ) external payable nonReentrant returns (uint256 tokenBought) {
        if (msg.value == 0) revert ZeroAmount();

        (, address mgr,,,,,,,,,, bool graduated) = HELPER.getTokenInfo(token);
        if (graduated) revert TokenNotOnBondingCurve();

        ITokenManager2 tm = ITokenManager2(mgr);

        // Buy directly to recipient (Four.meme tokens use MODE_TRANSFER_RESTRICTED
        // during bonding curve — only TokenManager2 can move tokens via buy/sell)
        uint256 balBefore = IERC20(token).balanceOf(recipient);
        tm.buyTokenAMAP{value: msg.value}(token, recipient, msg.value, minTokenOut);
        tokenBought = IERC20(token).balanceOf(recipient) - balBefore;

        if (tokenBought < minTokenOut) {
            revert InsufficientTokensOut(tokenBought, minTokenOut);
        }

        _refundBnb(msg.sender);
    }

    // ================================================================
    // volumePancake() — atomic round-trip on PancakeSwap (graduated)
    // ================================================================

    function volumePancake(
        address token,
        uint256 minTokenOut,
        uint256 minBnbBack
    ) external payable nonReentrant returns (uint256 tokenBought, uint256 bnbBack) {
        if (msg.value == 0) revert ZeroAmount();

        (,,,,,,,,,,, bool graduated) = HELPER.getTokenInfo(token);
        if (!graduated) revert TokenNotGraduated();

        address wbnb = PANCAKE_ROUTER.WETH();

        // Buy leg: BNB → token
        address[] memory buyPath = new address[](2);
        buyPath[0] = wbnb;
        buyPath[1] = token;

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        PANCAKE_ROUTER.swapExactETHForTokens{value: msg.value}(
            minTokenOut,
            buyPath,
            address(this),
            block.timestamp
        );
        tokenBought = IERC20(token).balanceOf(address(this)) - balBefore;

        // Sell leg: token → BNB
        // Use SupportingFeeOnTransferTokens variant for compatibility with
        // graduated tokens that may have fee-on-transfer mechanics (e.g.
        // anti-sniper-fee tokens post-graduation).
        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = wbnb;

        IERC20(token).approve(address(PANCAKE_ROUTER), tokenBought);
        uint256 bnbBefore = address(this).balance;
        // Note: swapExactTokensForETHSupportingFeeOnTransferTokens does NOT
        // return amounts (void), so we measure bnbBack via balance delta.
        IPancakeRouter02(address(PANCAKE_ROUTER)).swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokenBought,
            minBnbBack,
            sellPath,
            address(this),
            block.timestamp
        );
        bnbBack = address(this).balance - bnbBefore;

        // Reset approval
        IERC20(token).approve(address(PANCAKE_ROUTER), 0);

        _refundBnb(msg.sender);
    }

    // ================================================================
    // Internal
    // ================================================================

    function _refundBnb(address to) internal {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = to.call{value: bal}("");
            if (!ok) revert BnbRefundFailed();
        }
    }

    /// @dev Accept BNB from TokenManager2.sellToken refunds and
    ///      PancakeSwap WETH unwrapping. Restricted to known senders
    ///      would be ideal but is impractical given dynamic TokenManager
    ///      addresses. Documenting: BNB sent directly to this contract
    ///      (outside of volume/turnover/volumePancake calls) is
    ///      unrecoverable. Do NOT send BNB to this address manually.
    receive() external payable {}
}
