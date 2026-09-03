// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITrustLeaseController {
    function enforceAndConsume(
        string calldata leaseId,
        string calldata requestId,
        uint128 requestedUsd6
    ) external returns (uint8 resolvedStatus, uint128 remainingDailyUsd6);

    function canExecute(
        string calldata leaseId,
        uint128 requestedUsd6
    ) external view returns (bool allowed, uint8 resolvedStatus, uint128 remainingDailyUsd6);

    function getActiveLeaseByConsumer(
        string calldata consumerName
    )
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
        );

    function getOperator(
        string calldata operatorName
    )
        external
        view
        returns (
            bool exists,
            string memory operatorName_,
            uint8 mode,
            uint64 updatedAt,
            bytes32 noteHash,
            address updater
        );

    function auditEntries(
        bytes32 entryId
    )
        external
        view
        returns (
            bool exists,
            bytes32 entryId_,
            uint256 sequence,
            bytes32 sessionId,
            bytes32 previousHash,
            bytes32 contentHash,
            string memory actionType,
            address actor,
            bytes32 policyHash,
            bytes32 payloadHash,
            bytes32 entropyCommitment,
            uint64 timestamp
        );
}

contract BoundlessVault {
    struct MemberPolicy {
        bool exists;
        bool enabled;
        uint128 perTxUsd6;
        uint128 dailyBudgetUsd6;
        uint128 spentTodayUsd6;
        uint64 spentWindowStartedAt;
    }

    address public owner;
    ITrustLeaseController public controller;

    string public activeLeaseId;
    string public consumerName;
    string public operatorName;

    mapping(address => MemberPolicy) public memberPolicies;
    mapping(address => bool) public allowedAssets;
    mapping(address => bool) public allowedProtocols;
    mapping(bytes32 => bool) public usedActionProofs;

    uint256 private lockState = 1;
    bool public requireActionProof;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ControllerUpdated(address indexed controller);
    event LeaseContextUpdated(string leaseId, string consumerName, string operatorName);
    event MemberPolicyUpdated(address indexed member, bool enabled, uint128 perTxUsd6, uint128 dailyBudgetUsd6);
    event MemberSpendConsumed(address indexed member, string requestId, uint128 spentUsd6, uint128 remainingDailyUsd6);
    event AllowedAssetUpdated(address indexed asset, bool allowed);
    event AllowedProtocolUpdated(address indexed protocol, bool allowed);
    event TokenDeposited(address indexed token, address indexed from, uint256 amount);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);
    event NativeWithdrawn(address indexed to, uint256 amount);
    event TransferExecuted(
        string indexed requestId,
        string indexed leaseId,
        address indexed token,
        address to,
        uint256 amount,
        uint128 spentUsd6
    );
    event ProtocolCallExecuted(
        string indexed requestId,
        string indexed leaseId,
        address indexed target,
        uint256 value,
        uint128 spentUsd6
    );
    event ActionProofRequiredUpdated(bool enabled);
    event ActionProofConsumed(bytes32 indexed auditEntryId, address indexed actor, string actionType);

    modifier onlyOwner() {
        require(msg.sender == owner, 'Only owner');
        _;
    }

    modifier onlyMember() {
        MemberPolicy storage policy = memberPolicies[msg.sender];
        require(policy.exists && policy.enabled, 'Member not allowed');
        _;
    }

    modifier nonReentrant() {
        require(lockState == 1, 'Reentrancy');
        lockState = 2;
        _;
        lockState = 1;
    }

    constructor(
        address initialController,
        address initialOwner,
        string memory initialConsumerName,
        string memory initialOperatorName
    ) {
        require(initialController != address(0), 'Controller required');
        owner = initialOwner == address(0) ? msg.sender : initialOwner;
        controller = ITrustLeaseController(initialController);
        consumerName = initialConsumerName;
        operatorName = initialOperatorName;
        emit OwnershipTransferred(address(0), owner);
        emit ControllerUpdated(initialController);
    }

    receive() external payable {}

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), 'Owner required');
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setController(address nextController) external onlyOwner {
        require(nextController != address(0), 'Controller required');
        controller = ITrustLeaseController(nextController);
        emit ControllerUpdated(nextController);
    }

    function setLeaseContext(
        string calldata leaseId,
        string calldata nextConsumerName,
        string calldata nextOperatorName
    ) external onlyOwner {
        require(bytes(leaseId).length > 0, 'Lease required');
        require(bytes(nextConsumerName).length > 0, 'Consumer required');
        require(bytes(nextOperatorName).length > 0, 'Operator required');
        activeLeaseId = leaseId;
        consumerName = nextConsumerName;
        operatorName = nextOperatorName;
        emit LeaseContextUpdated(leaseId, nextConsumerName, nextOperatorName);
    }

    function setMemberPolicy(address member, bool enabled, uint128 perTxUsd6, uint128 dailyBudgetUsd6) external onlyOwner {
        require(member != address(0), 'Member required');
        if (enabled) {
            require(perTxUsd6 > 0, 'Per tx required');
            require(dailyBudgetUsd6 >= perTxUsd6, 'Daily lt per tx');
        }

        MemberPolicy storage policy = memberPolicies[member];
        if (!policy.exists) {
            policy.exists = true;
            policy.spentTodayUsd6 = 0;
            policy.spentWindowStartedAt = uint64(block.timestamp);
        } else {
            _refreshMemberWindow(policy);
        }

        policy.enabled = enabled;
        policy.perTxUsd6 = perTxUsd6;
        policy.dailyBudgetUsd6 = dailyBudgetUsd6;

        emit MemberPolicyUpdated(member, enabled, perTxUsd6, dailyBudgetUsd6);
    }

    function setAllowedAsset(address asset, bool allowed) external onlyOwner {
        require(asset != address(0), 'Asset required');
        allowedAssets[asset] = allowed;
        emit AllowedAssetUpdated(asset, allowed);
    }

    function setAllowedProtocol(address target, bool allowed) external onlyOwner {
        require(target != address(0), 'Protocol required');
        allowedProtocols[target] = allowed;
        emit AllowedProtocolUpdated(target, allowed);
    }

    /// @notice ERC-8196 hard mode: once enabled, plain executeTransfer /
    ///         executeProtocolCall are disabled. Fund movement requires an
    ///         audit entry produced by TrustLeaseController.executeAction —
    ///         i.e. a policy-compliant, EIP-712-signed action proof.
    function setRequireActionProof(bool enabled) external onlyOwner {
        requireActionProof = enabled;
        emit ActionProofRequiredUpdated(enabled);
    }

    function depositToken(address token, uint256 amount) external onlyOwner {
        require(allowedAssets[token], 'Asset not allowed');
        require(amount > 0, 'Amount required');
        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit TokenDeposited(token, msg.sender, amount);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), 'Receiver required');
        require(amount > 0, 'Amount required');
        _safeTransfer(token, to, amount);
        emit TokenWithdrawn(token, to, amount);
    }

    function withdrawNative(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), 'Receiver required');
        require(amount > 0, 'Amount required');
        require(address(this).balance >= amount, 'Insufficient native');
        (bool ok, ) = to.call{ value: amount }('');
        require(ok, 'Native withdraw failed');
        emit NativeWithdrawn(to, amount);
    }

    function executeTransfer(
        string calldata requestId,
        string calldata leaseId,
        address token,
        address to,
        uint256 amount,
        uint128 spentUsd6
    ) external onlyMember nonReentrant {
        require(!requireActionProof, 'action proof required');
        _executeTransfer(requestId, leaseId, token, to, amount, spentUsd6);
    }

    function executeTransferGuarded(
        string calldata requestId,
        string calldata leaseId,
        address token,
        address to,
        uint256 amount,
        uint128 spentUsd6,
        bytes32 actionAuditId
    ) external onlyMember nonReentrant {
        _consumeActionProof(actionAuditId, "transfer");
        _executeTransfer(requestId, leaseId, token, to, amount, spentUsd6);
    }

    function _executeTransfer(
        string calldata requestId,
        string calldata leaseId,
        address token,
        address to,
        uint256 amount,
        uint128 spentUsd6
    ) internal {
        require(allowedAssets[token], 'Asset not allowed');
        require(to != address(0), 'Receiver required');
        require(amount > 0, 'Amount required');

        _consumeMemberBudget(msg.sender, requestId, spentUsd6);
        _assertControllerGuards(leaseId, requestId, spentUsd6);
        _safeTransfer(token, to, amount);

        emit TransferExecuted(requestId, leaseId, token, to, amount, spentUsd6);
    }

    function executeProtocolCall(
        string calldata requestId,
        string calldata leaseId,
        address target,
        uint256 value,
        bytes calldata data,
        uint128 spentUsd6
    ) external onlyMember nonReentrant returns (bytes memory result) {
        require(!requireActionProof, 'action proof required');
        return _executeProtocolCall(requestId, leaseId, target, value, data, spentUsd6);
    }

    function executeProtocolCallGuarded(
        string calldata requestId,
        string calldata leaseId,
        address target,
        uint256 value,
        bytes calldata data,
        uint128 spentUsd6,
        bytes32 actionAuditId
    ) external onlyMember nonReentrant returns (bytes memory result) {
        _consumeActionProof(actionAuditId, "protocol");
        return _executeProtocolCall(requestId, leaseId, target, value, data, spentUsd6);
    }

    function _executeProtocolCall(
        string calldata requestId,
        string calldata leaseId,
        address target,
        uint256 value,
        bytes calldata data,
        uint128 spentUsd6
    ) internal returns (bytes memory result) {
        require(allowedProtocols[target], 'Protocol not allowed');

        _consumeMemberBudget(msg.sender, requestId, spentUsd6);
        _assertControllerGuards(leaseId, requestId, spentUsd6);

        (bool ok, bytes memory callResult) = target.call{ value: value }(data);
        require(ok, 'Protocol call failed');

        emit ProtocolCallExecuted(requestId, leaseId, target, value, spentUsd6);
        return callResult;
    }

    function _consumeActionProof(bytes32 auditId, string memory actionType) internal {
        require(auditId != bytes32(0), 'proof required');
        require(!usedActionProofs[auditId], 'proof used');

        (
            bool exists,
            bytes32 entryIdUnused,
            uint256 seqUnused,
            bytes32 sessionIdUnused,
            bytes32 previousHashUnused,
            bytes32 contentHashUnused,
            string memory entryActionType,
            address actor,
            bytes32 proofPolicyHash,
            bytes32 payloadHashUnused,
            bytes32 entropyCommitmentUnused,
            uint64 timestampUnused
        ) = controller.auditEntries(auditId);
        require(exists, 'unknown proof');
        require(actor == msg.sender, 'proof actor mismatch');
        require(keccak256(bytes(entryActionType)) == keccak256(bytes(actionType)), 'proof action mismatch');

        (
            bool leaseExists,
            string memory leaseIdUnused,
            address walletUnused,
            string memory consumerNameUnused,
            string memory baseAssetUnused,
            uint64 issuedAtUnused,
            uint64 expiresAtUnused,
            uint8 statusUnused,
            uint128 perTxUnused,
            uint128 dailyUnused,
            uint128 spentUnused,
            uint64 windowUnused,
            uint128 remainingUnused,
            bytes32 leasePolicyHash,
            bytes32 notesHashUnused
        ) = controller.getActiveLeaseByConsumer(consumerName);
        require(leaseExists, 'no lease');
        require(proofPolicyHash == leasePolicyHash, 'proof policy mismatch');

        usedActionProofs[auditId] = true;
        emit ActionProofConsumed(auditId, msg.sender, actionType);
    }

    function previewExecution(
        string calldata leaseId,
        uint128 requestedUsd6
    ) external view returns (bool allowed, uint8 resolvedStatus, uint128 remainingDailyUsd6) {
        return controller.canExecute(leaseId, requestedUsd6);
    }

    function _assertControllerGuards(
        string calldata leaseId,
        string calldata requestId,
        uint128 spentUsd6
    ) internal {
        require(bytes(requestId).length > 0, 'Request required');
        require(bytes(leaseId).length > 0, 'Lease required');
        require(spentUsd6 > 0, 'Spend required');
        if (bytes(activeLeaseId).length > 0) {
            require(_same(leaseId, activeLeaseId), 'Lease mismatch');
        }

        (
            bool exists,
            string memory liveLeaseId,
            address wallet,
            ,
            ,
            ,
            ,
            uint8 status,
            ,
            ,
            ,
            ,
            ,
            ,
            
        ) = controller.getActiveLeaseByConsumer(consumerName);
        require(exists, 'No active lease');
        require(_same(leaseId, liveLeaseId), 'Not active lease');
        require(wallet == address(this), 'Wallet mismatch');
        require(status == 1, 'Lease inactive');

        (bool operatorExists, , uint8 mode, , , ) = controller.getOperator(operatorName);
        require(operatorExists, 'Operator missing');
        require(mode == 1, 'Operator not active');

        controller.enforceAndConsume(leaseId, requestId, spentUsd6);
    }

    function memberBudgetState(
        address member
    ) external view returns (bool exists, bool enabled, uint128 perTxUsd6, uint128 dailyBudgetUsd6, uint128 spentTodayUsd6, uint128 remainingDailyUsd6) {
        MemberPolicy storage policy = memberPolicies[member];
        if (!policy.exists) {
            return (false, false, 0, 0, 0, 0);
        }
        uint128 remaining = _remainingMemberBudget(policy);
        uint128 spent = _spentTodayView(policy);
        return (
            true,
            policy.enabled,
            policy.perTxUsd6,
            policy.dailyBudgetUsd6,
            spent,
            remaining
        );
    }

    function _consumeMemberBudget(address member, string calldata requestId, uint128 spentUsd6) internal {
        require(spentUsd6 > 0, 'Spend required');

        MemberPolicy storage policy = memberPolicies[member];
        require(policy.exists && policy.enabled, 'Member not active');
        _refreshMemberWindow(policy);
        require(spentUsd6 <= policy.perTxUsd6, 'Member per-tx exceeded');
        uint128 remaining = _remainingMemberBudget(policy);
        require(spentUsd6 <= remaining, 'Member daily budget exceeded');

        policy.spentTodayUsd6 += spentUsd6;
        uint128 remainingAfter = policy.dailyBudgetUsd6 - policy.spentTodayUsd6;
        emit MemberSpendConsumed(member, requestId, spentUsd6, remainingAfter);
    }

    function _refreshMemberWindow(MemberPolicy storage policy) internal {
        if (block.timestamp >= policy.spentWindowStartedAt + 1 days) {
            policy.spentTodayUsd6 = 0;
            policy.spentWindowStartedAt = uint64(block.timestamp);
        }
    }

    function _remainingMemberBudget(MemberPolicy storage policy) internal view returns (uint128) {
        if (block.timestamp >= policy.spentWindowStartedAt + 1 days) {
            return policy.dailyBudgetUsd6;
        }
        if (policy.spentTodayUsd6 >= policy.dailyBudgetUsd6) {
            return 0;
        }
        return policy.dailyBudgetUsd6 - policy.spentTodayUsd6;
    }

    function _spentTodayView(MemberPolicy storage policy) internal view returns (uint128) {
        if (block.timestamp >= policy.spentWindowStartedAt + 1 days) {
            return 0;
        }
        return policy.spentTodayUsd6;
    }

    function _same(string memory left, string memory right) internal pure returns (bool) {
        return keccak256(bytes(left)) == keccak256(bytes(right));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature('transfer(address,uint256)', to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), 'Transfer failed');
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature('transferFrom(address,address,uint256)', from, to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), 'TransferFrom failed');
    }
}
