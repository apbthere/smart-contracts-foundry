// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";
import {TransientUse} from "../src/TransientUse.sol";
import {BadActor} from "../src/BadActor.sol";

contract TransientUseTest is Test {
    TransientUse public transientUse;
    BadActor public badActor;

    function setUp() public {
        transientUse = new TransientUse();
        badActor = new BadActor(address(transientUse));
    }

    function testReentrancyProtection() public {
        vm.expectRevert(bytes("Attack failed"));
        badActor.callbackFunction();
     }

    function testMultiplierInSingleTransaction() public {
        transientUse.setMultiplier(3);
        uint result = transientUse.multiply(5);
        assertEq(result, 15, "Multiplication result should be 15");
    } 
      
    function testMultiplierAcrossTransactions() public {
        transientUse.setMultiplier(3);
        
        // Simulate a new transaction by rolling to next block
        vm.roll(block.number + 1);
        
        uint result = transientUse.multiply(5);
        assertEq(result, 0, "Multiplication result should be 0 after new transaction");
    }
}
