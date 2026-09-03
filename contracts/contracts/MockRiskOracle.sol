// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-8126-style risk oracle used in tests and as a pluggable
///         hook before a real verification provider is connected.
contract MockRiskOracle {
    uint8 public risk;

    function setRisk(uint8 nextRisk) external {
        risk = nextRisk;
    }

    function getLatestRiskScore(uint256) external view returns (uint8) {
        return risk;
    }
}
