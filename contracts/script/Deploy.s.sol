// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {FourmemeMmRouter} from "../src/FourmemeMmRouter.sol";

/// @title Deploy FourmemeMmRouter to BSC mainnet
/// @notice Run:
///   forge script script/Deploy.s.sol --rpc-url $BSC_RPC_URL --broadcast --verify
///
/// Required env vars:
///   PRIVATE_KEY — deployer wallet private key (needs ~0.05 BNB for gas)
///   BSC_RPC_URL — BSC RPC endpoint
///   BSCSCAN_API_KEY — for --verify (optional but recommended)
contract DeployRouter is Script {
    // BSC mainnet addresses
    address constant HELPER3 = 0xF251F83e40a78868FcfA3FA4599Dad6494E46034;
    address constant PANCAKE_V2 = 0x10ED43C718714eb63d5aA57B78B54704E256024E;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        FourmemeMmRouter router = new FourmemeMmRouter(HELPER3, PANCAKE_V2);

        vm.stopBroadcast();

        console.log("FourmemeMmRouter deployed at:", address(router));
        console.log("  HELPER3:", HELPER3);
        console.log("  PANCAKE_V2:", PANCAKE_V2);
        console.log("");
        console.log("Next steps:");
        console.log("  1. Update src/lib/const.ts FOURMEME_MM_ROUTER with the address above");
        console.log("  2. Verify on BSCScan:");
        console.log("     forge verify-contract <address> FourmemeMmRouter --chain bsc");
    }
}
