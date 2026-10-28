// Rehearsal setup for an Anvil fork of Base Sepolia: deploys UsdcEscrow and funds the demo wallets.
//   anvil --fork-url https://sepolia.base.org
//   RPC_URL=http://127.0.0.1:8545 npm run fork-setup
import "dotenv/config";
import { type Address, createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_USDC, env, escrowAbi, escrowBytecode, fmt, usdcAbi } from "./chain.ts";

const transport = http(env("RPC_URL"));
const client = createPublicClient({ chain: baseSepolia, transport });
const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never);

const buyer = privateKeyToAccount(env("BUYER_PK") as `0x${string}`);
const seller = privateKeyToAccount(env("SELLER_PK") as `0x${string}`);
const verifier = privateKeyToAccount(env("VERIFIER_PK") as `0x${string}`);
const USDC_FOR_BUYER = 100_000_000n; // 100 USDC

/** Write `amount` into `account`'s USDC balance slot, finding FiatToken's balance mapping slot by probing. */
async function dealUsdc(account: Address, amount: bigint) {
  for (let slot = 0n; slot < 20n; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, slot]));
    const previous = (await rpc("eth_getStorageAt", [BASE_SEPOLIA_USDC, key, "latest"])) as `0x${string}`;
    await rpc("anvil_setStorageAt", [BASE_SEPOLIA_USDC, key, pad(toHex(amount))]);
    const balance = await client.readContract({ address: BASE_SEPOLIA_USDC, abi: usdcAbi, functionName: "balanceOf", args: [account] });
    if (balance === amount) return;
    await rpc("anvil_setStorageAt", [BASE_SEPOLIA_USDC, key, previous]);
  }
  throw new Error("Could not find the USDC balance slot");
}

async function main() {
  await rpc("anvil_nodeInfo", []).catch(() => {
    throw new Error("fork-setup only runs against Anvil (it rewrites balances)");
  });

  for (const account of [seller.address, buyer.address]) await rpc("anvil_setBalance", [account, toHex(parseEther("1"))]);
  await dealUsdc(buyer.address, USDC_FOR_BUYER);

  // The seller wallet doubles as deployer and owner; the owner has no power over existing escrows anyway.
  const wallet = createWalletClient({ account: seller, chain: baseSepolia, transport });
  const hash = await wallet.deployContract({
    abi: escrowAbi,
    bytecode: escrowBytecode,
    args: [BASE_SEPOLIA_USDC, verifier.address, seller.address],
  });
  const { contractAddress } = await client.waitForTransactionReceipt({ hash });

  console.log(`buyer ${buyer.address} funded with ${fmt(USDC_FOR_BUYER)} and 1 ETH; seller funded with 1 ETH`);
  console.log(`UsdcEscrow deployed; verifier = ${verifier.address}`);
  console.log(`\nESCROW_ADDRESS=${contractAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
