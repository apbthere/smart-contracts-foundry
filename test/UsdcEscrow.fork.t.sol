// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {UsdcEscrow} from "../src/UsdcEscrow.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";
import {EscrowTestBase} from "./EscrowTestBase.sol";

interface IFiatTokenDomain {
    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Runs against Circle's real USDC on a Base mainnet fork.
/// Skipped unless BASE_RPC_URL is set, e.g. `BASE_RPC_URL=https://mainnet.base.org forge test --mt Fork`.
contract UsdcEscrowForkTest is EscrowTestBase {
    IUSDC constant BASE_USDC = IUSDC(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);

    function setUp() public override {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);

        (buyer, buyerKey) = makeAddrAndKey("buyer");
        (verifier, verifierKey) = makeAddrAndKey("verifier");
        escrow = new UsdcEscrow(BASE_USDC, verifier, owner);
        deal(address(BASE_USDC), buyer, 10_000e6);
    }

    function testForkAuthorizationFundingAndVerdict() public {
        UsdcEscrow.Terms memory t = _terms(0);
        bytes32 id = escrow.computeEscrowId(buyer, t);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 domain = IFiatTokenDomain(address(BASE_USDC)).DOMAIN_SEPARATOR();
        bytes memory authSig = _signAuthorization(domain, buyerKey, buyer, address(escrow), AMOUNT, 0, validBefore, id);

        vm.prank(stranger);
        escrow.createEscrowWithAuthorization(buyer, t, 0, validBefore, authSig);
        assertEq(BASE_USDC.balanceOf(address(escrow)), AMOUNT);
        assertTrue(BASE_USDC.authorizationState(buyer, id));

        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory verdictSig = _signVerdict(escrow, verifierKey, id, 700e6, expiry);
        escrow.executeVerdict(id, 700e6, expiry, verdictSig);

        assertEq(BASE_USDC.balanceOf(seller), 700e6);
        assertEq(BASE_USDC.balanceOf(refundTo), 300e6);
        assertEq(BASE_USDC.balanceOf(address(escrow)), 0);
    }

    function testForkExpiryRefundWithApproval() public {
        vm.prank(buyer);
        BASE_USDC.approve(address(escrow), AMOUNT);
        (bytes32 id, UsdcEscrow.Terms memory t) = _create();

        vm.warp(t.deadline + 1);
        vm.prank(stranger);
        escrow.refundExpired(id);
        assertEq(BASE_USDC.balanceOf(refundTo), AMOUNT);
    }
}
