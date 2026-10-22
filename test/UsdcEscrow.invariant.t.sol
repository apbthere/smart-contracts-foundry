// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {UsdcEscrow} from "../src/UsdcEscrow.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Drives random sequences of create / settle / blacklist / warp / withdraw.
contract EscrowHandler is Test {
    MockUSDC public usdc;
    UsdcEscrow public escrow;
    uint256 internal verifierKey;

    address[] public actors;
    bytes32[] public ids;
    uint256 internal nonce;

    constructor(MockUSDC _usdc, UsdcEscrow _escrow, uint256 _verifierKey) {
        usdc = _usdc;
        escrow = _escrow;
        verifierKey = _verifierKey;
        for (uint256 i; i < 4; i++) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            usdc.mint(a, 1_000_000e6);
            vm.prank(a);
            usdc.approve(address(escrow), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function create(uint256 buyerSeed, uint256 sellerSeed, uint256 amount, uint256 duration) external {
        address buyer = actors[buyerSeed % actors.length];
        address seller = actors[sellerSeed % actors.length];
        if (seller == buyer) seller = actors[(sellerSeed + 1) % actors.length];
        if (usdc.isBlacklisted(buyer) || usdc.paused()) return;

        UsdcEscrow.Terms memory t = UsdcEscrow.Terms({
            seller: seller,
            refundTo: buyer,
            verifier: escrow.verifier(),
            amount: bound(amount, 1, 10_000e6),
            deadline: uint64(block.timestamp + bound(duration, 1, 30 days)),
            salt: bytes32(nonce++)
        });
        vm.prank(buyer);
        ids.push(escrow.createEscrow(t));
    }

    function verdict(uint256 idSeed, uint256 toSeller) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        UsdcEscrow.Escrow memory e = escrow.getEscrow(id);
        if (e.status != UsdcEscrow.Status.Funded || block.timestamp > e.deadline) return;

        toSeller = bound(toSeller, 0, e.amount);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, escrow.verdictDigest(id, toSeller, expiry));
        escrow.executeVerdict(id, toSeller, expiry, abi.encodePacked(r, s, v));
    }

    function release(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        UsdcEscrow.Escrow memory e = escrow.getEscrow(id);
        if (e.status != UsdcEscrow.Status.Funded) return;
        vm.prank(e.buyer);
        escrow.release(id);
    }

    function refund(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        UsdcEscrow.Escrow memory e = escrow.getEscrow(id);
        if (e.status != UsdcEscrow.Status.Funded) return;
        vm.prank(e.seller);
        escrow.refund(id);
    }

    function refundExpired(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        UsdcEscrow.Escrow memory e = escrow.getEscrow(id);
        if (e.status != UsdcEscrow.Status.Funded) return;
        if (block.timestamp <= e.deadline) vm.warp(uint256(e.deadline) + 1);
        escrow.refundExpired(id);
    }

    function withdraw(uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        if (escrow.owed(a) == 0 || usdc.isBlacklisted(a) || usdc.paused()) return;
        escrow.withdraw(a);
    }

    function toggleBlacklist(uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        usdc.setBlacklisted(a, !usdc.isBlacklisted(a));
    }

    function togglePause() external {
        usdc.setPaused(!usdc.paused());
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 10 days));
    }
}

contract UsdcEscrowInvariantTest is Test {
    MockUSDC usdc;
    UsdcEscrow escrow;
    EscrowHandler handler;
    address owner = makeAddr("owner");

    function setUp() public {
        (address verifier, uint256 verifierKey) = makeAddrAndKey("verifier");
        usdc = new MockUSDC();
        escrow = new UsdcEscrow(IUSDC(address(usdc)), verifier, owner);
        handler = new EscrowHandler(usdc, escrow, verifierKey);
        targetContract(address(handler));
    }

    /// The escrow holds exactly what is still locked plus what is owed. No more, no less.
    function invariant_solvency() public view {
        uint256 locked;
        for (uint256 i; i < handler.idCount(); i++) {
            UsdcEscrow.Escrow memory e = escrow.getEscrow(handler.ids(i));
            if (e.status == UsdcEscrow.Status.Funded) locked += e.amount;
        }
        uint256 owedTotal;
        for (uint256 i; i < handler.actorCount(); i++) {
            owedTotal += escrow.owed(handler.actors(i));
        }
        assertEq(usdc.balanceOf(address(escrow)), locked + owedTotal);
    }

    /// Value only moves between escrow parties: the owner and verifier never gain anything.
    function invariant_noValueLeaks() public view {
        uint256 held = usdc.balanceOf(address(escrow));
        for (uint256 i; i < handler.actorCount(); i++) {
            held += usdc.balanceOf(handler.actors(i));
        }
        assertEq(held, usdc.totalSupply());
        assertEq(usdc.balanceOf(owner), 0);
        assertEq(escrow.owed(owner), 0);
    }
}
