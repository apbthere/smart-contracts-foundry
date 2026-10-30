// Chain steps shared by the terminal demo and the studio page.
import { type Deal, say } from "./agent.ts";
import { buyer, escrowAddress, now, publicClient, seller, sellerWallet, send, txLink, usdcBalance } from "./chain.ts";

export const SCENARIOS = ["happy", "partial", "release", "timeout"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const TIMEOUT_DEADLINE_MINUTES = 2;
export const DEFAULT_BRIEF =
  "I need a TypeScript function `slugify(title: string): string` for blog URLs (lowercase, ASCII only, hyphen-separated, no leading/trailing or repeated hyphens), plus at least 5 test cases covering edge cases.";

// After a human rejection on a live chain, wait for the expiry refund only if the deadline is this close.
const MAX_REFUND_WAIT_MINUTES = 10;

export async function balances() {
  const [b, s, e] = await Promise.all([usdcBalance(buyer.address), usdcBalance(seller.address), usdcBalance(escrowAddress())]);
  return { buyer: b, seller: s, escrow: e };
}

export async function isAnvil() {
  return publicClient.request({ method: "anvil_nodeInfo" } as never).then(
    () => true,
    () => false,
  );
}

/** Advance past the deadline: instantly on Anvil, by waiting on a live chain. */
async function waitPastDeadline(deadline: bigint) {
  if (await isAnvil()) {
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

/** Submit the human's signed verdict. executeVerdict is permissionless; the seller submits it because it is the one waiting to be paid. */
export async function executeVerdict(deal: Deal) {
  const v = deal.verdict!;
  const hash = await send(sellerWallet, "executeVerdict", [deal.escrowId, v.toSeller, v.expiry, v.signature]);
  say("chain", `executeVerdict → ${txLink(hash)}`);
}

/**
 * Refund the buyer once the deadline passes. With `onlyIfSoon`, a live chain whose deadline is far off is left
 * for anyone to refund later rather than waited on. Returns whether the refund happened.
 */
export async function refundAfterDeadline(deal: Deal, opts: { onlyIfSoon?: boolean } = {}) {
  const tooFar = deal.terms!.deadline - (await now()) > BigInt(MAX_REFUND_WAIT_MINUTES * 60);
  if (opts.onlyIfSoon && tooFar && !(await isAnvil())) {
    say("chain", `no verdict; anyone can call refundExpired(${deal.escrowId}) after the deadline`);
    return false;
  }
  await waitPastDeadline(deal.terms!.deadline);
  const hash = await send(sellerWallet, "refundExpired", [deal.escrowId]);
  say("chain", `refundExpired (callable by anyone) → ${txLink(hash)}`);
  return true;
}
