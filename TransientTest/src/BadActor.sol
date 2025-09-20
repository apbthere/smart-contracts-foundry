// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import "./IReentrancyTest.sol";

contract BadActor is IReentrancyTest {
    address public immutable contractAddress;
    bytes public target;
    uint256 public counter;

    constructor(address targetAddress) {
        target = abi.encodeWithSignature("safeFunction(address)", this);
        contractAddress = targetAddress;
    }

    function callbackFunction() external {
        (bool success,) = contractAddress.call(target);
        require(success, "Attack failed");
    }
}
