import { expect } from "chai";
import { ethers } from "hardhat";

describe("BoundlessVault hard guard", () => {
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

    const mockTokenFactory = await ethers.getContractFactory("MockERC20");
    const token = await mockTokenFactory.deploy("Mock USDC", "mUSDC", 6);
    await token.waitForDeployment();

    const protocolFactory = await ethers.getContractFactory("MockProtocolTarget");
    const protocol = await protocolFactory.deploy();
    await protocol.waitForDeployment();

    return {
      owner,
      memberA,
      memberB,
      receiver,
      controller,
      vault,
      token,
      protocol,
    };
  }

  async function configureRule(ctx: Awaited<ReturnType<typeof deployFixture>>, options?: { perTxUsd6?: bigint; dailyUsd6?: bigint }) {
    const perTx = options?.perTxUsd6 ?? BigInt(2_000_000);
    const daily = options?.dailyUsd6 ?? BigInt(5_000_000);
    await (await ctx.controller.issueLease(
      "lease_demo_1",
      "bound-agent",
      await ctx.vault.getAddress(),
      "USDT",
      BigInt(Math.floor(Date.now() / 1000) + 24 * 3600),
      perTx,
      daily,
      ethers.ZeroHash,
      ethers.ZeroHash,
    )).wait();
    await (await ctx.controller.setOperatorMode("human-principal", 1, ethers.ZeroHash)).wait();
    await (await ctx.vault.setLeaseContext("lease_demo_1", "bound-agent", "human-principal")).wait();
  }

  it("allows member execution within member and global budgets", async () => {
    const ctx = await deployFixture();
    await configureRule(ctx, { perTxUsd6: BigInt(3_000_000), dailyUsd6: BigInt(8_000_000) });

    await (await ctx.vault.setMemberPolicy(ctx.memberA.address, true, BigInt(2_000_000), BigInt(4_000_000))).wait();
    await (await ctx.vault.setAllowedAsset(await ctx.token.getAddress(), true)).wait();

    await (await ctx.token.mint(ctx.owner.address, BigInt(1_000_000_000))).wait();
    await (await ctx.token.approve(await ctx.vault.getAddress(), BigInt(5_000_000))).wait();
    await (await ctx.vault.depositToken(await ctx.token.getAddress(), BigInt(5_000_000))).wait();

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransfer(
        "req_success_1",
        "lease_demo_1",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(200_000),
        BigInt(1_500_000),
      )
    ).to.not.be.reverted;

    const receiverBalance = await ctx.token.balanceOf(ctx.receiver.address);
    expect(receiverBalance).to.equal(BigInt(200_000));

    const memberBudget = await ctx.vault.memberBudgetState(ctx.memberA.address);
    expect(memberBudget.exists).to.equal(true);
    expect(memberBudget.spentTodayUsd6).to.equal(BigInt(1_500_000));
    expect(memberBudget.remainingDailyUsd6).to.equal(BigInt(2_500_000));
  });

  it("blocks when member per-tx or daily budget is exceeded", async () => {
    const ctx = await deployFixture();
    await configureRule(ctx, { perTxUsd6: BigInt(3_000_000), dailyUsd6: BigInt(10_000_000) });

    await (await ctx.vault.setMemberPolicy(ctx.memberA.address, true, BigInt(2_000_000), BigInt(2_000_000))).wait();
    await (await ctx.vault.setAllowedAsset(await ctx.token.getAddress(), true)).wait();
    await (await ctx.token.mint(ctx.owner.address, BigInt(1_000_000))).wait();
    await (await ctx.token.approve(await ctx.vault.getAddress(), BigInt(1_000_000))).wait();
    await (await ctx.vault.depositToken(await ctx.token.getAddress(), BigInt(1_000_000))).wait();

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransfer(
        "req_member_per_tx_fail",
        "lease_demo_1",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(10_000),
        BigInt(2_100_000),
      )
    ).to.be.revertedWith("Member per-tx exceeded");

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransfer(
        "req_member_ok_1",
        "lease_demo_1",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(10_000),
        BigInt(1_000_000),
      )
    ).to.not.be.reverted;

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransfer(
        "req_member_daily_fail",
        "lease_demo_1",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(10_000),
        BigInt(1_100_000),
      )
    ).to.be.revertedWith("Member daily budget exceeded");
  });

  it("blocks non-member, review mode, and request replay", async () => {
    const ctx = await deployFixture();
    await configureRule(ctx, { perTxUsd6: BigInt(3_000_000), dailyUsd6: BigInt(8_000_000) });
    await (await ctx.vault.setMemberPolicy(ctx.memberA.address, true, BigInt(2_000_000), BigInt(4_000_000))).wait();
    await (await ctx.vault.setAllowedAsset(await ctx.token.getAddress(), true)).wait();
    await (await ctx.token.mint(ctx.owner.address, BigInt(1_000_000))).wait();
    await (await ctx.token.approve(await ctx.vault.getAddress(), BigInt(1_000_000))).wait();
    await (await ctx.vault.depositToken(await ctx.token.getAddress(), BigInt(1_000_000))).wait();

    await expect(
      ctx.vault.connect(ctx.memberB).executeTransfer(
        "req_non_member",
        "lease_demo_1",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(10_000),
        BigInt(500_000),
      )
    ).to.be.revertedWith("Member not allowed");

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransfer(
        "req_replay_1",
        "lease_demo_1",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(10_000),
        BigInt(500_000),
      )
    ).to.not.be.reverted;

    await expect(
      ctx.vault.connect(ctx.memberA).executeTransfer(
        "req_replay_1",
        "lease_demo_1",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(10_000),
        BigInt(500_000),
      )
    ).to.be.revertedWith("request consumed");

    await (await ctx.controller.setOperatorMode("human-principal", 2, ethers.ZeroHash)).wait();
    await expect(
      ctx.vault.connect(ctx.memberA).executeTransfer(
        "req_review_block",
        "lease_demo_1",
        await ctx.token.getAddress(),
        ctx.receiver.address,
        BigInt(10_000),
        BigInt(500_000),
      )
    ).to.be.revertedWith("Operator not active");
  });

  it("enforces global controller budget and protocol allowlist", async () => {
    const ctx = await deployFixture();
    await configureRule(ctx, { perTxUsd6: BigInt(1_000_000), dailyUsd6: BigInt(1_500_000) });
    await (await ctx.vault.setMemberPolicy(ctx.memberA.address, true, BigInt(3_000_000), BigInt(5_000_000))).wait();
    await (await ctx.vault.setAllowedProtocol(await ctx.protocol.getAddress(), true)).wait();

    await expect(
      ctx.vault.connect(ctx.memberA).executeProtocolCall(
        "req_global_per_tx_fail",
        "lease_demo_1",
        await ctx.protocol.getAddress(),
        BigInt(0),
        ctx.protocol.interface.encodeFunctionData("ping", [ethers.encodeBytes32String("A")]),
        BigInt(1_200_000),
      )
    ).to.be.revertedWith("per-tx exceeded");

    await expect(
      ctx.vault.connect(ctx.memberA).executeProtocolCall(
        "req_protocol_ok",
        "lease_demo_1",
        await ctx.protocol.getAddress(),
        BigInt(0),
        ctx.protocol.interface.encodeFunctionData("ping", [ethers.encodeBytes32String("B")]),
        BigInt(900_000),
      )
    ).to.not.be.reverted;

    const rogueProtocolFactory = await ethers.getContractFactory("MockProtocolTarget");
    const rogueProtocol = await rogueProtocolFactory.deploy();
    await rogueProtocol.waitForDeployment();

    await expect(
      ctx.vault.connect(ctx.memberA).executeProtocolCall(
        "req_protocol_not_allowed",
        "lease_demo_1",
        await rogueProtocol.getAddress(),
        BigInt(0),
        rogueProtocol.interface.encodeFunctionData("ping", [ethers.encodeBytes32String("C")]),
        BigInt(100_000),
      )
    ).to.be.revertedWith("Protocol not allowed");
  });
});
