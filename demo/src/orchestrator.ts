import { parseArgs } from "node:util";
import { parseUnits } from "viem";
import { type Deal, say, short } from "./agent.ts";
import { buyerOpensDeal, buyerReviews } from "./agents/buyer.ts";
import { sellerAcceptsAndFunds, sellerDelivers } from "./agents/seller.ts";
import { verifierRules } from "./agents/verifier.ts";
import { humanReview } from "./review/server.ts";
import {
  Status,
  USDC_DECIMALS,
  buyer,
  currentVerifier,
  escrowAddress,
  fmt,
  getEscrow,
  now,
  publicClient,
  seller,
  sellerWallet,
  send,
  txLink,
  usdcBalance,
} from "./chain.ts";

const SCENARIOS = ["happy", "partial", "release", "timeout"] as const;
type Scenario = (typeof SCENARIOS)[number];
const TIMEOUT_DEADLINE_MINUTES = 2;
// After a human rejection, wait for the expiry refund only if the deadline is this close.
const MAX_REFUND_WAIT_MINUTES = 10;

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "happy" },
    brief: {
      type: "string",
      default:
        "I need a TypeScript function `slugify(title: string): string` for blog URLs (lowercase, ASCII only, hyphen-separated, no leading/trailing or repeated hyphens), plus at least 5 test cases covering edge cases.",
    },
    budget: { type: "string", default: process.env.BUDGET_USDC ?? "5" },
  },
});
const scenario = values.scenario as Scenario;
if (!SCENARIOS.includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);

async function balances() {
  const [b, s, e] = await Promise.all([usdcBalance(buyer.address), usdcBalance(seller.address), usdcBalance(escrowAddress())]);
  return { buyer: b, seller: s, escrow: e };
}

/** Advance past the deadline: instantly on Anvil, by waiting on a live chain. */
async function waitPastDeadline(deadline: bigint) {
  const isAnvil = await publicClient.request({ method: "anvil_nodeInfo" } as never).then(
    () => true,
    () => false,
  );
  if (isAnvil) {
    const delta = Number(deadline - (await now()) + 1n);
    await publicClient.request({ method: "evm_increaseTime", params: [delta] } as never);
    await publicClient.request({ method: "evm_mine", params: [] } as never);
    say("chain", `anvil: skipped ${delta}s ahead`);
    return;
  }
  while ((await now()) <= deadline) {
    say("chain", `waiting for the deadline (${deadline - (await now())}s left)...`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

async function main() {
  console.log(`\nUsdcEscrow agent demo, scenario: ${scenario}`);
  console.log(`escrow ${escrowAddress()}`);
  console.log(`buyer ${short(buyer.address)}  seller ${short(seller.address)}  verifier ${short(await currentVerifier())} (human)\n`);
  const before = await balances();

  const deal: Deal = { brief: values.brief! };
  const budget = parseUnits(values.budget!, USDC_DECIMALS);

  // 1. Buyer writes the spec, picks terms, signs a gasless funding authorization.
  await buyerOpensDeal(deal, {
    budget,
    deadlineMinutes: scenario === "timeout" ? TIMEOUT_DEADLINE_MINUTES : undefined,
  });

  // 2. Seller verifies the offer on-chain and pays the gas to fund it.
  await sellerAcceptsAndFunds(deal);
  if (deal.declined) {
    say("seller", `declined: ${deal.declined}`);
    return;
  }

  // 3. Seller does the work.
  await sellerDelivers(deal, { shortcut: scenario === "partial" });

  // 4. Settlement.
  if (scenario === "release") {
    await buyerReviews(deal);
  }

  if (scenario === "timeout") {
    say("verifier", "(offline: no verdict will be signed)");
    await waitPastDeadline(deal.terms!.deadline);
    const hash = await send(sellerWallet, "refundExpired", [deal.escrowId]);
    say("chain", `refundExpired (callable by anyone) → ${txLink(hash)}`);
  } else if (deal.buyerDecision?.action !== "release") {
    // The AI drafts; only the human holds the verifier key, so nothing settles without their signature.
    await verifierRules(deal);
    say("verifier", deal.draft!.rationale);
    if ((await humanReview(deal)) === "signed") {
      const v = deal.verdict!;
      // executeVerdict is permissionless; the seller submits it because it is the one waiting to be paid.
      const hash = await send(sellerWallet, "executeVerdict", [deal.escrowId, v.toSeller, v.expiry, v.signature]);
      say("chain", `executeVerdict → ${txLink(hash)}`);
    } else if (deal.terms!.deadline - (await now()) <= BigInt(MAX_REFUND_WAIT_MINUTES * 60)) {
      await waitPastDeadline(deal.terms!.deadline);
      const hash = await send(sellerWallet, "refundExpired", [deal.escrowId]);
      say("chain", `refundExpired (callable by anyone) → ${txLink(hash)}`);
    } else {
      say("chain", `no verdict; anyone can call refundExpired(${deal.escrowId}) after the deadline`);
    }
  }

  const after = await balances();
  const e = await getEscrow(deal.escrowId!);
  const row = (name: keyof typeof before) =>
    `  ${name.padEnd(7)} ${fmt(before[name]).padStart(16)} → ${fmt(after[name]).padStart(16)}  (${after[name] >= before[name] ? "+" : "-"}${fmt(after[name] >= before[name] ? after[name] - before[name] : before[name] - after[name])})`;
  console.log(`\nEscrow ${deal.escrowId} settled, status ${Status[e.status]}`);
  console.log(["buyer", "seller", "escrow"].map((n) => row(n as keyof typeof before)).join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
