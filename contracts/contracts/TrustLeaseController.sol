// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IAIAgentAuthenticatedWallet.sol";

interface IRiskOracle {
    function getLatestRiskScore(uint256 agentId) external view returns (uint8);
}

contract TrustLeaseController is IAIAgentAuthenticatedWallet {
    enum LeaseStatus {
        None,
        Active,
        Revoked,
        Expired
    }

    enum OperatorMode {
        None,
        Active,
        Review,
        Paused
    }

    enum DecisionOutcome {
        None,
        Approve,
        Resize,
        Block,
        HumanApproval
    }

    enum ExecutionStatus {
        None,
        Ready,
        Simulated,
        Broadcasted,
        Failed,
        Blocked
    }

    struct LeaseRecord {
        bool exists;
        string leaseId;
        address issuer;
        address wallet;
        string consumerName;
        string baseAsset;
        uint64 issuedAt;
        uint64 expiresAt;
        LeaseStatus status;
        uint128 perTxUsd6;
        uint128 dailyBudgetUsd6;
        uint128 spentTodayUsd6;
        uint64 spentWindowStartedAt;
        bytes32 policyHash;
        bytes32 notesHash;
    }

    struct AgentPolicy {
        bool exists;
        bool isActive;
        address agent;
        uint256 agentId;
        address owner;
        string[] allowedActions;
        address[] allowedContracts;
        address[] blockedContracts;
        uint256 maxValuePerTx;
        uint256 maxValuePerDay;
        uint256 validAfter;
        uint256 validUntil;
        uint8 minVerificationScore;
        uint256 createdAt;
    }

    struct AuditEntry {
        bool exists;
        bytes32 entryId;
        uint256 sequence;
        bytes32 sessionId;
        bytes32 previousHash;
        bytes32 contentHash;
        string actionType;
        address actor;
        bytes32 policyHash;
        bytes32 payloadHash;
        bytes32 entropyCommitment;
        uint64 timestamp;
    }

    struct OperatorRecord {
        bool exists;
        string operatorName;
        OperatorMode mode;
        uint64 updatedAt;
        bytes32 noteHash;
        address updater;
    }

    struct ReceiptAnchor {
        bool exists;
        string leaseId;
        string requestId;
        string consumerName;
        DecisionOutcome outcome;
        ExecutionStatus executionStatus;
        uint128 spentUsd6;
        bytes32 txHash;
        bytes32 proofHash;
        string artifactUri;
        uint64 timestamp;
    }

    address public owner;
    uint256 public totalLeasesIssued;
    uint256 public totalReceiptsAnchored;
    uint256 public totalBroadcastedReceipts;
    uint256 public totalBlockedReceipts;

    mapping(address => bool) public authorizedExecutors;
    mapping(bytes32 => LeaseRecord) private leaseRecords;
    mapping(bytes32 => OperatorRecord) private operatorRecords;
    mapping(bytes32 => ReceiptAnchor) private receiptAnchors;
    mapping(bytes32 => uint128) public consumedSpendUsd6ByRequest;
    mapping(bytes32 => bytes32) public activeLeaseKeyByConsumer;
    mapping(bytes32 => bytes32) public latestReceiptKeyByConsumer;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant AGENT_ACTION_TYPEHASH =
        keccak256("AgentAction(address agent,string action,address target,uint256 value,bytes data,uint256 nonce,uint256 validUntil,bytes32 policyHash,bytes32 entropyCommitment)");
    bytes32 public constant DELEGATION_TYPEHASH =
        keccak256("Delegation(address delegator,address delegatee,bytes32 policyHash,uint256 validUntil,uint256 nonce)");
    string public constant NAME = "AskGrokWallet";
    string public constant VERSION = "1";

    uint256 private _chainId;
    bytes32 private _cachedDomainSeparator;

    mapping(bytes32 => AgentPolicy) public policyRecords;
    mapping(bytes32 => mapping(uint256 => bool)) public usedActionNonces;
    mapping(bytes32 => uint256) public policySpendDayKey;
    mapping(bytes32 => uint256) public policySpentToday;
    mapping(bytes4 => string) public actionSelectorToAction;
    mapping(bytes32 => AuditEntry) public auditEntries;
    mapping(bytes32 => uint256) public auditSequenceBySession;
    mapping(bytes32 => bytes32) public auditHeadBySession;

    address public riskOracle;

    error UnknownPolicy(bytes32 policyHash);
    error NonceUsed(bytes32 policyHash, uint256 nonce);
    error RiskScoreExceeded(uint8 score, uint8 minVerificationScore);
    error ActionNotAllowed(bytes32 actionHash);
    error SelectorNotMapped(bytes4 selector);
    error ContractBlocked(address target);
    error ContractNotAllowed(address target);
    error BadSignatureLength(uint256 length);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event LeaseIssued(bytes32 indexed leaseKey, string leaseId, bytes32 indexed consumerKey, address indexed wallet, uint64 expiresAt, uint128 perTxUsd6, uint128 dailyBudgetUsd6, bytes32 policyHash);
    event LeaseStatusChanged(bytes32 indexed leaseKey, string leaseId, uint8 status, bytes32 noteHash, uint64 changedAt);
    event OperatorModeChanged(bytes32 indexed operatorKey, string operatorName, uint8 mode, bytes32 noteHash, uint64 changedAt);
    event ReceiptAnchored(bytes32 indexed requestKey, bytes32 indexed consumerKey, string leaseId, string requestId, uint8 outcome, uint8 executionStatus, uint128 spentUsd6, bytes32 txHash, bytes32 proofHash);
    event ExecutorAuthorizationUpdated(address indexed executor, bool allowed);
    event LeaseBudgetConsumed(bytes32 indexed leaseKey, bytes32 indexed requestKey, string leaseId, string requestId, uint128 spentUsd6, uint128 remainingDailyUsd6);
    event ActionSelectorMapped(bytes4 indexed selector, string action);
    event RiskOracleUpdated(address indexed oracle);
    event EntropyRevealed(bytes32 indexed entryId, bytes32 revealed);

    modifier onlyOwner() {
        require(msg.sender == owner, 'Only owner');
        _;
    }

    modifier onlyAuthorizedExecutor() {
        require(authorizedExecutors[msg.sender], 'Executor not authorized');
        _;
    }

    constructor(address initialOwner) {
        owner = initialOwner == address(0) ? msg.sender : initialOwner;
        _chainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit OwnershipTransferred(address(0), owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), 'Zero address');
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setExecutor(address executor, bool allowed) external onlyOwner {
        require(executor != address(0), 'Zero executor');
        authorizedExecutors[executor] = allowed;
        emit ExecutorAuthorizationUpdated(executor, allowed);
    }

    function leaseKey(string memory leaseId) public pure returns (bytes32) {
        return keccak256(bytes(leaseId));
    }

    function operatorKey(string memory operatorName) public pure returns (bytes32) {
        return keccak256(bytes(operatorName));
    }

    function consumerKey(string memory consumerName) public pure returns (bytes32) {
        return keccak256(bytes(consumerName));
    }

    function requestKey(string memory requestId) public pure returns (bytes32) {
        return keccak256(bytes(requestId));
    }

    function issueLease(
        string calldata leaseId,
        string calldata consumerName,
        address wallet,
        string calldata baseAsset,
        uint64 expiresAt,
        uint128 perTxUsd6,
        uint128 dailyBudgetUsd6,
        bytes32 policyHash,
        bytes32 notesHash
    ) external onlyOwner returns (bytes32) {
        require(bytes(leaseId).length > 0, 'leaseId required');
        require(bytes(consumerName).length > 0, 'consumer required');
        require(expiresAt > block.timestamp, 'expiry in past');
        require(perTxUsd6 > 0, 'perTx required');
        require(dailyBudgetUsd6 >= perTxUsd6, 'daily < perTx');

        bytes32 key = leaseKey(leaseId);
        LeaseRecord storage lease = leaseRecords[key];
        require(!lease.exists, 'lease exists');

        lease.exists = true;
        lease.leaseId = leaseId;
        lease.issuer = msg.sender;
        lease.wallet = wallet;
        lease.consumerName = consumerName;
        lease.baseAsset = baseAsset;
        lease.issuedAt = uint64(block.timestamp);
        lease.expiresAt = expiresAt;
        lease.status = LeaseStatus.Active;
        lease.perTxUsd6 = perTxUsd6;
        lease.dailyBudgetUsd6 = dailyBudgetUsd6;
        lease.spentTodayUsd6 = 0;
        lease.spentWindowStartedAt = uint64(block.timestamp);
        lease.policyHash = policyHash;
        lease.notesHash = notesHash;

        bytes32 cKey = consumerKey(consumerName);
        activeLeaseKeyByConsumer[cKey] = key;
        totalLeasesIssued += 1;

        emit LeaseIssued(key, leaseId, cKey, wallet, expiresAt, perTxUsd6, dailyBudgetUsd6, policyHash);
        return key;
    }

    function setLeaseStatus(string calldata leaseId, LeaseStatus status, bytes32 noteHash) external onlyOwner {
        require(status != LeaseStatus.None, 'invalid status');
        bytes32 key = leaseKey(leaseId);
        LeaseRecord storage lease = leaseRecords[key];
        require(lease.exists, 'unknown lease');

        if (status == LeaseStatus.Expired) {
            require(block.timestamp >= lease.expiresAt, 'lease not expired');
        }

        lease.status = status;
        if (noteHash != bytes32(0)) {
            lease.notesHash = noteHash;
        }

        bytes32 cKey = consumerKey(lease.consumerName);
        if (status != LeaseStatus.Active && activeLeaseKeyByConsumer[cKey] == key) {
            activeLeaseKeyByConsumer[cKey] = bytes32(0);
        }

        emit LeaseStatusChanged(key, leaseId, uint8(status), noteHash, uint64(block.timestamp));
    }

    function setOperatorMode(string calldata operatorName, OperatorMode mode, bytes32 noteHash) external onlyOwner {
        require(bytes(operatorName).length > 0, 'operator required');
        require(mode != OperatorMode.None, 'invalid mode');

        bytes32 key = operatorKey(operatorName);
        OperatorRecord storage operator = operatorRecords[key];
        operator.exists = true;
        operator.operatorName = operatorName;
        operator.mode = mode;
        operator.updatedAt = uint64(block.timestamp);
        operator.noteHash = noteHash;
        operator.updater = msg.sender;

        emit OperatorModeChanged(key, operatorName, uint8(mode), noteHash, uint64(block.timestamp));
    }

    function anchorReceipt(
        string calldata leaseId,
        string calldata requestId,
        string calldata consumerName,
        DecisionOutcome outcome,
        ExecutionStatus executionStatus,
        uint128 spentUsd6,
        bytes32 txHash,
        bytes32 proofHash,
        string calldata artifactUri
    ) external onlyOwner returns (bytes32) {
        require(bytes(leaseId).length > 0, 'lease required');
        require(bytes(requestId).length > 0, 'request required');
        require(bytes(consumerName).length > 0, 'consumer required');

        bytes32 lKey = leaseKey(leaseId);
        LeaseRecord storage lease = leaseRecords[lKey];
        require(lease.exists, 'unknown lease');

        _refreshUsageWindow(lease);

        if (executionStatus == ExecutionStatus.Broadcasted && spentUsd6 > 0) {
            bytes32 reqKey = requestKey(requestId);
            uint128 preConsumedUsd6 = consumedSpendUsd6ByRequest[reqKey];
            if (preConsumedUsd6 > 0) {
                require(spentUsd6 == preConsumedUsd6, 'spent mismatch');
            } else {
                require(spentUsd6 <= lease.perTxUsd6, 'per-tx exceeded');
                require(spentUsd6 <= _remainingDailyBudget(lease), 'daily budget exceeded');
                lease.spentTodayUsd6 += spentUsd6;
            }
            totalBroadcastedReceipts += 1;
        }

        if (outcome == DecisionOutcome.Block || executionStatus == ExecutionStatus.Blocked) {
            totalBlockedReceipts += 1;
        }

        bytes32 rKey = requestKey(requestId);
        ReceiptAnchor storage receipt = receiptAnchors[rKey];
        receipt.exists = true;
        receipt.leaseId = leaseId;
        receipt.requestId = requestId;
        receipt.consumerName = consumerName;
        receipt.outcome = outcome;
        receipt.executionStatus = executionStatus;
        receipt.spentUsd6 = spentUsd6;
        receipt.txHash = txHash;
        receipt.proofHash = proofHash;
        receipt.artifactUri = artifactUri;
        receipt.timestamp = uint64(block.timestamp);

        bytes32 cKey = consumerKey(consumerName);
        latestReceiptKeyByConsumer[cKey] = rKey;
        totalReceiptsAnchored += 1;

        emit ReceiptAnchored(rKey, cKey, leaseId, requestId, uint8(outcome), uint8(executionStatus), spentUsd6, txHash, proofHash);

        bytes32 payloadHash = keccak256(
            abi.encode(
                requestId,
                uint8(outcome),
                uint8(executionStatus),
                spentUsd6,
                txHash,
                proofHash,
                keccak256(bytes(artifactUri))
            )
        );
        _appendAuditEntry(cKey, "receipt", msg.sender, lease.policyHash, payloadHash, bytes32(0));
        return rKey;
    }

    function enforceAndConsume(
        string calldata leaseId,
        string calldata requestId,
        uint128 requestedUsd6
    ) external onlyAuthorizedExecutor returns (uint8 resolvedStatus, uint128 remainingDailyUsd6) {
        require(bytes(requestId).length > 0, 'request required');
        require(requestedUsd6 > 0, 'requested required');

        bytes32 lKey = leaseKey(leaseId);
        LeaseRecord storage lease = leaseRecords[lKey];
        require(lease.exists, 'unknown lease');

        bytes32 rKey = requestKey(requestId);
        require(consumedSpendUsd6ByRequest[rKey] == 0, 'request consumed');

        _refreshUsageWindow(lease);

        LeaseStatus status = _resolvedLeaseStatus(lease);
        require(status == LeaseStatus.Active, 'lease inactive');
        require(requestedUsd6 <= lease.perTxUsd6, 'per-tx exceeded');

        uint128 remaining = _remainingDailyBudget(lease);
        require(requestedUsd6 <= remaining, 'daily budget exceeded');

        lease.spentTodayUsd6 += requestedUsd6;
        uint128 remainingAfter = lease.dailyBudgetUsd6 - lease.spentTodayUsd6;
        consumedSpendUsd6ByRequest[rKey] = requestedUsd6;

        emit LeaseBudgetConsumed(lKey, rKey, leaseId, requestId, requestedUsd6, remainingAfter);

        return (uint8(status), remainingAfter);
    }

    function canExecute(string calldata leaseId, uint128 requestedUsd6) external view returns (bool allowed, uint8 resolvedStatus, uint128 remainingDailyUsd6) {
        bytes32 key = leaseKey(leaseId);
        LeaseRecord storage lease = leaseRecords[key];
        if (!lease.exists) {
            return (false, uint8(LeaseStatus.None), 0);
        }

        LeaseStatus status = _resolvedLeaseStatus(lease);
        uint128 remaining = _remainingDailyBudgetView(lease);
        bool ok = status == LeaseStatus.Active && requestedUsd6 <= lease.perTxUsd6 && requestedUsd6 <= remaining;
        return (ok, uint8(status), remaining);
    }

    function getActiveLeaseByConsumer(string calldata consumerName)
        external
        view
        returns (
            bool exists,
            string memory leaseId_,
            address wallet,
            string memory consumerName_,
            string memory baseAsset,
            uint64 issuedAt,
            uint64 expiresAt,
            uint8 status,
            uint128 perTxUsd6,
            uint128 dailyBudgetUsd6,
            uint128 spentTodayUsd6,
            uint64 spentWindowStartedAt,
            uint128 remainingDailyUsd6,
            bytes32 policyHash,
            bytes32 notesHash
        )
    {
        bytes32 key = activeLeaseKeyByConsumer[consumerKey(consumerName)];
        LeaseRecord storage lease = leaseRecords[key];
        if (!lease.exists) {
            return (false, '', address(0), '', '', 0, 0, uint8(LeaseStatus.None), 0, 0, 0, 0, 0, bytes32(0), bytes32(0));
        }

        LeaseStatus resolved = _resolvedLeaseStatus(lease);
        uint128 remaining = _remainingDailyBudgetView(lease);

        return (
            true,
            lease.leaseId,
            lease.wallet,
            lease.consumerName,
            lease.baseAsset,
            lease.issuedAt,
            lease.expiresAt,
            uint8(resolved),
            lease.perTxUsd6,
            lease.dailyBudgetUsd6,
            lease.spentTodayUsd6,
            lease.spentWindowStartedAt,
            remaining,
            lease.policyHash,
            lease.notesHash
        );
    }

    function getOperator(string calldata operatorName)
        external
        view
        returns (
            bool exists,
            string memory operatorName_,
            uint8 mode,
            uint64 updatedAt,
            bytes32 noteHash,
            address updater
        )
    {
        OperatorRecord storage operator = operatorRecords[operatorKey(operatorName)];
        if (!operator.exists) {
            return (false, operatorName, uint8(OperatorMode.None), 0, bytes32(0), address(0));
        }

        return (true, operator.operatorName, uint8(operator.mode), operator.updatedAt, operator.noteHash, operator.updater);
    }

    function getLatestReceiptByConsumer(string calldata consumerName)
        external
        view
        returns (
            bool exists,
            string memory leaseId_,
            string memory requestId_,
            string memory consumerName_,
            uint8 outcome,
            uint8 executionStatus,
            uint128 spentUsd6,
            bytes32 txHash,
            bytes32 proofHash,
            string memory artifactUri,
            uint64 timestamp
        )
    {
        ReceiptAnchor storage receipt = receiptAnchors[latestReceiptKeyByConsumer[consumerKey(consumerName)]];
        if (!receipt.exists) {
            return (false, '', '', '', uint8(DecisionOutcome.None), uint8(ExecutionStatus.None), 0, bytes32(0), bytes32(0), '', 0);
        }

        return (
            true,
            receipt.leaseId,
            receipt.requestId,
            receipt.consumerName,
            uint8(receipt.outcome),
            uint8(receipt.executionStatus),
            receipt.spentUsd6,
            receipt.txHash,
            receipt.proofHash,
            receipt.artifactUri,
            receipt.timestamp
        );
    }

    // ------------------------------------------------------------------------
    // ERC-8196: AI Agent Authenticated Wallet (policy execution layer)
    // ------------------------------------------------------------------------

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

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
    ) external override returns (bytes32 policyHash) {
        require(agent != address(0), 'agent required');
        require(maxValuePerTx > 0, 'perTx required');
        require(maxValuePerDay == 0 || maxValuePerDay >= maxValuePerTx, 'daily < perTx');
        require(validUntil > validAfter, 'invalid window');

        policyHash = keccak256(
            abi.encode(
                agent,
                agentId,
                keccak256(abi.encode(allowedActions)),
                keccak256(abi.encode(allowedContracts)),
                keccak256(abi.encode(blockedContracts)),
                maxValuePerTx,
                maxValuePerDay,
                validAfter,
                validUntil,
                minVerificationScore
            )
        );

        AgentPolicy storage policy = policyRecords[policyHash];
        require(!policy.exists, 'policy exists');

        policy.exists = true;
        policy.isActive = true;
        policy.agent = agent;
        policy.agentId = agentId;
        policy.owner = msg.sender;
        policy.allowedActions = allowedActions;
        policy.allowedContracts = allowedContracts;
        policy.blockedContracts = blockedContracts;
        policy.maxValuePerTx = maxValuePerTx;
        policy.maxValuePerDay = maxValuePerDay;
        policy.validAfter = validAfter;
        policy.validUntil = validUntil;
        policy.minVerificationScore = minVerificationScore;
        policy.createdAt = block.timestamp;

        emit PolicyRegistered(policyHash, msg.sender, agent, validUntil);
        return policyHash;
    }

    function revokePolicy(bytes32 policyHash, string calldata reason) external override {
        AgentPolicy storage policy = policyRecords[policyHash];
        require(policy.exists, 'unknown policy');
        require(msg.sender == policy.owner || msg.sender == owner, 'not authorized');
        require(policy.isActive, 'already revoked');

        policy.isActive = false;
        emit PolicyRevoked(policyHash, reason);
    }

    function getPolicy(bytes32 policyHash)
        external
        view
        override
        returns (
            address agent,
            address owner_,
            uint256 maxValuePerTx,
            uint256 validUntil,
            bool isActive
        )
    {
        AgentPolicy storage policy = policyRecords[policyHash];
        if (!policy.exists) {
            return (address(0), address(0), 0, 0, false);
        }
        return (policy.agent, policy.owner, policy.maxValuePerTx, policy.validUntil, policy.isActive);
    }

    function executeAction(
        bytes32 policyHash,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        bytes32 entropyCommitment,
        bytes calldata signature
    ) external override returns (bool success, bytes32 auditEntryId) {
        AgentPolicy storage policy = policyRecords[policyHash];
        if (!policy.exists) revert UnknownPolicy(policyHash);
        if (!policy.isActive) revert PolicyViolation(policyHash, "revoked");
        if (block.timestamp < policy.validAfter || block.timestamp >= policy.validUntil) {
            revert PolicyExpired(policyHash, policy.validUntil);
        }
        if (value > policy.maxValuePerTx) revert ValueExceedsLimit(value, policy.maxValuePerTx);

        if (riskOracle != address(0)) {
            uint8 score = IRiskOracle(riskOracle).getLatestRiskScore(policy.agentId);
            if (score > policy.minVerificationScore) revert RiskScoreExceeded(score, policy.minVerificationScore);
        }

        // Derive the action label from calldata via the selector registry so the
        // signed claim and the real calldata cannot diverge.
        string memory action;
        if (data.length == 0) {
            action = "transfer";
        } else {
            bytes4 selector = bytes4(data[:4]);
            action = actionSelectorToAction[selector];
            if (bytes(action).length == 0) revert SelectorNotMapped(selector);
        }
        bytes32 actionHash = keccak256(bytes(action));
        if (!_actionAllowed(policy, actionHash)) revert ActionNotAllowed(actionHash);

        if (policy.blockedContracts.length > 0 && _contractBlocked(policy, target)) {
            revert ContractBlocked(target);
        }
        if (policy.allowedContracts.length > 0 && !_contractAllowed(policy, target)) {
            revert ContractNotAllowed(target);
        }

        // EIP-712: recover the agent from the signed AgentAction. validUntil is
        // bound to the policy's validity window so action signatures cannot
        // outlive the delegation that grants them.
        bytes32 structHash = keccak256(
            abi.encode(
                AGENT_ACTION_TYPEHASH,
                policy.agent,
                keccak256(bytes(action)),
                target,
                value,
                keccak256(data),
                nonce,
                policy.validUntil,
                policyHash,
                entropyCommitment
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = _recoverSigner(digest, signature);
        if (recovered != policy.agent) revert InvalidSignature(recovered, policy.agent);

        // All checks passed. Mutate state only after validation so failed
        // attempts never consume nonces or spend.
        if (policy.maxValuePerDay > 0) {
            uint256 dayKey = block.timestamp / 1 days;
            if (policySpendDayKey[policyHash] != dayKey) {
                policySpendDayKey[policyHash] = dayKey;
                policySpentToday[policyHash] = 0;
            }
            uint256 spentToday = policySpentToday[policyHash];
            if (spentToday + value > policy.maxValuePerDay) {
                revert ValueExceedsLimit(value, policy.maxValuePerDay);
            }
            policySpentToday[policyHash] = spentToday + value;
        }
        if (usedActionNonces[policyHash][nonce]) revert NonceUsed(policyHash, nonce);
        usedActionNonces[policyHash][nonce] = true;

        bytes32 payloadHash = keccak256(abi.encode(target, value, keccak256(data), nonce));
        auditEntryId = _appendAuditEntry(policyHash, action, policy.agent, policyHash, payloadHash, entropyCommitment);

        emit ActionExecuted(policyHash, policy.agent, target, value, auditEntryId);
        return (true, auditEntryId);
    }

    function setRiskOracle(address oracle) external onlyOwner {
        riskOracle = oracle;
        emit RiskOracleUpdated(oracle);
    }

    function setActionSelector(bytes4 selector, string calldata action) external onlyOwner {
        require(bytes(action).length > 0, 'action required');
        actionSelectorToAction[selector] = action;
        emit ActionSelectorMapped(selector, action);
    }

    function verifyEntropyReveal(bytes32 commitment, bytes32 revealed) public pure returns (bool) {
        if (keccak256(abi.encodePacked(revealed)) != commitment) {
            revert EntropyVerificationFailed(commitment, revealed);
        }
        return true;
    }

    /// @notice Walks a session's audit entries in order and verifies the
    ///         hash chain (each entry's previousHash must equal the prior
    ///         entry id) plus each entry's content hash. Any tamper breaks it.
    function verifyAuditChain(bytes32[] calldata entryIds) external view returns (bool) {
        bytes32 expectedPrev = bytes32(0);
        for (uint256 i = 0; i < entryIds.length; i++) {
            AuditEntry storage entry = auditEntries[entryIds[i]];
            if (!entry.exists || entry.previousHash != expectedPrev) return false;

            bytes32 recomputed = keccak256(
                abi.encodePacked(
                    entry.previousHash,
                    entry.sequence,
                    entry.sessionId,
                    keccak256(bytes(entry.actionType)),
                    entry.actor,
                    entry.policyHash,
                    entry.payloadHash,
                    entry.entropyCommitment,
                    entry.timestamp
                )
            );
            bytes32 expectedId = keccak256(abi.encodePacked(entry.sessionId, entry.sequence));
            if (entry.contentHash != recomputed || entry.entryId != expectedId) return false;
            expectedPrev = entryIds[i];
        }
        return true;
    }

    function _appendAuditEntry(
        bytes32 sessionId,
        string memory actionType,
        address actor,
        bytes32 policyHash,
        bytes32 payloadHash,
        bytes32 entropyCommitment
    ) internal returns (bytes32 entryId) {
        uint256 seq = auditSequenceBySession[sessionId] + 1;
        bytes32 prev = auditHeadBySession[sessionId];
        uint64 ts = uint64(block.timestamp);

        bytes32 contentHash = keccak256(
            abi.encodePacked(
                prev,
                seq,
                sessionId,
                keccak256(bytes(actionType)),
                actor,
                policyHash,
                payloadHash,
                entropyCommitment,
                ts
            )
        );
        entryId = keccak256(abi.encodePacked(sessionId, seq));

        auditEntries[entryId] = AuditEntry({
            exists: true,
            entryId: entryId,
            sequence: seq,
            sessionId: sessionId,
            previousHash: prev,
            contentHash: contentHash,
            actionType: actionType,
            actor: actor,
            policyHash: policyHash,
            payloadHash: payloadHash,
            entropyCommitment: entropyCommitment,
            timestamp: ts
        });

        auditHeadBySession[sessionId] = entryId;
        auditSequenceBySession[sessionId] = seq;

        emit AuditEntryLogged(entryId, seq, sessionId, actionType);
    }

    function _actionAllowed(AgentPolicy storage policy, bytes32 actionHash) internal view returns (bool) {
        for (uint256 i = 0; i < policy.allowedActions.length; i++) {
            if (keccak256(bytes(policy.allowedActions[i])) == actionHash) return true;
        }
        return false;
    }

    function _contractBlocked(AgentPolicy storage policy, address target) internal view returns (bool) {
        for (uint256 i = 0; i < policy.blockedContracts.length; i++) {
            if (policy.blockedContracts[i] == target) return true;
        }
        return false;
    }

    function _contractAllowed(AgentPolicy storage policy, address target) internal view returns (bool) {
        for (uint256 i = 0; i < policy.allowedContracts.length; i++) {
            if (policy.allowedContracts[i] == target) return true;
        }
        return false;
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        if (_chainId == block.chainid) return _cachedDomainSeparator;
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash));
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert BadSignatureLength(signature.length);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(digest, v, r, s);
    }

    function _resolvedLeaseStatus(LeaseRecord storage lease) internal view returns (LeaseStatus) {
        if (lease.status == LeaseStatus.Active && block.timestamp >= lease.expiresAt) {
            return LeaseStatus.Expired;
        }
        return lease.status;
    }

    function _refreshUsageWindow(LeaseRecord storage lease) internal {
        if (block.timestamp >= lease.spentWindowStartedAt + 1 days) {
            lease.spentWindowStartedAt = uint64(block.timestamp);
            lease.spentTodayUsd6 = 0;
        }
    }

    function _remainingDailyBudget(LeaseRecord storage lease) internal view returns (uint128) {
        if (block.timestamp >= lease.spentWindowStartedAt + 1 days) {
            return lease.dailyBudgetUsd6;
        }
        if (lease.spentTodayUsd6 >= lease.dailyBudgetUsd6) {
            return 0;
        }
        return lease.dailyBudgetUsd6 - lease.spentTodayUsd6;
    }

    function _remainingDailyBudgetView(LeaseRecord storage lease) internal view returns (uint128) {
        return _remainingDailyBudget(lease);
    }
}
