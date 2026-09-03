// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

/// @title IAIAgentAuthenticatedWallet (ERC-8196)
/// @notice Policy-bound transaction execution and verifiable credential delegation
///         for autonomous AI agents. See https://eips.ethereum.org/EIPS/eip-8196
interface IAIAgentAuthenticatedWallet {
    event PolicyRegistered(
        bytes32 indexed policyHash,
        address indexed owner,
        address indexed agent,
        uint256 validUntil
    );

    event ActionExecuted(
        bytes32 indexed policyHash,
        address indexed agent,
        address target,
        uint256 value,
        bytes32 auditEntryId
    );

    event PolicyRevoked(
        bytes32 indexed policyHash,
        string reason
    );

    event AuditEntryLogged(
        bytes32 indexed entryId,
        uint256 sequence,
        bytes32 sessionId,
        string actionType
    );

    error PolicyExpired(bytes32 policyHash, uint256 validUntil);
    error ValueExceedsLimit(uint256 value, uint256 maxValue);
    error InvalidSignature(address recovered, address expected);
    error EntropyVerificationFailed(bytes32 commitment, bytes32 revealed);
    error PolicyViolation(bytes32 policyHash, string reason);

    function registerPolicy(
        address agent,
        uint256 agentId,
        string[] calldata allowedActions,
        address[] calldata allowedContracts,
        address[] calldata blockedContracts,
        uint256 maxValuePerTx,
        uint256 maxValuePerDay,
        uint256 validAfter,
        uint256 validUntil,
        uint8 minVerificationScore
    ) external returns (bytes32 policyHash);

    function executeAction(
        bytes32 policyHash,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        bytes32 entropyCommitment,
        bytes calldata signature
    ) external returns (bool success, bytes32 auditEntryId);

    function revokePolicy(bytes32 policyHash, string calldata reason) external;

    function getPolicy(bytes32 policyHash) external view returns (
        address agent,
        address owner,
        uint256 maxValuePerTx,
        uint256 validUntil,
        bool isActive
    );
}
