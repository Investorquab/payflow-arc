/**
 * PayFlow Agent — Full Deploy Script
 *
 * What this does:
 *  1. Registers an AI agent on Arc using ERC-8004 (IdentityRegistry)
 *  2. Records initial reputation via ReputationRegistry
 *  3. Requests + verifies KYC validation via ValidationRegistry
 *  4. Deploys the PaymentRouter contract with the agent's address + ID
 *  5. Prints a full deployment summary
 *
 * Run:
 *   npx tsx --env-file=.env scripts/deploy.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  createPublicClient,
  http,
  parseAbiItem,
  getContract,
  keccak256,
  toHex,
  parseUnits,
} from "viem";
import { arcTestnet } from "viem/chains";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Contract Addresses (Arc Testnet) ────────────────────────────────────────

const CONTRACTS = {
  USDC:                "0x3600000000000000000000000000000000000000",
  CCTP_MESSENGER:      "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  VALIDATION_REGISTRY: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const;

// ─── Setup ───────────────────────────────────────────────────────────────────

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForTx(txId: string, label: string): Promise<string> {
  process.stdout.write(`  ⏳ ${label}`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await circleClient.getTransaction({ id: txId });
    const state = data?.transaction?.state;
    if (state === "COMPLETE") {
      const hash = data!.transaction!.txHash!;
      console.log(` ✓\n     → https://testnet.arcscan.app/tx/${hash}`);
      return hash;
    }
    if (state === "FAILED") throw new Error(`Transaction failed: ${label}`);
    process.stdout.write(".");
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

function addressToBytes32(addr: string): `0x${string}` {
  return `0x${addr.replace("0x", "").padStart(64, "0")}` as `0x${string}`;
}

// ─── Step 1: Create Wallets ──────────────────────────────────────────────────

async function createWallets() {
  console.log("\n━━ Step 1: Create Agent Wallets ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const walletSet = await circleClient.createWalletSet({
    name: "PayFlow Agent Wallets",
  });

  const walletsResponse = await circleClient.createWallets({
    blockchains: ["ARC-TESTNET"],
    count: 2,
    walletSetId: walletSet.data?.walletSet?.id ?? "",
    accountType: "SCA",
  });

  const ownerWallet = walletsResponse.data?.wallets?.[0]!;
  const validatorWallet = walletsResponse.data?.wallets?.[1]!;

  console.log(`  Owner:     ${ownerWallet.address}`);
  console.log(`  Validator: ${validatorWallet.address}`);
  console.log(`\n  ⚠️  Fund both wallets with testnet USDC at https://faucet.circle.com/`);

  return { ownerWallet, validatorWallet };
}

// ─── Step 2: Register Agent Identity ─────────────────────────────────────────

async function registerAgent(ownerAddress: string, walletId: string) {
  console.log("\n━━ Step 2: Register Agent Identity (ERC-8004) ━━━━━━━━━━━━━━━");

  const metadata = {
    name: "PayFlow Agent v1.0",
    description: "Autonomous USDC payment routing agent on Arc. Routes cross-border payments, manages reputation, and executes agent-controlled transactions.",
    image: "ipfs://QmPayFlowAgentAvatar",
    agent_type: "payment_router",
    capabilities: [
      "direct_payment_routing",
      "crosschain_usdc_transfer",
      "reputation_tracking",
      "auto_fee_management",
    ],
    version: "1.0.0",
    network: "arc-testnet",
    contract: "PaymentRouter",
  };

  // In production: upload metadata to IPFS via Pinata
  // For testnet: use the example URI from Arc docs
  const METADATA_URI = process.env.METADATA_URI ||
    "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";

  console.log(`  Metadata URI: ${METADATA_URI}`);
  console.log(`  Metadata: ${JSON.stringify(metadata, null, 2)}`);

  const registerTx = await circleClient.createContractExecutionTransaction({
    walletId,
    blockchain: "ARC-TESTNET",
    contractAddress: CONTRACTS.IDENTITY_REGISTRY,
    abiFunctionSignature: "register(string)",
    abiParameters: [METADATA_URI],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  await waitForTx(registerTx.data?.id!, "Registering agent identity");

  // Retrieve the minted token ID
  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = latestBlock > 10000n ? latestBlock - 10000n : 0n;

  const transferLogs = await publicClient.getLogs({
    address: CONTRACTS.IDENTITY_REGISTRY,
    event: parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
    ),
    args: { to: ownerAddress as `0x${string}` },
    fromBlock,
    toBlock: latestBlock,
  });

  if (!transferLogs.length) throw new Error("No Transfer event found — registration may have failed");

  const agentId = transferLogs[transferLogs.length - 1].args.tokenId!.toString();
  console.log(`  ✓ Agent ID minted: #${agentId}`);
  console.log(`  → https://testnet.arcscan.app/address/${CONTRACTS.IDENTITY_REGISTRY}`);

  return agentId;
}

// ─── Step 3: Record Initial Reputation ───────────────────────────────────────

async function recordReputation(agentId: string, validatorWalletId: string) {
  console.log("\n━━ Step 3: Record Initial Reputation ━━━━━━━━━━━━━━━━━━━━━━━━");

  const tags = [
    { tag: "payment_routing_ready", score: 90 },
    { tag: "kyc_compliance_enabled", score: 95 },
  ];

  for (const { tag, score } of tags) {
    const feedbackHash = keccak256(toHex(tag));

    const repTx = await circleClient.createContractExecutionTransaction({
      walletId: validatorWalletId,
      blockchain: "ARC-TESTNET",
      contractAddress: CONTRACTS.REPUTATION_REGISTRY,
      abiFunctionSignature:
        "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
      abiParameters: [agentId, score.toString(), "0", tag, "", "", "", feedbackHash],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    await waitForTx(repTx.data?.id!, `Recording reputation: ${tag} (score: ${score})`);
  }
}

// ─── Step 4: Request & Verify Validation ─────────────────────────────────────

async function requestValidation(
  agentId: string,
  ownerWalletId: string,
  validatorAddress: string,
  validatorWalletId: string
) {
  console.log("\n━━ Step 4: Request KYC Validation ━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const requestHash = keccak256(
    toHex(`payflow_kyc_request_agent_${agentId}_${Date.now()}`)
  );

  const reqTx = await circleClient.createContractExecutionTransaction({
    walletId: ownerWalletId,
    blockchain: "ARC-TESTNET",
    contractAddress: CONTRACTS.VALIDATION_REGISTRY,
    abiFunctionSignature: "validationRequest(address,uint256,string,bytes32)",
    abiParameters: [
      validatorAddress,
      agentId,
      "ipfs://payflow-kyc-request",
      requestHash,
    ],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  await waitForTx(reqTx.data?.id!, "Requesting KYC validation");

  // Validator responds
  const resTx = await circleClient.createContractExecutionTransaction({
    walletId: validatorWalletId,
    blockchain: "ARC-TESTNET",
    contractAddress: CONTRACTS.VALIDATION_REGISTRY,
    abiFunctionSignature: "validationResponse(bytes32,uint8,string,bytes32,string)",
    abiParameters: [requestHash, "100", "", "0x" + "0".repeat(64), "kyc_verified"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  await waitForTx(resTx.data?.id!, "Submitting KYC validation response");

  return requestHash;
}

// ─── Step 5: Deploy PaymentRouter ────────────────────────────────────────────

async function deployPaymentRouter(agentAddress: string, agentId: string) {
  console.log("\n━━ Step 5: Deploy PaymentRouter Contract ━━━━━━━━━━━━━━━━━━━━");

  // Load compiled artifact
  const artifactPath = path.join(
    __dirname, "../artifacts/contracts/PaymentRouter.sol/PaymentRouter.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));

  // Deploy using ethers (with your EOA private key)
  const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(agentAddress, agentId);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`  ✓ PaymentRouter deployed: ${address}`);
  console.log(`  → https://testnet.arcscan.app/address/${address}`);

  return address;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║   PayFlow Agent — Arc Testnet Deploy   ║");
  console.log("╚════════════════════════════════════════╝");

  const { ownerWallet, validatorWallet } = await createWallets();

  // Pause here if wallets are not yet funded
  console.log("\n  Press Ctrl+C to stop, fund wallets, then re-run with:");
  console.log(`  OWNER_WALLET_ID=${ownerWallet.id} VALIDATOR_WALLET_ID=${validatorWallet.id}`);
  console.log("  (or set env vars and continue)\n");

  const ownerWalletId = process.env.OWNER_WALLET_ID || ownerWallet.id;
  const validatorWalletId = process.env.VALIDATOR_WALLET_ID || validatorWallet.id;
  const ownerAddress = process.env.OWNER_ADDRESS || ownerWallet.address!;
  const validatorAddress = process.env.VALIDATOR_ADDRESS || validatorWallet.address!;

  const agentId = await registerAgent(ownerAddress, ownerWalletId);
  await recordReputation(agentId, validatorWalletId);
  const requestHash = await requestValidation(agentId, ownerWalletId, validatorAddress, validatorWalletId);
  const routerAddress = await deployPaymentRouter(ownerAddress, agentId);

  // ─── Final Summary ────────────────────────────────────────────────────────

  const summary = {
    network: "Arc Testnet (chainId: 1315)",
    timestamp: new Date().toISOString(),
    agent: {
      id: agentId,
      owner: ownerAddress,
      validator: validatorAddress,
      identityRegistry: CONTRACTS.IDENTITY_REGISTRY,
      reputationRegistry: CONTRACTS.REPUTATION_REGISTRY,
      validationRegistry: CONTRACTS.VALIDATION_REGISTRY,
      validationRequestHash: requestHash,
    },
    contracts: {
      PaymentRouter: routerAddress,
      USDC: CONTRACTS.USDC,
      CCTP_MESSENGER: CONTRACTS.CCTP_MESSENGER,
    },
    explorer: `https://testnet.arcscan.app/address/${routerAddress}`,
  };

  console.log("\n━━ Deployment Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(JSON.stringify(summary, null, 2));

  fs.writeFileSync(
    path.join(__dirname, "../deployment.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log("\n  ✓ deployment.json saved");
  console.log("\n━━ Complete ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✓ Agent identity registered (ERC-8004)");
  console.log("  ✓ Reputation recorded");
  console.log("  ✓ KYC validation verified");
  console.log("  ✓ PaymentRouter deployed");
  console.log(`\n  🚀 PayFlow is live on Arc Testnet!\n`);
}

main().catch((err) => {
  console.error("\n✗ Deploy failed:", err.message ?? err);
  process.exit(1);
});