// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Subset of Circle's FiatToken v2.2 (USDC) used by the escrow.
interface IUSDC is IERC20 {
    /// @dev EIP-3009. Only callable by `to`, which prevents front-running. The `bytes` signature
    /// overload (v2.2+) accepts ERC-1271 signatures, so smart accounts can fund escrows too.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function isBlacklisted(address account) external view returns (bool);
}
