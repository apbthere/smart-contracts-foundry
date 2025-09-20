// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import "./IReentrancyTest.sol";

contract TransientUse {
    uint transient multiplier;
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

    function setMultiplier(uint mul) external {
        multiplier = mul;
    }

    function multiply(uint value) external view returns (uint) {
        return value * multiplier;
    } 
}