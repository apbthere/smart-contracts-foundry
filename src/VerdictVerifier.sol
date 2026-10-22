// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title VerdictVerifier
/// @notice Checks off-chain verdicts before any escrowed funds move.
/// @dev A verdict is EIP-712 typed data:
///   - audience: the EIP-712 domain binds it to this contract (`verifyingContract`) on this chain (`chainId`)
///   - subject:  `escrowId`, which is itself a hash of the escrow's terms
///   - expiry:   rejected once `block.timestamp > expiry`
///   - signer:   EOA (ECDSA, malleability-safe) or smart contract (ERC-1271)
abstract contract VerdictVerifier is EIP712 {
    bytes32 public constant VERDICT_TYPEHASH = keccak256("Verdict(bytes32 escrowId,uint256 toSeller,uint64 expiry)");

    error VerdictExpired();
    error InvalidVerdictSignature();

    function verdictDigest(bytes32 escrowId, uint256 toSeller, uint64 expiry) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VERDICT_TYPEHASH, escrowId, toSeller, expiry)));
    }

    function _verifyVerdict(address signer, bytes32 escrowId, uint256 toSeller, uint64 expiry, bytes calldata signature)
        internal
        view
    {
        if (block.timestamp > expiry) revert VerdictExpired();
        bytes32 digest = verdictDigest(escrowId, toSeller, expiry);
        if (!SignatureChecker.isValidSignatureNowCalldata(signer, digest, signature)) {
            revert InvalidVerdictSignature();
        }
    }
}
