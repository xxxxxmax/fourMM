// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {FourmemeMmRouter} from "../src/FourmemeMmRouter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {ITokenManagerHelper3} from "../src/interfaces/ITokenManagerHelper3.sol";

/// @title FourmemeMmRouter fork tests
/// @notice Runs against a BSC mainnet fork. Requires BSC_RPC_URL env var.
///
/// Usage:
///   forge test --fork-url $BSC_RPC_URL -vvv
///
/// These tests use vm.deal to give the test contract BNB, then call the
/// router's functions against real Four.meme contracts on BSC.
contract FourmemeMmRouterTest is Test {
    // ---- BSC mainnet addresses ----
    address constant HELPER3 = 0xF251F83e40a78868FcfA3FA4599Dad6494E46034;
    address constant PANCAKE_V2 = 0x10ED43C718714eb63d5aA57B78B54704E256024E;

    FourmemeMmRouter router;

    function setUp() public {
        router = new FourmemeMmRouter(HELPER3, PANCAKE_V2);
        // Give the test contract 10 BNB
        vm.deal(address(this), 10 ether);
    }

    // ================================================================
    // Helpers
    // ================================================================

    /// @dev Find a live bonding-curve token from a recent TokenCreate event.
    ///      We hardcode a known active token for deterministic tests.
    ///      If this token graduates between test runs, update the address.
    function _findBondingCurveToken() internal view returns (address token) {
        // Use a recently created token (update if it graduates).
        // This one was found via scripts/find-recent-token.ts
        token = 0x3500e77E39E3566cE4d2D3D372b7DCeE6B7E4444;

        // Verify it's still on bonding curve
        (uint256 ver,,,,,,,,,,, bool grad) = ITokenManagerHelper3(HELPER3).getTokenInfo(token);
        require(ver > 0, "Token not found on Four.meme - update test address");
        require(!grad, "Token has graduated - update test address");
    }

    // ================================================================
    // volume() tests
    // ================================================================

    function test_volume_roundTrip() public {
        address token = _findBondingCurveToken();
        uint256 buyAmount = 0.005 ether; // small to minimize slippage

        // Record BNB before
        uint256 bnbBefore = address(this).balance;

        // Call volume: buy + sell in one tx
        (uint256 tokenBought, uint256 bnbBack) = router.volume{value: buyAmount}(
            token,
            0, // minTokenOut = 0 for testing (accept any)
            0  // minBnbBack = 0 for testing
        );

        // Should have bought some tokens
        assertGt(tokenBought, 0, "Should have bought tokens");

        // Should have gotten BNB back (minus bonding-curve spread + fee)
        assertGt(bnbBack, 0, "Should have gotten BNB back");

        // The router should hold zero tokens after
        assertEq(IERC20(token).balanceOf(address(router)), 0, "Router should hold zero tokens");

        // The router should hold zero BNB after
        assertEq(address(router).balance, 0, "Router should hold zero BNB");

        // Our net loss should be small (bonding curve spread + 1% fee × 2)
        uint256 totalBnbAfter = address(this).balance;
        uint256 loss = bnbBefore - totalBnbAfter;
        // Loss should be < 5% of the buy amount (generous bound)
        assertLt(loss, buyAmount * 5 / 100, "Loss too high - check fees");
    }

    function test_volume_revertsOnZeroValue() public {
        address token = _findBondingCurveToken();
        vm.expectRevert(FourmemeMmRouter.ZeroAmount.selector);
        router.volume{value: 0}(token, 0, 0);
    }

    function test_volume_slippageRevert() public {
        address token = _findBondingCurveToken();
        // Set impossibly high minTokenOut
        vm.expectRevert();
        router.volume{value: 0.001 ether}(
            token,
            type(uint256).max, // impossible min
            0
        );
    }

    // ================================================================
    // turnover() tests
    // ================================================================

    function test_turnover_tokensGoToRecipient() public {
        address token = _findBondingCurveToken();
        address recipient = makeAddr("recipient");

        uint256 tokenBought = router.turnover{value: 0.005 ether}(
            token,
            recipient,
            0 // minTokenOut = 0 for testing
        );

        assertGt(tokenBought, 0, "Should have bought tokens");

        // Tokens should be in recipient's wallet, NOT the router
        assertEq(
            IERC20(token).balanceOf(recipient),
            tokenBought,
            "Recipient should hold all bought tokens"
        );
        assertEq(
            IERC20(token).balanceOf(address(router)),
            0,
            "Router should hold zero tokens"
        );
        assertEq(address(router).balance, 0, "Router should hold zero BNB");
    }

    function test_turnover_revertsOnZeroValue() public {
        address token = _findBondingCurveToken();
        vm.expectRevert(FourmemeMmRouter.ZeroAmount.selector);
        router.turnover{value: 0}(token, makeAddr("r"), 0);
    }

    // ================================================================
    // volumePancake() tests — skipped when no graduated token available
    // ================================================================

    // Note: PancakeSwap volume tests require a known graduated Four.meme
    // token with active liquidity. Since graduation is non-deterministic,
    // this test is marked as a manual check — uncomment when you have
    // a suitable token address.
    //
    // function test_volumePancake_roundTrip() public {
    //     address token = ...; // graduated Four.meme token
    //     (uint256 bought, uint256 back) = router.volumePancake{value: 0.005 ether}(
    //         token, 0, 0
    //     );
    //     assertGt(bought, 0);
    //     assertGt(back, 0);
    // }

    function test_volumePancake_revertsOnBondingCurve() public {
        address token = _findBondingCurveToken();
        vm.expectRevert(FourmemeMmRouter.TokenNotGraduated.selector);
        router.volumePancake{value: 0.005 ether}(token, 0, 0);
    }

    // ================================================================
    // Accept BNB so refunds work in tests
    // ================================================================

    receive() external payable {}
}
