// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice On-chain ERC-8126-style risk score registry for AI agents.
///         Attestations are submitted by a designated verification provider and
///         carry an EIP-712 signature so any relayer can post them.
///         Implements IERC8126#getLatestRiskScore as consumed by ERC-8196
///         policy execution gates.
contract VerificationScoreRegistry {
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(uint256 agentId,uint8 overallRiskScore,bytes32 summaryProofId,uint256 issuedAt,uint256 nonce)");
    string public constant NAME = "AskGrokWalletVerification";
    string public constant VERSION = "1";

    uint256 private _chainId;
    bytes32 private _cachedDomainSeparator;

    address public owner;
    address public verifier;
    uint256 public maxAttestationAge = 7 days;

    struct AttestationRecord {
        bool exists;
        uint8 overallRiskScore;
        bytes32 summaryProofId;
        uint256 issuedAt;
    }

    mapping(uint256 => AttestationRecord) public latestAttestation;
    mapping(uint256 => uint256) public usedNonces;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierUpdated(address indexed verifier);
    event MaxAttestationAgeUpdated(uint256 maxAge);
    event AgentVerified(
        uint256 indexed agentId,
        uint8 overallRiskScore,
        bytes32 etvProofId,
        bytes32 mcvProofId,
        bytes32 scvProofId,
        bytes32 wavProofId,
        bytes32 wvProofId,
        bytes32 summaryProofId
    );
    event AttestationPosted(uint256 indexed agentId, uint8 riskScore, bytes32 proofId);

    error NotOwner(address caller);
    error NotVerifier(address recovered, address expected);
    error AttestationTooOld(uint256 issuedAt, uint256 maxAge);
    error AttestationFromFuture(uint256 issuedAt);
    error NonceUsed(uint256 nonce);
    error BadSignatureLength(uint256 length);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor(address initialOwner, address initialVerifier) {
        owner = initialOwner == address(0) ? msg.sender : initialOwner;
        verifier = initialVerifier;
        _chainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit OwnershipTransferred(address(0), owner);
        emit VerifierUpdated(initialVerifier);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), 'Zero address');
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setVerifier(address nextVerifier) external onlyOwner {
        verifier = nextVerifier;
        emit VerifierUpdated(nextVerifier);
    }

    function setMaxAttestationAge(uint256 maxAge) external onlyOwner {
        maxAttestationAge = maxAge;
        emit MaxAttestationAgeUpdated(maxAge);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Posts a fresh risk score attestation. The EIP-712 signature must
    ///         come from the configured verification provider.
    function submitAttestation(
        uint256 agentId,
        uint8 overallRiskScore,
        bytes32 summaryProofId,
        uint256 issuedAt,
        uint256 nonce,
        bytes calldata signature
    ) external {
        if (issuedAt > block.timestamp + 5 minutes) revert AttestationFromFuture(issuedAt);
        if (block.timestamp > issuedAt + maxAttestationAge) revert AttestationTooOld(issuedAt, maxAttestationAge);
        if (usedNonces[nonce] != 0) revert NonceUsed(nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                agentId,
                overallRiskScore,
                summaryProofId,
                issuedAt,
                nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = _recoverSigner(digest, signature);
        if (recovered != verifier) revert NotVerifier(recovered, verifier);

        usedNonces[nonce] = 1;
        latestAttestation[agentId] = AttestationRecord({
            exists: true,
            overallRiskScore: overallRiskScore,
            summaryProofId: summaryProofId,
            issuedAt: issuedAt
        });

        emit AgentVerified(agentId, overallRiskScore, bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0), summaryProofId);
        emit AttestationPosted(agentId, overallRiskScore, summaryProofId);
    }

    /// @notice ERC-8126 optional interface. Unknown agents return 100 (max
    ///         risk) so unverified agents are treated as untrusted by default.
    function getLatestRiskScore(uint256 agentId) external view returns (uint8) {
        AttestationRecord storage record = latestAttestation[agentId];
        if (!record.exists) return 100;
        return record.overallRiskScore;
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash));
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

    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert BadSignatureLength(signature.length);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(digest, v, r, s);
    }
}
