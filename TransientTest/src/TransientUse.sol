// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import "./IReentrancyTest.sol";

contract TransientUse {
    uint256 transient multiplier;
    bool transient isExecuting;

    modifier nonReentrant() {
        require(!isExecuting, "Reentrant call");
        isExecuting = true;
        _;
        isExecuting = false;
    }

    function safeFunction(address targetAddress) external nonReentrant {
        IReentrancyTest(targetAddress).callbackFunction();
    }

    function setMultiplier(uint256 mul) external {
        multiplier = mul;
    }

    function multiply(uint256 value) external view returns (uint256) {
        return value * multiplier;
    }
}
