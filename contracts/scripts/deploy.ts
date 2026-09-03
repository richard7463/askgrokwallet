import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId.toString();
  const consumerName = process.env.LEASE_CONSUMER_NAME || "bound-agent";
  const operatorName = process.env.LEASE_OPERATOR_NAME || "human-principal";

  const Controller = await hre.ethers.getContractFactory("TrustLeaseController");
  const controller = await Controller.deploy(deployer.address);
  await controller.waitForDeployment();

  const Vault = await hre.ethers.getContractFactory("BoundlessVault");
  const vault = await Vault.deploy(
    await controller.getAddress(),
    deployer.address,
    consumerName,
    operatorName
  );
  await vault.waitForDeployment();

  const Mock = await hre.ethers.getContractFactory("MockERC20");
  const mock = await Mock.deploy("Mock USDC", "mUSDC", 6);
  await mock.waitForDeployment();

  const Registry = await hre.ethers.getContractFactory("VerificationScoreRegistry");
  const registry = await Registry.deploy(deployer.address, deployer.address);
  await registry.waitForDeployment();

  await (await controller.setExecutor(await vault.getAddress(), true)).wait();
  await (await controller.setRiskOracle(await registry.getAddress())).wait();

  const out = {
    network,
    chainId,
    deployer: deployer.address,
    controller: await controller.getAddress(),
    vault: await vault.getAddress(),
    mockUsdc: await mock.getAddress(),
    riskOracle: await registry.getAddress(),
    consumerName,
    operatorName,
    deployedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(out, null, 2));

  const projectRoot = path.resolve(__dirname, "../..");
  const dataDir = path.join(projectRoot, "data", "trust-leases");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "deployed.json"),
    JSON.stringify(out, null, 2) + "\n"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
