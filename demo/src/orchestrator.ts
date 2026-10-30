import { parseArgs } from "node:util";
import { parseUnits } from "viem";
import { type Deal, STUBBED, runAgent, say, short } from "./agent.ts";
import { buyerOpensDeal, buyerReviews } from "./agents/buyer.ts";
import { sellerAcceptsAndFunds, sellerDelivers } from "./agents/seller.ts";
import { verifierRules } from "./agents/verifier.ts";
import { humanReview } from "./review/server.ts";
import { Status, USDC_DECIMALS, buyer, currentVerifier, escrowAddress, fmt, getEscrow, seller } from "./chain.ts";
import {
  DEFAULT_BRIEF,
  SCENARIOS,
  type Scenario,
  TIMEOUT_DEADLINE_MINUTES,
  balances,
  executeVerdict,
  refundAfterDeadline,
} from "./steps.ts";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "happy" },
    brief: { type: "string", default: DEFAULT_BRIEF },
    budget: { type: "string", default: process.env.BUDGET_USDC ?? "5" },
  },
});
const scenario = values.scenario as Scenario;
if (!SCENARIOS.includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);

async function main() {
  console.log(`\nUsdcEscrow agent demo, scenario: ${scenario}${STUBBED ? " (stubbed agents: no Anthropic API calls)" : ""}`);
  console.log(`escrow ${escrowAddress()}`);
  console.log(`buyer ${short(buyer.address)}  seller ${short(seller.address)}  verifier ${short(await currentVerifier())} (human)\n`);
  const before = await balances();

  const deal: Deal = { brief: values.brief! };
  const budget = parseUnits(values.budget!, USDC_DECIMALS);

  // 1. Buyer writes the spec, picks terms, signs a gasless funding authorization.
  await runAgent(
    buyerOpensDeal(deal, {
      budget,
      deadlineMinutes: scenario === "timeout" ? TIMEOUT_DEADLINE_MINUTES : undefined,
    }),
  );

  // 2. Seller verifies the offer on-chain and pays the gas to fund it.
  await runAgent(sellerAcceptsAndFunds(deal));
  if (deal.declined) {
    say("seller", `declined: ${deal.declined}`);
    return;
  }

  // 3. Seller does the work.
  await runAgent(sellerDelivers(deal, { shortcut: scenario === "partial" }));

  // 4. Settlement.
  if (scenario === "release") {
    await runAgent(buyerReviews(deal));
  }

  if (scenario === "timeout") {
    say("verifier", "(offline: no verdict will be signed)");
    await refundAfterDeadline(deal);
  } else if (deal.buyerDecision?.action !== "release") {
    // The AI drafts; only the human holds the verifier key, so nothing settles without their signature.
    await runAgent(verifierRules(deal));
    say("verifier", deal.draft!.rationale);
    if ((await humanReview(deal)) === "signed") await executeVerdict(deal);
    else await refundAfterDeadline(deal, { onlyIfSoon: true });
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
