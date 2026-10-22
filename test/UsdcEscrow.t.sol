// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {UsdcEscrow} from "../src/UsdcEscrow.sol";
import {VerdictVerifier} from "../src/VerdictVerifier.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";
import {MockSmartAccount} from "./mocks/MockSmartAccount.sol";
import {EscrowTestBase} from "./EscrowTestBase.sol";

contract UsdcEscrowTest is EscrowTestBase {
    // ---------------------------------------------------------------------
    // Deployment
    // ---------------------------------------------------------------------

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(UsdcEscrow.ZeroAddress.selector);
        new UsdcEscrow(IUSDC(address(0)), verifier, owner);

        vm.expectRevert(UsdcEscrow.ZeroAddress.selector);
        new UsdcEscrow(IUSDC(address(usdc)), address(0), owner);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new UsdcEscrow(IUSDC(address(usdc)), verifier, address(0));
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    function testCreateWithApproval() public {
        (bytes32 id, UsdcEscrow.Terms memory t) = _create();

        assertEq(id, escrow.computeEscrowId(buyer, t));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);

        UsdcEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(e.buyer, buyer);
        assertEq(e.seller, seller);
        assertEq(e.refundTo, refundTo);
        assertEq(e.verifier, verifier);
        assertEq(e.amount, AMOUNT);
        assertEq(e.deadline, t.deadline);
        assertEq(uint8(e.status), uint8(UsdcEscrow.Status.Funded));
    }

    function testCreateRevertsOnBadTerms() public {
        UsdcEscrow.Terms memory t;
        vm.startPrank(buyer);

        t = _terms(0);
        t.seller = address(0);
        vm.expectRevert(UsdcEscrow.ZeroAddress.selector);
        escrow.createEscrow(t);

        t = _terms(0);
        t.refundTo = address(0);
        vm.expectRevert(UsdcEscrow.ZeroAddress.selector);
        escrow.createEscrow(t);

        t = _terms(0);
        t.seller = buyer;
        vm.expectRevert(UsdcEscrow.InvalidParties.selector);
        escrow.createEscrow(t);

        t = _terms(0);
        t.refundTo = seller;
        vm.expectRevert(UsdcEscrow.InvalidParties.selector);
        escrow.createEscrow(t);

        t = _terms(0);
        t.verifier = stranger;
        vm.expectRevert(UsdcEscrow.WrongVerifier.selector);
        escrow.createEscrow(t);

        t = _terms(0);
        t.amount = 0;
        vm.expectRevert(UsdcEscrow.ZeroAmount.selector);
        escrow.createEscrow(t);

        t = _terms(0);
        t.deadline = uint64(block.timestamp);
        vm.expectRevert(UsdcEscrow.DeadlineInPast.selector);
        escrow.createEscrow(t);

        vm.stopPrank();
    }

    function testDuplicateTermsNeedNewSalt() public {
        (, UsdcEscrow.Terms memory t) = _create();
        vm.startPrank(buyer);
        vm.expectRevert(UsdcEscrow.EscrowExists.selector);
        escrow.createEscrow(t);
        t.salt = bytes32(uint256(1));
        escrow.createEscrow(t);
        vm.stopPrank();
    }

    function testFeeOnTransferRejected() public {
        usdc.setTransferFee(1e6);
        UsdcEscrow.Terms memory t = _terms(0);

        vm.prank(buyer);
        vm.expectRevert(UsdcEscrow.UnexpectedAmountReceived.selector);
        escrow.createEscrow(t);

        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signAuthorization(
            usdc.DOMAIN_SEPARATOR(),
            buyerKey,
            buyer,
            address(escrow),
            AMOUNT,
            0,
            validBefore,
            escrow.computeEscrowId(buyer, t)
        );
        vm.expectRevert(UsdcEscrow.UnexpectedAmountReceived.selector);
        escrow.createEscrowWithAuthorization(buyer, t, 0, validBefore, sig);
    }

    function testCreateWithAuthorizationByRelayer() public {
        UsdcEscrow.Terms memory t = _terms(0);
        bytes32 id = escrow.computeEscrowId(buyer, t);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig =
            _signAuthorization(usdc.DOMAIN_SEPARATOR(), buyerKey, buyer, address(escrow), AMOUNT, 0, validBefore, id);

        vm.prank(buyer);
        usdc.approve(address(escrow), 0); // prove no approval is needed

        vm.prank(stranger);
        assertEq(escrow.createEscrowWithAuthorization(buyer, t, 0, validBefore, sig), id);

        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(escrow.getEscrow(id).buyer, buyer);
        assertTrue(usdc.authorizationState(buyer, id));
    }

    function testAuthorizationCannotBeRetargeted() public {
        UsdcEscrow.Terms memory t = _terms(0);
        bytes32 id = escrow.computeEscrowId(buyer, t);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig =
            _signAuthorization(usdc.DOMAIN_SEPARATOR(), buyerKey, buyer, address(escrow), AMOUNT, 0, validBefore, id);

        // A relayer swapping in their own seller changes the id, so the nonce no longer matches.
        t.seller = stranger;
        vm.prank(stranger);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.createEscrowWithAuthorization(buyer, t, 0, validBefore, sig);
    }

    function testSmartAccountFundsWithAuthorization() public {
        // An agent's smart account (ERC-1271) signs via its session/owner key; a bundler submits.
        (address agentKeyAddr, uint256 agentKey) = makeAddrAndKey("agentSessionKey");
        MockSmartAccount agent = new MockSmartAccount(agentKeyAddr);
        usdc.mint(address(agent), AMOUNT);

        UsdcEscrow.Terms memory t = _terms(0);
        bytes32 id = escrow.computeEscrowId(address(agent), t);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signAuthorization(
            usdc.DOMAIN_SEPARATOR(), agentKey, address(agent), address(escrow), AMOUNT, 0, validBefore, id
        );

        vm.prank(stranger);
        escrow.createEscrowWithAuthorization(address(agent), t, 0, validBefore, sig);

        assertEq(usdc.balanceOf(address(agent)), 0);
        assertEq(escrow.getEscrow(id).buyer, address(agent));
    }

    // ---------------------------------------------------------------------
    // Verdicts
    // ---------------------------------------------------------------------

    function testFuzzVerdictSplit(uint256 toSeller) public {
        toSeller = bound(toSeller, 0, AMOUNT);
        (bytes32 id,) = _create();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, verifierKey, id, toSeller, expiry);

        vm.prank(stranger);
        escrow.executeVerdict(id, toSeller, expiry, sig);

        assertEq(usdc.balanceOf(seller), toSeller);
        assertEq(usdc.balanceOf(refundTo), AMOUNT - toSeller);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(_status(id)), uint8(UsdcEscrow.Status.Resolved));
    }

    function testVerdictRejectsWrongSigner() public {
        (bytes32 id,) = _create();
        (, uint256 otherKey) = makeAddrAndKey("other");
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, otherKey, id, AMOUNT, expiry);

        vm.expectRevert(VerdictVerifier.InvalidVerdictSignature.selector);
        escrow.executeVerdict(id, AMOUNT, expiry, sig);
    }

    function testVerdictRejectsTamperedAmount() public {
        (bytes32 id,) = _create();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, verifierKey, id, 0, expiry);

        vm.expectRevert(VerdictVerifier.InvalidVerdictSignature.selector);
        escrow.executeVerdict(id, AMOUNT, expiry, sig);
    }

    function testVerdictRejectsOverpayment() public {
        (bytes32 id,) = _create();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, verifierKey, id, AMOUNT + 1, expiry);

        vm.expectRevert(UsdcEscrow.AmountExceedsEscrow.selector);
        escrow.executeVerdict(id, AMOUNT + 1, expiry, sig);
    }

    function testVerdictRejectsExpired() public {
        (bytes32 id,) = _create();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, verifierKey, id, AMOUNT, expiry);

        vm.warp(expiry + 1);
        vm.expectRevert(VerdictVerifier.VerdictExpired.selector);
        escrow.executeVerdict(id, AMOUNT, expiry, sig);
    }

    function testVerdictRejectsOtherEscrow() public {
        (bytes32 idA, UsdcEscrow.Terms memory t) = _create();
        t.salt = bytes32(uint256(1));
        vm.prank(buyer);
        bytes32 idB = escrow.createEscrow(t);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sigA = _signVerdict(escrow, verifierKey, idA, AMOUNT, expiry);

        vm.expectRevert(VerdictVerifier.InvalidVerdictSignature.selector);
        escrow.executeVerdict(idB, AMOUNT, expiry, sigA);
    }

    function testVerdictRejectsOtherDeployment() public {
        // Same verifier, same terms, so the same escrow id, but a different audience (verifyingContract).
        UsdcEscrow other = new UsdcEscrow(IUSDC(address(usdc)), verifier, owner);
        vm.prank(buyer);
        usdc.approve(address(other), type(uint256).max);

        (bytes32 id, UsdcEscrow.Terms memory t) = _create();
        vm.prank(buyer);
        assertEq(other.createEscrow(t), id);

        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, verifierKey, id, AMOUNT, expiry);

        vm.expectRevert(VerdictVerifier.InvalidVerdictSignature.selector);
        other.executeVerdict(id, AMOUNT, expiry, sig);
    }

    function testVerdictRejectsOtherChain() public {
        (bytes32 id,) = _create();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, verifierKey, id, AMOUNT, expiry);

        vm.chainId(block.chainid + 1);
        vm.expectRevert(VerdictVerifier.InvalidVerdictSignature.selector);
        escrow.executeVerdict(id, AMOUNT, expiry, sig);
    }

    function testVerdictCannotReplay() public {
        (bytes32 id,) = _create();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, verifierKey, id, AMOUNT, expiry);

        escrow.executeVerdict(id, AMOUNT, expiry, sig);
        vm.expectRevert(UsdcEscrow.NotFunded.selector);
        escrow.executeVerdict(id, AMOUNT, expiry, sig);
    }

    function testSmartContractVerifier() public {
        (address signerAddr, uint256 signerKey) = makeAddrAndKey("multisigSigner");
        MockSmartAccount contractVerifier = new MockSmartAccount(signerAddr);
        vm.prank(owner);
        escrow.setVerifier(address(contractVerifier));

        (bytes32 id,) = _create();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, signerKey, id, AMOUNT, expiry);

        escrow.executeVerdict(id, AMOUNT, expiry, sig);
        assertEq(usdc.balanceOf(seller), AMOUNT);
    }

    // ---------------------------------------------------------------------
    // Deadline windows
    // ---------------------------------------------------------------------

    function testVerdictAndExpiryWindowsDoNotOverlap() public {
        (bytes32 id, UsdcEscrow.Terms memory t) = _create();
        uint64 expiry = t.deadline + 1 days;
        bytes memory sig = _signVerdict(escrow, verifierKey, id, AMOUNT, expiry);

        vm.warp(t.deadline);
        vm.expectRevert(UsdcEscrow.DeadlineNotReached.selector);
        escrow.refundExpired(id);

        vm.warp(t.deadline + 1);
        vm.expectRevert(UsdcEscrow.DeadlinePassed.selector);
        escrow.executeVerdict(id, AMOUNT, expiry, sig);
    }

    function testAnyoneCanRefundAfterDeadline() public {
        (bytes32 id, UsdcEscrow.Terms memory t) = _create();
        vm.warp(t.deadline + 1);

        vm.prank(stranger);
        escrow.refundExpired(id);

        assertEq(usdc.balanceOf(refundTo), AMOUNT);
        assertEq(uint8(_status(id)), uint8(UsdcEscrow.Status.Refunded));
    }

    // ---------------------------------------------------------------------
    // Voluntary settlement
    // ---------------------------------------------------------------------

    function testBuyerReleases() public {
        (bytes32 id,) = _create();
        vm.prank(buyer);
        escrow.release(id);
        assertEq(usdc.balanceOf(seller), AMOUNT);
        assertEq(uint8(_status(id)), uint8(UsdcEscrow.Status.Released));
    }

    function testSellerRefunds() public {
        (bytes32 id,) = _create();
        vm.prank(seller);
        escrow.refund(id);
        assertEq(usdc.balanceOf(refundTo), AMOUNT);
        assertEq(uint8(_status(id)), uint8(UsdcEscrow.Status.Refunded));
    }

    function testOnlyPartiesSettleVoluntarily() public {
        (bytes32 id,) = _create();

        vm.prank(seller);
        vm.expectRevert(UsdcEscrow.NotAuthorized.selector);
        escrow.release(id);

        vm.prank(buyer);
        vm.expectRevert(UsdcEscrow.NotAuthorized.selector);
        escrow.refund(id);
    }

    function testUnknownEscrowIsUnusable() public {
        vm.expectRevert(UsdcEscrow.NotFunded.selector);
        escrow.refundExpired(keccak256("nope"));
    }

    // ---------------------------------------------------------------------
    // Owner powers
    // ---------------------------------------------------------------------

    function testOwnerHasNoPathToFunds() public {
        (bytes32 id,) = _create();

        vm.startPrank(owner);
        vm.expectRevert(UsdcEscrow.NotAuthorized.selector);
        escrow.release(id);
        vm.expectRevert(UsdcEscrow.NotAuthorized.selector);
        escrow.refund(id);
        vm.expectRevert(UsdcEscrow.DeadlineNotReached.selector);
        escrow.refundExpired(id);
        vm.expectRevert(UsdcEscrow.NothingOwed.selector);
        escrow.withdraw(owner);

        // Rotating the verifier to an owner-controlled key does not reach existing escrows.
        (address ownerSigner, uint256 ownerSignerKey) = makeAddrAndKey("ownerSigner");
        escrow.setVerifier(ownerSigner);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, ownerSignerKey, id, AMOUNT, expiry);
        vm.expectRevert(VerdictVerifier.InvalidVerdictSignature.selector);
        escrow.executeVerdict(id, AMOUNT, expiry, sig);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(owner), 0);

        // The original verifier still settles the original escrow.
        bytes memory good = _signVerdict(escrow, verifierKey, id, AMOUNT, expiry);
        escrow.executeVerdict(id, AMOUNT, expiry, good);
        assertEq(usdc.balanceOf(seller), AMOUNT);
    }

    function testRotationAppliesToNewEscrows() public {
        address newVerifier = makeAddr("newVerifier");
        vm.prank(owner);
        escrow.setVerifier(newVerifier);

        UsdcEscrow.Terms memory stale = _terms(0);
        stale.verifier = verifier;
        vm.prank(buyer);
        vm.expectRevert(UsdcEscrow.WrongVerifier.selector);
        escrow.createEscrow(stale);

        UsdcEscrow.Terms memory fresh = _terms(0);
        vm.prank(buyer);
        bytes32 id = escrow.createEscrow(fresh);
        assertEq(escrow.getEscrow(id).verifier, newVerifier);
    }

    function testOnlyOwnerSetsVerifier() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setVerifier(stranger);
    }

    function testSetVerifierRejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(UsdcEscrow.ZeroAddress.selector);
        escrow.setVerifier(address(0));
    }

    // ---------------------------------------------------------------------
    // USDC blacklist / pause
    // ---------------------------------------------------------------------

    function testBlacklistedSellerDoesNotBlockRefundShare() public {
        (bytes32 id,) = _create();
        usdc.setBlacklisted(seller, true);

        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signVerdict(escrow, verifierKey, id, 600e6, expiry);
        escrow.executeVerdict(id, 600e6, expiry, sig);

        assertEq(usdc.balanceOf(refundTo), 400e6);
        assertEq(escrow.owed(seller), 600e6);

        vm.expectRevert("Blacklistable: account is blacklisted");
        escrow.withdraw(seller);

        usdc.setBlacklisted(seller, false);
        vm.prank(stranger);
        escrow.withdraw(seller);
        assertEq(usdc.balanceOf(seller), 600e6);
        assertEq(escrow.owed(seller), 0);
    }

    function testPausedTokenDefersRefund() public {
        (bytes32 id, UsdcEscrow.Terms memory t) = _create();
        usdc.setPaused(true);
        vm.warp(t.deadline + 1);

        escrow.refundExpired(id);
        assertEq(uint8(_status(id)), uint8(UsdcEscrow.Status.Refunded));
        assertEq(escrow.owed(refundTo), AMOUNT);

        usdc.setPaused(false);
        escrow.withdraw(refundTo);
        assertEq(usdc.balanceOf(refundTo), AMOUNT);
    }
}
