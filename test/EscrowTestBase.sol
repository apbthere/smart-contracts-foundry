// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {UsdcEscrow} from "../src/UsdcEscrow.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

abstract contract EscrowTestBase is Test {
    bytes32 constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 constant AMOUNT = 1_000e6;

    MockUSDC usdc;
    UsdcEscrow escrow;

    address owner = makeAddr("owner");
    address seller = makeAddr("seller");
    address refundTo = makeAddr("refundTo");
    address stranger = makeAddr("stranger");
    address buyer;
    uint256 buyerKey;
    address verifier;
    uint256 verifierKey;

    function setUp() public virtual {
        (buyer, buyerKey) = makeAddrAndKey("buyer");
        (verifier, verifierKey) = makeAddrAndKey("verifier");

        usdc = new MockUSDC();
        escrow = new UsdcEscrow(IUSDC(address(usdc)), verifier, owner);

        usdc.mint(buyer, 100_000e6);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _terms(bytes32 salt) internal view returns (UsdcEscrow.Terms memory) {
        return UsdcEscrow.Terms({
            seller: seller,
            refundTo: refundTo,
            verifier: escrow.verifier(),
            amount: AMOUNT,
            deadline: uint64(block.timestamp + 7 days),
            salt: salt
        });
    }

    function _create() internal returns (bytes32 id, UsdcEscrow.Terms memory t) {
        t = _terms(bytes32(0));
        vm.prank(buyer);
        id = escrow.createEscrow(t);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signVerdict(UsdcEscrow target, uint256 key, bytes32 id, uint256 toSeller, uint64 expiry)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, target.verdictDigest(id, toSeller, expiry));
    }

    function _signAuthorization(
        bytes32 domainSeparator,
        uint256 key,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal pure returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        return _sign(key, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
    }

    function _status(bytes32 id) internal view returns (UsdcEscrow.Status) {
        return escrow.getEscrow(id).status;
    }
}
