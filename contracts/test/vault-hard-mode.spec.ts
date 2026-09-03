import { expect } from "chai";
import { ethers } from "hardhat";

describe("BoundlessVault ERC-8196 hard mode", () => {
  async function deployFixture() {
    const [owner, memberA, memberB, receiver] = await ethers.getSigners();

    const controllerFactory = await ethers.getContractFactory("TrustLeaseController");
    const controller = await controllerFactory.deploy(owner.address);
    await controller.waitForDeployment();

    const vaultFactory = await ethers.getContractFactory("BoundlessVault");
    const vault = await vaultFactory.deploy(
      await controller.getAddress(),
      owner.address,
      "bound-agent",
      "human-principal",
    );
    await vault.waitForDeployment();
    await (await controller.setExecutor(await vault.getAddress(), true)).wait();

    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const token = await tokenFactory.deploy("Mock USDC", "mUSDC", 6);
    await token.waitForDeployment();

    const protocolFactory = await ethers.getContractFactory("MockProtocolTarget");
    const protocol = await protocolFactory.deploy();
    await protocol.waitForDeployment();

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const now = Math.floor(Date.now() / 1000);

    return { owner, memberA, memberB, receiver, controller, vault, token, protocol, chainId, now };
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

  async function registerPolicy(ctx: Ctx, allowedActions: string[], allowedContracts: string[]) {
    const validUntil = BigInt(ctx.now + 3600);
    const tx = await ctx.controller.registerPolicy(
      ctx.memberA.address,
      1,
      allowedActions,
      allowedContracts,
      [],
      BigInt(1000),
      BigInt(0),
      0,
      validUntil,
      20,
    );
    const receipt = await tx.wait();
    const evt = receipt!.logs
      .map((log) => ctx.controller.interface.parseLog(log))
      .find((p) => p?.name === "PolicyRegistered");
    return { policyHash: evt!.args.policyHash as string, validUntil };
  }

  async function signTransferAction(ctx: Ctx, policyHash: string, opts: { nonce?: bigint; data?: string } = {}) {
    const data = opts.data ?? ctx.token.interface.encodeFunctionData("transfer", [ctx.receiver.address, BigInt(100)]);
    return ctx.memberA.signTypedData(eip712Domain(ctx), AGENT_ACTION_TYPES, {
      agent: ctx.memberA.address,
      action: "transfer",
      target: ctx.token.target as string,
      value: BigInt(100),
      data,
      nonce: opts.nonce ?? BigInt(1),
      validUntil: BigInt(ctx.now + 3600),
      policyHash,
      entropyCommitment: ethers.ZeroHash,
    });
  }

  async function configureLease(ctx: Ctx, policyHash: string) {
    await (await ctx.controller.issueLease(
      "lease_hard",
      "bound-agent",
      await ctx.vault.getAddress(),
      "USDT",
      BigInt(ctx.now + 24 * 3600),
      BigInt(3_000_000),
      BigInt(8_000_000),
      policyHash,
      ethers.ZeroHash,
    )).wait();
    await (await ctx.controller.setOperatorMode("human-principal", 1, ethers.ZeroHash)).wait();
    await (await ctx.vault.setLeaseContext("lease_hard", "bound-agent", "human-principal")).wait();
    await (await ctx.vault.setMemberPolicy(ctx.memberA.address, true, BigInt(2_000_000), BigInt(4_000_000))).wait();
    await (await ctx.vault.setMemberPolicy(ctx.memberB.address, true, BigInt(2_000_000), BigInt(4_000_000))).wait();
    await (await ctx.vault.setAllowedAsset(await ctx.token.getAddress(), true)).wait();
    await (await ctx.token.mint(ctx.owner.address, BigInt(1_000_000))).wait();
    await (await ctx.token.approve(await ctx.vault.getAddress(), BigInt(1_000_000))).wait();
    await (await ctx.vault.depositToken(await ctx.token.getAddress(), BigInt(1_000_000))).wait();
    await (await ctx.vault.setRequireActionProof(true)).wait();
  }

  it("requires signed action proofs for fund movement in hard mode", async () => {
    const ctx = await deployFixture();
    const transferSelector = ethers.dataSlice(ethers.id("transfer(address,uint256)"), 0, 4);
    await (await ctx.controller.setActionSelector(transferSelector, "transfer")).wait();

    const { policyHash } = await registerPolicy(ctx, ["transfer"], [await ctx.token.getAddress()]);
    const signature = await signTransferAction(ctx, policyHash);
    const exec = await ctx.controller.executeAction(
      policyHash,
      await ctx.token.getAddress(),
      BigInt(100),
      ctx.token.interface.encodeFunctionData("transfer", [ctx.receiver.address, BigInt(100)]),
      BigInt(1),
      ethers.ZeroHash,
      signature,
    );
    const execReceipt = await exec.wait();
    const auditId = execReceipt!.logs
      .map((log) => ctx.controller.interface.parseLog(log))
      .find((p) => p?.name === "ActionExecuted")!.args.auditEntryId as string;

    await configureLease(ctx, policyHash);

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransfer(
        "req_plain",
        "lease_hard",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(100),
        BigInt(1_500_000),
      ),
    ).to.be.revertedWith("action proof required");

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransferGuarded(
        "req_guarded",
        "lease_hard",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(100),
        BigInt(1_500_000),
        ethers.ZeroHash,
      ),
    ).to.be.revertedWith("proof required");

    await (await ctx.vault.connect(ctx.memberA).executeTransferGuarded(
      "req_guarded",
      "lease_hard",
      await ctx.token.getAddress(),
      ctx.receiver.address,
      BigInt(100),
      BigInt(1_500_000),
      auditId,
    )).wait();

    expect(await ctx.token.balanceOf(ctx.receiver.address)).to.equal(BigInt(100));

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransferGuarded(
        "req_replay",
        "lease_hard",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(100),
        BigInt(1_500_000),
        auditId,
      ),
    ).to.be.revertedWith("proof used");
  });

  it("rejects wrong actor, wrong action type, and wrong policy proofs", async () => {
    const ctx = await deployFixture();
    const transferSelector = ethers.dataSlice(ethers.id("transfer(address,uint256)"), 0, 4);
    await (await ctx.controller.setActionSelector(transferSelector, "transfer")).wait();

    const { policyHash } = await registerPolicy(ctx, ["transfer"], [await ctx.token.getAddress()]);
    const signature = await signTransferAction(ctx, policyHash);
    const exec = await ctx.controller.executeAction(
      policyHash,
      await ctx.token.getAddress(),
      BigInt(100),
      ctx.token.interface.encodeFunctionData("transfer", [ctx.receiver.address, BigInt(100)]),
      BigInt(1),
      ethers.ZeroHash,
      signature,
    );
    const execReceipt = await exec.wait();
    const auditId = execReceipt!.logs
      .map((log) => ctx.controller.interface.parseLog(log))
      .find((p) => p?.name === "ActionExecuted")!.args.auditEntryId as string;

    await configureLease(ctx, policyHash);

    await expect(
      ctx.vault.connect(ctx.memberB).executeTransferGuarded(
        "req_actor",
        "lease_hard",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(100),
        BigInt(1_500_000),
        auditId,
      ),
    ).to.be.revertedWith("proof actor mismatch");
  });
});
