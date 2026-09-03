import { expect } from "chai";
import { ethers } from "hardhat";

describe("ERC-8196 AI Agent Authenticated Wallet", () => {
  async function deployFixture() {
    const [owner, agent, agentB, receiver, relayer] = await ethers.getSigners();

    const controllerFactory = await ethers.getContractFactory("TrustLeaseController");
    const controller = await controllerFactory.deploy(owner.address);
    await controller.waitForDeployment();

    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const token = await tokenFactory.deploy("Mock USDC", "mUSDC", 6);
    await token.waitForDeployment();

    const oracleFactory = await ethers.getContractFactory("MockRiskOracle");
    const oracle = await oracleFactory.deploy();
    await oracle.waitForDeployment();

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const now = Math.floor(Date.now() / 1000);

    return { owner, agent, agentB, receiver, relayer, controller, token, oracle, chainId, now };
  }

  type Ctx = Awaited<ReturnType<typeof deployFixture>>;

  function eip712Domain(ctx: Ctx) {
    return {
      name: "AskGrokWallet",
      version: "1",
      chainId: ctx.chainId,
      verifyingContract: ctx.controller.target as string,
    };
  }

  const AGENT_ACTION_TYPES = {
    AgentAction: [
      { name: "agent", type: "address" },
      { name: "action", type: "string" },
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "nonce", type: "uint256" },
      { name: "validUntil", type: "uint256" },
      { name: "policyHash", type: "bytes32" },
      { name: "entropyCommitment", type: "bytes32" },
    ],
  };

  async function registerTransferPolicy(
    ctx: Ctx,
    opts: {
      allowedActions?: string[];
      allowedContracts?: string[];
      blockedContracts?: string[];
      maxValuePerTx?: bigint;
      maxValuePerDay?: bigint;
      validUntil?: bigint;
      minVerificationScore?: number;
    } = {},
  ) {
    const perTx = opts.maxValuePerTx ?? BigInt(1000);
    const perDay = opts.maxValuePerDay ?? BigInt(0);
    const validUntil = opts.validUntil ?? BigInt(ctx.now + 3600);
    const tx = await ctx.controller.registerPolicy(
      ctx.agent.address,
      1,
      opts.allowedActions ?? ["transfer"],
      opts.allowedContracts ?? [],
      opts.blockedContracts ?? [],
      perTx,
      perDay,
      0,
      validUntil,
      opts.minVerificationScore ?? 20,
    );
    const receipt = await tx.wait();
    const transferSelector = ethers.dataSlice(ethers.id("transfer(address,uint256)"), 0, 4);
    await (await ctx.controller.setActionSelector(transferSelector, "transfer")).wait();
    const evt = receipt!.logs
      .map((log) => {
        try {
          return ctx.controller.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "PolicyRegistered");
    return { policyHash: evt!.args.policyHash as string, validUntil };
  }

  function transferData(ctx: Ctx, amount: bigint) {
    return ctx.token.interface.encodeFunctionData("transfer", [ctx.receiver.address, amount]);
  }

  async function signAction(
    ctx: Ctx,
    signer: Awaited<ReturnType<typeof deployFixture>>["agent"],
    policyHash: string,
    opts: {
      action?: string;
      target?: string;
      value?: bigint;
      data?: string;
      nonce?: bigint;
      validUntil?: bigint;
      entropyCommitment?: string;
    } = {},
  ) {
    const validUntil = opts.validUntil ?? BigInt(ctx.now + 3600);
    return signer.signTypedData(eip712Domain(ctx), AGENT_ACTION_TYPES, {
      agent: signer.address,
      action: opts.action ?? "transfer",
      target: opts.target ?? (ctx.token.target as string),
      value: opts.value ?? BigInt(100),
      data: opts.data ?? transferData(ctx, BigInt(100)),
      nonce: opts.nonce ?? BigInt(1),
      validUntil,
      policyHash,
      entropyCommitment: opts.entropyCommitment ?? ethers.ZeroHash,
    });
  }

  it("registers a policy and exposes it through getPolicy", async () => {
    const ctx = await deployFixture();
    const { policyHash, validUntil } = await registerTransferPolicy(ctx);

    const policy = await ctx.controller.getPolicy(policyHash);
    expect(policy[0]).to.equal(ctx.agent.address);
    expect(policy[1]).to.equal(ctx.owner.address);
    expect(policy[2]).to.equal(BigInt(1000));
    expect(policy[3]).to.equal(validUntil);
    expect(policy[4]).to.equal(true);

    await expect(
      ctx.controller.registerPolicy(
        ctx.agent.address,
        1,
        ["transfer"],
        [],
        [],
        BigInt(1000),
        BigInt(0),
        0,
        validUntil,
        20,
      ),
    ).to.be.revertedWith("policy exists");
  });

  it("executes a signed action and writes the first audit entry", async () => {
    const ctx = await deployFixture();
    const { policyHash } = await registerTransferPolicy(ctx);
    const signature = await signAction(ctx, ctx.agent, policyHash);

    const tx = await ctx.controller.connect(ctx.relayer).executeAction.staticCall(
      policyHash,
      ctx.token.target as string,
      BigInt(100),
      transferData(ctx, BigInt(100)),
      BigInt(1),
      ethers.ZeroHash,
      signature,
    );
    expect(tx[0]).to.equal(true);

    const result = await ctx.controller.connect(ctx.relayer).executeAction(
      policyHash,
      ctx.token.target as string,
      BigInt(100),
      transferData(ctx, BigInt(100)),
      BigInt(1),
      ethers.ZeroHash,
      signature,
    );
    const receipt = await result.wait();
    const parsed = receipt!.logs
      .map((log) => {
        try {
          return ctx.controller.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((p) => p !== null);
    const executed = parsed.find((p) => p!.name === "ActionExecuted");
    const logged = parsed.find((p) => p!.name === "AuditEntryLogged");

    const entryId = executed!.args.auditEntryId as string;
    expect(logged!.args.entryId).to.equal(entryId);
    expect(logged!.args.sequence).to.equal(BigInt(1));

    const entry = await ctx.controller.auditEntries(entryId);
    expect(entry.exists).to.equal(true);
    expect(entry.actionType).to.equal("transfer");
    expect(entry.actor).to.equal(ctx.agent.address);
    expect(entry.policyHash).to.equal(policyHash);
    expect(entry.previousHash).to.equal(ethers.ZeroHash);
  });

  it("hash-chains audit entries and verifies chain integrity", async () => {
    const ctx = await deployFixture();
    const { policyHash } = await registerTransferPolicy(ctx);

    const sig1 = await signAction(ctx, ctx.agent, policyHash, { nonce: BigInt(1) });
    const sig2 = await signAction(ctx, ctx.agent, policyHash, {
      nonce: BigInt(2),
      value: BigInt(200),
      data: transferData(ctx, BigInt(200)),
    });

    const r1 = await (await ctx.controller.executeAction(
      policyHash,
      ctx.token.target as string,
      BigInt(100),
      transferData(ctx, BigInt(100)),
      BigInt(1),
      ethers.ZeroHash,
      sig1,
    )).wait();
    const r2 = await (await ctx.controller.executeAction(
      policyHash,
      ctx.token.target as string,
      BigInt(200),
      transferData(ctx, BigInt(200)),
      BigInt(2),
      ethers.ZeroHash,
      sig2,
    )).wait();

    const logs1 = r1!.logs.map((log) => ctx.controller.interface.parseLog(log)).find((p) => p?.name === "ActionExecuted");
    const logs2 = r2!.logs.map((log) => ctx.controller.interface.parseLog(log)).find((p) => p?.name === "ActionExecuted");
    const id1 = logs1!.args.auditEntryId as string;
    const id2 = logs2!.args.auditEntryId as string;

    const entry2 = await ctx.controller.auditEntries(id2);
    expect(entry2.previousHash).to.equal(id1);
    expect(entry2.sequence).to.equal(BigInt(2));

    expect(await ctx.controller.verifyAuditChain([id1, id2])).to.equal(true);
    expect(await ctx.controller.verifyAuditChain([id2, id1])).to.equal(false);
    expect(await ctx.controller.verifyAuditChain([id1, id1])).to.equal(false);
  });

  it("rejects wrong signer, over-limit values, unknown actions, and replay", async () => {
    const ctx = await deployFixture();
    const { policyHash } = await registerTransferPolicy(ctx);

    const wrongSig = await signAction(ctx, ctx.agentB, policyHash);
    await expect(
      ctx.controller.executeAction(
        policyHash,
        ctx.token.target as string,
        BigInt(100),
        transferData(ctx, BigInt(100)),
        BigInt(1),
        ethers.ZeroHash,
        wrongSig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "InvalidSignature");

    const overSig = await signAction(ctx, ctx.agent, policyHash, { value: BigInt(1001) });
    await expect(
      ctx.controller.executeAction(
        policyHash,
        ctx.token.target as string,
        BigInt(1001),
        transferData(ctx, BigInt(1001)),
        BigInt(1),
        ethers.ZeroHash,
        overSig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "ValueExceedsLimit");

    const goodSig = await signAction(ctx, ctx.agent, policyHash, { nonce: BigInt(1) });
    await (await ctx.controller.executeAction(
      policyHash,
      ctx.token.target as string,
      BigInt(100),
      transferData(ctx, BigInt(100)),
      BigInt(1),
      ethers.ZeroHash,
      goodSig,
    )).wait();

    await expect(
      ctx.controller.executeAction(
        policyHash,
        ctx.token.target as string,
        BigInt(100),
        transferData(ctx, BigInt(100)),
        BigInt(1),
        ethers.ZeroHash,
        goodSig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "NonceUsed");
  });

  it("enforces allowed contracts, blocked contracts, and action allowlist", async () => {
    const ctx = await deployFixture();

    const blocked = await registerTransferPolicy(ctx, {
      blockedContracts: [ctx.token.target as string],
    });
    const blockedSig = await signAction(ctx, ctx.agent, blocked.policyHash);
    await expect(
      ctx.controller.executeAction(
        blocked.policyHash,
        ctx.token.target as string,
        BigInt(100),
        transferData(ctx, BigInt(100)),
        BigInt(1),
        ethers.ZeroHash,
        blockedSig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "ContractBlocked");

    const allowlisted = await registerTransferPolicy(ctx, {
      allowedContracts: [ctx.receiver.address],
    });
    const allowSig = await signAction(ctx, ctx.agent, allowlisted.policyHash);
    await expect(
      ctx.controller.executeAction(
        allowlisted.policyHash,
        ctx.token.target as string,
        BigInt(100),
        transferData(ctx, BigInt(100)),
        BigInt(1),
        ethers.ZeroHash,
        allowSig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "ContractNotAllowed");

    const swapSelector = ethers.dataSlice(ethers.id("swap(address,uint256)"), 0, 4);
    await (await ctx.controller.setActionSelector(swapSelector, "swap")).wait();
    const actionOnlyTransfer = await registerTransferPolicy(ctx);
    const swapData = ethers.concat([swapSelector, "0x" + "00".repeat(64)]);
    const swapSig = await signAction(ctx, ctx.agent, actionOnlyTransfer.policyHash, {
      action: "swap",
      data: swapData,
    });
    await expect(
      ctx.controller.executeAction(
        actionOnlyTransfer.policyHash,
        ctx.token.target as string,
        BigInt(100),
        swapData,
        BigInt(1),
        ethers.ZeroHash,
        swapSig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "ActionNotAllowed");
  });

  it("enforces daily spend limits", async () => {
    const ctx = await deployFixture();
    const { policyHash } = await registerTransferPolicy(ctx, {
      maxValuePerTx: BigInt(100),
      maxValuePerDay: BigInt(250),
    });

    const sig1 = await signAction(ctx, ctx.agent, policyHash, { nonce: BigInt(1), value: BigInt(100) });
    await (await ctx.controller.executeAction(
      policyHash,
      ctx.token.target as string,
      BigInt(100),
      transferData(ctx, BigInt(100)),
      BigInt(1),
      ethers.ZeroHash,
      sig1,
    )).wait();

    const sig2 = await signAction(ctx, ctx.agent, policyHash, { nonce: BigInt(2), value: BigInt(200) });
    await expect(
      ctx.controller.executeAction(
        policyHash,
        ctx.token.target as string,
        BigInt(200),
        transferData(ctx, BigInt(200)),
        BigInt(2),
        ethers.ZeroHash,
        sig2,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "ValueExceedsLimit");
  });

  it("rejects expired and revoked policies", async () => {
    const ctx = await deployFixture();
    const expired = await registerTransferPolicy(ctx, { validUntil: BigInt(ctx.now - 1) });
    const expiredSig = await signAction(ctx, ctx.agent, expired.policyHash, { validUntil: BigInt(ctx.now - 1) });
    await expect(
      ctx.controller.executeAction(
        expired.policyHash,
        ctx.token.target as string,
        BigInt(100),
        transferData(ctx, BigInt(100)),
        BigInt(1),
        ethers.ZeroHash,
        expiredSig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "PolicyExpired");

    const { policyHash } = await registerTransferPolicy(ctx);
    await (await ctx.controller.revokePolicy(policyHash, "agent compromised")).wait();
    expect((await ctx.controller.getPolicy(policyHash))[4]).to.equal(false);

    const revokedSig = await signAction(ctx, ctx.agent, policyHash);
    await expect(
      ctx.controller.executeAction(
        policyHash,
        ctx.token.target as string,
        BigInt(100),
        transferData(ctx, BigInt(100)),
        BigInt(1),
        ethers.ZeroHash,
        revokedSig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "PolicyViolation");
  });

  it("gates execution on ERC-8126-style risk score", async () => {
    const ctx = await deployFixture();
    const { policyHash } = await registerTransferPolicy(ctx, { minVerificationScore: 20 });
    await (await ctx.controller.setRiskOracle(ctx.oracle.target as string)).wait();

    await (await ctx.oracle.setRisk(30)).wait();
    const sig = await signAction(ctx, ctx.agent, policyHash);
    await expect(
      ctx.controller.executeAction(
        policyHash,
        ctx.token.target as string,
        BigInt(100),
        transferData(ctx, BigInt(100)),
        BigInt(1),
        ethers.ZeroHash,
        sig,
      ),
    ).to.be.revertedWithCustomError(ctx.controller, "RiskScoreExceeded");

    await (await ctx.oracle.setRisk(10)).wait();
    await expect(
      ctx.controller.executeAction(
        policyHash,
        ctx.token.target as string,
        BigInt(100),
        transferData(ctx, BigInt(100)),
        BigInt(1),
        ethers.ZeroHash,
        sig,
      ),
    ).to.not.be.reverted;
  });

  it("verifies entropy commit-reveal", async () => {
    const ctx = await deployFixture();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("s3cr3t"));
    const commitment = ethers.solidityPackedKeccak256(["bytes32"], [secret]);

    expect(await ctx.controller.verifyEntropyReveal(commitment, secret)).to.equal(true);
    await expect(ctx.controller.verifyEntropyReveal(commitment, ethers.ZeroHash)).to.be.revertedWithCustomError(
      ctx.controller,
      "EntropyVerificationFailed",
    );
  });

  it("chains receipt anchors into the consumer audit trail", async () => {
    const ctx = await deployFixture();
    await (await ctx.controller.issueLease(
      "lease_8196",
      "consumer_8196",
      ctx.owner.address,
      "USDT",
      BigInt(ctx.now + 3600),
      BigInt(1_000_000),
      BigInt(5_000_000),
      ethers.ZeroHash,
      ethers.ZeroHash,
    )).wait();

    await (await ctx.controller.anchorReceipt(
      "lease_8196",
      "req_8196_1",
      "consumer_8196",
      1,
      4,
      100,
      ethers.keccak256(ethers.toUtf8Bytes("tx1")),
      ethers.keccak256(ethers.toUtf8Bytes("proof1")),
      "ipfs://1",
    )).wait();
    await (await ctx.controller.anchorReceipt(
      "lease_8196",
      "req_8196_2",
      "consumer_8196",
      1,
      4,
      200,
      ethers.keccak256(ethers.toUtf8Bytes("tx2")),
      ethers.keccak256(ethers.toUtf8Bytes("proof2")),
      "ipfs://2",
    )).wait();

    const sessionId = await ctx.controller.consumerKey("consumer_8196");
    expect(await ctx.controller.auditSequenceBySession(sessionId)).to.equal(BigInt(2));

    const id1 = ethers.solidityPackedKeccak256(["bytes32", "uint256"], [sessionId, 1]);
    const id2 = ethers.solidityPackedKeccak256(["bytes32", "uint256"], [sessionId, 2]);
    expect(await ctx.controller.auditHeadBySession(sessionId)).to.equal(id2);
    expect((await ctx.controller.auditEntries(id2)).previousHash).to.equal(id1);
    expect(await ctx.controller.verifyAuditChain([id1, id2])).to.equal(true);

    const latest = await ctx.controller.getLatestReceiptByConsumer("consumer_8196");
    expect(latest.exists).to.equal(true);
    expect(latest.requestId_).to.equal("req_8196_2");
  });
});
