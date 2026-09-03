// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockProtocolTarget {
    uint256 public pingCount;
    uint256 public lastValue;
    bytes32 public lastTag;

    event Pinged(address indexed caller, uint256 value, bytes32 indexed tag);

    function ping(bytes32 tag) external payable returns (bytes32) {
        pingCount += 1;
        lastValue = msg.value;
        lastTag = tag;
        emit Pinged(msg.sender, msg.value, tag);
        return keccak256(abi.encodePacked(tag, pingCount));
    }
}
