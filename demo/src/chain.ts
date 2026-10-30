import "dotenv/config";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
  createPublicClient,
  createWalletClient,
  formatUnits,
  hashTypedData,
  http,
  parseAbi,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see demo/.env.example)`);
  return value;
}

// ABI and bytecode come straight from `forge build`, so the demo can never drift from the contract.
const artifact = JSON.parse(
  readFileSync(new URL("../../out/UsdcEscrow.sol/UsdcEscrow.json", import.meta.url), "utf8"),
);
export const escrowAbi = artifact.abi as Abi;
export const escrowBytecode = artifact.bytecode.object as Hex;

export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;
export const EXPLORER = process.env.EXPLORER_URL ?? "https://sepolia.basescan.org";

export const chain = baseSepolia;
export const transport = http(env("RPC_URL"));
export const publicClient = createPublicClient({ chain, transport });

export const buyer = privateKeyToAccount(env("BUYER_PK") as Hex);
export const seller = privateKeyToAccount(env("SELLER_PK") as Hex);
// The verifier key is not here: it belongs to a human, who signs verdicts in a browser wallet.
// The buyer only signs (EIP-3009), so it needs no gas except for the `release` scenario.
export const sellerWallet = createWalletClient({ account: seller, chain, transport });
export const buyerWallet = createWalletClient({ account: buyer, chain, transport });

export type Terms = {
  seller: Address;
  refundTo: Address;
  verifier: Address;
  amount: bigint;
  deadline: bigint;
  salt: Hex;
};

export enum Status {
  None,
  Funded,
  Released,
  Refunded,
  Resolved,
}

export type OnchainEscrow = {
  buyer: Address;
  seller: Address;
  refundTo: Address;
  verifier: Address;
  deadline: bigint;
  status: Status;
  amount: bigint;
};

export const escrowAddress = () => env("ESCROW_ADDRESS") as Address;

export async function usdcAddress(): Promise<Address> {
  return (await publicClient.readContract({ address: escrowAddress(), abi: escrowAbi, functionName: "usdc" })) as Address;
}

export async function currentVerifier(): Promise<Address> {
  return (await publicClient.readContract({
    address: escrowAddress(),
    abi: escrowAbi,
    functionName: "verifier",
  })) as Address;
}

export async function computeEscrowId(buyerAddr: Address, terms: Terms): Promise<Hex> {
  return (await publicClient.readContract({
    address: escrowAddress(),
    abi: escrowAbi,
    functionName: "computeEscrowId",
    args: [buyerAddr, terms],
  })) as Hex;
}

export async function getEscrow(id: Hex): Promise<OnchainEscrow> {
  return (await publicClient.readContract({
    address: escrowAddress(),
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [id],
  })) as OnchainEscrow;
}

export async function usdcBalance(account: Address): Promise<bigint> {
  return publicClient.readContract({ address: await usdcAddress(), abi: usdcAbi, functionName: "balanceOf", args: [account] });
}

/**
 * The block time the next transaction will see. Anvil mines only on demand, so its latest block can be long
 * stale (a 2-minute deadline computed from it is already past); its pending block has the right time.
 */
export async function now(): Promise<bigint> {
  const block = await publicClient.getBlock({ blockTag: "pending" }).catch(() => publicClient.getBlock());
  return block.timestamp;
}

export const fmt = (amount: bigint) => `${formatUnits(amount, USDC_DECIMALS)} USDC`;
export const txLink = (hash: Hash) => `${EXPLORER}/tx/${hash}`;

/** Buyer signs EIP-3009 `ReceiveWithAuthorization`. The nonce is the escrow id, which binds the signature to the terms. */
export async function signFundingAuthorization(id: Hex, amount: bigint, validBefore: bigint) {
  const usdc = await usdcAddress();
  const [name, version] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "name" }),
    publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "version" }),
  ]);
  const validAfter = 0n;
  const signature = await buyer.signTypedData({
    domain: { name, version, chainId: chain.id, verifyingContract: usdc },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: { from: buyer.address, to: escrowAddress(), value: amount, validAfter, validBefore, nonce: id },
  });
  return { validAfter, validBefore, signature };
}

export const verdictTypedData = (escrowId: Hex, toSeller: bigint, expiry: bigint) =>
  ({
    domain: { name: "UsdcEscrow", version: "1", chainId: chain.id, verifyingContract: escrowAddress() },
    types: {
      Verdict: [
        { name: "escrowId", type: "bytes32" },
        { name: "toSeller", type: "uint256" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "Verdict",
    message: { escrowId, toSeller, expiry },
  }) as const;

/** Build the EIP-712 verdict for the verifier to sign, after checking its digest matches the contract's `verdictDigest`. */
export async function prepareVerdict(escrowId: Hex, toSeller: bigint, expiry: bigint) {
  const typedData = verdictTypedData(escrowId, toSeller, expiry);
  const onchainDigest = await publicClient.readContract({
    address: escrowAddress(),
    abi: escrowAbi,
    functionName: "verdictDigest",
    args: [escrowId, toSeller, expiry],
  });
  if (hashTypedData(typedData) !== onchainDigest) throw new Error("Verdict digest mismatch with contract");
  return typedData;
}

export function recoverVerdictSigner(escrowId: Hex, toSeller: bigint, expiry: bigint, signature: Hex) {
  return recoverTypedDataAddress({ ...verdictTypedData(escrowId, toSeller, expiry), signature });
}

/** Every mined escrow transaction, for the studio page. */
export const transactions = new EventEmitter<{ mined: [{ functionName: string; from: Address; receipt: TransactionReceipt }] }>();

/** Send a transaction from `wallet`, wait for it, and throw if it reverted. */
export async function send(
  wallet: typeof sellerWallet,
  functionName: string,
  args: readonly unknown[],
): Promise<Hash> {
  const { request } = await publicClient.simulateContract({
    account: wallet.account,
    address: escrowAddress(),
    abi: escrowAbi,
    functionName,
    args,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${txLink(hash)}`);
  transactions.emit("mined", { functionName, from: wallet.account.address, receipt });
  return hash;
}
