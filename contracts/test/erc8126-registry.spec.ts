import { expect } from "chai";
import { ethers } from "hardhat";

describe("ERC-8126 VerificationScoreRegistry", () => {
  async function deployFixture() {
    const [owner, verifier, attacker, relayer] = await ethers.getSigners();
    const registryFactory = await ethers.getContractFactory("VerificationScoreRegistry");
    const registry = await registryFactory.deploy(owner.address, verifier.address);
    await registry.waitForDeployment();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return { owner, verifier, attacker, relayer, registry, chainId };
  }

  type Ctx = Awaited<ReturnType<typeof deployFixture>>;

  function eip712Domain(ctx: Ctx) {
    return {
      name: "AskGrokWalletVerification",
      version: "1",
      chainId: ctx.chainId,
      verifyingContract: ctx.registry.target as string,
    };
  }

  const ATTESTATION_TYPES = {
    Attestation: [
      { name: "agentId", type: "uint256" },
      { name: "overallRiskScore", type: "uint8" },
      { name: "summaryProofId", type: "bytes32" },
      { name: "issuedAt", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  async function signAttestation(
    ctx: Ctx,
    signer: typeof ctx.verifier,
    opts: {
      agentId?: bigint;
      score?: number;
      proofId?: string;
      issuedAt?: bigint;
      nonce?: bigint;
    } = {},
  ) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return signer.signTypedData(eip712Domain(ctx), ATTESTATION_TYPES, {
      agentId: opts.agentId ?? BigInt(1),
      overallRiskScore: opts.score ?? 10,
      summaryProofId: opts.proofId ?? ethers.keccak256(ethers.toUtf8Bytes("proof")),
      issuedAt: opts.issuedAt ?? now,
      nonce: opts.nonce ?? BigInt(1),
    });
  }

  it("returns max risk for unknown agents and accepts verifier attestations", async () => {
    const ctx = await deployFixture();
    expect(await ctx.registry.getLatestRiskScore(1)).to.equal(100);

    const issuedAt = BigInt(Math.floor(Date.now() / 1000));
    const signature = await signAttestation(ctx, ctx.verifier, { score: 8, issuedAt });
    await (await ctx.registry.connect(ctx.relayer).submitAttestation(
      1,
      8,
      ethers.keccak256(ethers.toUtf8Bytes("proof")),
      issuedAt,
      BigInt(1),
      signature,
    )).wait();

    expect(await ctx.registry.getLatestRiskScore(1)).to.equal(8);
    const record = await ctx.registry.latestAttestation(1);
    expect(record.exists).to.equal(true);
    expect(record.overallRiskScore).to.equal(8);
  });

  it("rejects signatures from non-verifiers and replayed nonces", async () => {
    const ctx = await deployFixture();
    const now = BigInt(Math.floor(Date.now() / 1000));

    const forged = await signAttestation(ctx, ctx.attacker, { nonce: BigInt(1) });
    await expect(
      ctx.registry.submitAttestation(1, 5, ethers.ZeroHash, now, BigInt(1), forged),
    ).to.be.revertedWithCustomError(ctx.registry, "NotVerifier");

    const good = await signAttestation(ctx, ctx.verifier, { nonce: BigInt(2), issuedAt: now, score: 5 });
    const recovered = ethers.verifyTypedData(eip712Domain(ctx), ATTESTATION_TYPES, {
      agentId: BigInt(1),
      overallRiskScore: 5,
      summaryProofId: ethers.keccak256(ethers.toUtf8Bytes("proof")),
      issuedAt: now,
      nonce: BigInt(2),
    }, good);
    expect(recovered).to.equal(ctx.verifier.address);
    const onchainDomain = await ctx.registry.DOMAIN_SEPARATOR();
    const expectedDomain = ethers.TypedDataEncoder.hashDomain(eip712Domain(ctx));
    expect(onchainDomain).to.equal(expectedDomain);
    const proofId = ethers.keccak256(ethers.toUtf8Bytes("proof"));
    await (await ctx.registry.submitAttestation(1, 5, proofId, now, BigInt(2), good)).wait();

    await expect(
      ctx.registry.submitAttestation(1, 5, ethers.ZeroHash, now, BigInt(2), good),
    ).to.be.revertedWithCustomError(ctx.registry, "NonceUsed");
  });

  it("rejects stale and future attestations", async () => {
    const ctx = await deployFixture();
    const now = BigInt(Math.floor(Date.now() / 1000));

    const stale = await signAttestation(ctx, ctx.verifier, {
      issuedAt: now - BigInt(8 * 24 * 3600),
    });
    await expect(
      ctx.registry.submitAttestation(1, 5, ethers.ZeroHash, now - BigInt(8 * 24 * 3600), BigInt(1), stale),
    ).to.be.revertedWithCustomError(ctx.registry, "AttestationTooOld");

    const future = await signAttestation(ctx, ctx.verifier, {
      issuedAt: now + BigInt(3600),
    });
    await expect(
      ctx.registry.submitAttestation(1, 5, ethers.ZeroHash, now + BigInt(3600), BigInt(2), future),
    ).to.be.revertedWithCustomError(ctx.registry, "AttestationFromFuture");
  });
});
