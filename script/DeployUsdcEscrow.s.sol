// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {UsdcEscrow} from "../src/UsdcEscrow.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";

/// Usage:
///   VERIFIER=0x... OWNER=0x... forge script script/DeployUsdcEscrow.s.sol \
///     --rpc-url https://mainnet.base.org --broadcast --account <keystore> --verify
/// USDC_ADDRESS overrides the per-chain default.
contract DeployUsdcEscrow is Script {
    function run() external returns (UsdcEscrow escrow) {
        address usdc = vm.envOr("USDC_ADDRESS", defaultUsdc(block.chainid));
        address verifier = vm.envAddress("VERIFIER");
        address owner = vm.envAddress("OWNER");

        vm.startBroadcast();
        escrow = new UsdcEscrow(IUSDC(usdc), verifier, owner);
        vm.stopBroadcast();

        console.log("UsdcEscrow deployed at", address(escrow));
        console.log("USDC:", usdc);
        console.log("Verifier:", verifier);
        console.log("Owner:", owner);
    }

    function defaultUsdc(uint256 chainId) internal pure returns (address) {
        if (chainId == 8453) return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base
        if (chainId == 84532) return 0x036CbD53842c5426634e7929541eC2318f3dCF7e; // Base Sepolia
        revert("Unsupported chain: set USDC_ADDRESS");
    }
}
