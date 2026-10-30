import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { formatUnits, keccak256, parseUnits, toBytes } from "viem";
import { z } from "zod";
import { type AgentPhase, type Deal, json, say } from "../agent.ts";
import { hasTests, stubSpec } from "./stub.ts";
import {
  USDC_DECIMALS,
  buyer,
  buyerWallet,
  computeEscrowId,
  currentVerifier,
  fmt,
  now,
  seller,
  send,
  signFundingAuthorization,
  txLink,
  usdcBalance,
} from "../chain.ts";

const SYSTEM = `You are a buyer agent with a USDC wallet on Base. You commission work from a seller agent and pay through an on-chain escrow.
Funds are locked until an independent verifier signs a verdict, the seller refunds, or you release. If none of that happens by the deadline, anyone (you, the seller, a bot) can then call refundExpired to send the funds back to you; it is one transaction, not automatic, and no one can block it.
The verifier grades the seller's work only against the spec you write, so the spec must make every acceptance criterion explicit and checkable.
Be concise in your messages.`;

/** Buyer writes the spec, picks terms, signs a gasless funding authorization. */
export function buyerOpensDeal(deal: Deal, opts: { budget: bigint; deadlineMinutes?: number }): AgentPhase {
  const getWallet = betaZodTool({
    name: "get_wallet",
    description: "Your address, USDC balance, the seller's address and the escrow's required verifier.",
    inputSchema: z.object({}),
    run: async () =>
      json({
        you: buyer.address,
        usdcBalance: fmt(await usdcBalance(buyer.address)),
        budget: fmt(opts.budget),
        seller: seller.address,
        requiredVerifier: await currentVerifier(),
      }),
  });

  const proposeEscrow = betaZodTool({
    name: "propose_escrow",
    description:
      "Lock in the spec and terms and sign a gasless USDC funding authorization for the seller to submit. The spec is hashed into the escrow id, so it cannot change after this call.",
    inputSchema: z.object({
      spec: z.string().describe("The full task spec with numbered, checkable acceptance criteria."),
      amountUsdc: z.string().describe('Escrow amount in USDC, e.g. "2.5".'),
      deadlineMinutes: z.number().describe("Whole minutes from now until the verdict window closes."),
    }),
    strict: true,
    run: async ({ spec, amountUsdc, deadlineMinutes }) => {
      if (deal.escrowId) return "Already proposed; the terms are final.";
      const amount = parseUnits(amountUsdc, USDC_DECIMALS);
      const minutes = Math.round(opts.deadlineMinutes ?? deadlineMinutes);
      if (amount <= 0n || amount > opts.budget) return `Rejected: amount must be > 0 and <= ${fmt(opts.budget)}.`;
      if (amount > (await usdcBalance(buyer.address))) return "Rejected: insufficient USDC balance.";
      if (minutes < 2 || minutes > 24 * 60) return "Rejected: deadline must be 2 to 1440 minutes.";

      const deadline = (await now()) + BigInt(minutes * 60);
      deal.spec = spec;
      deal.terms = {
        seller: seller.address,
        refundTo: buyer.address,
        verifier: await currentVerifier(),
        amount,
        deadline,
        salt: keccak256(toBytes(spec)),
      };
      deal.escrowId = await computeEscrowId(buyer.address, deal.terms);
      deal.authorization = await signFundingAuthorization(deal.escrowId, amount, deadline);
      say("buyer", `signed EIP-3009 authorization for ${fmt(amount)}, nonce = escrow id ${deal.escrowId}`);
      return json({ escrowId: deal.escrowId, amount: fmt(amount), deadlineMinutes: minutes, specHash: deal.terms.salt });
    },
  });

  const deadlineNote = opts.deadlineMinutes ? ` The job is urgent: the deadline is fixed at ${opts.deadlineMinutes} minutes.` : "";
  return {
    role: "buyer",
    system: SYSTEM,
    prompt: `Your brief: ${deal.brief}\nCheck your wallet, then write the spec and propose the escrow.${deadlineNote}`,
    tools: [getWallet, proposeEscrow],
    effort: "medium",
    check: () => {
      if (!deal.escrowId) throw new Error("Buyer did not propose an escrow");
    },
    stub: async (agent) => {
      await agent.call("get_wallet");
      const amountUsdc = formatUnits(opts.budget, USDC_DECIMALS);
      const deadlineMinutes = opts.deadlineMinutes ?? 120;
      await agent.call("propose_escrow", { spec: stubSpec(deal.brief), amountUsdc, deadlineMinutes });
      await agent.say(
        `Proposed the escrow and signed the funding authorization for ${amountUsdc} USDC. The verifier has ${deadlineMinutes} minutes to rule; after that anyone can call refundExpired to return the funds to me.`,
      );
    },
  };
}

/** Buyer reviews the delivery and either pays in full or leaves it to the verifier. */
export function buyerReviews(deal: Deal): AgentPhase {
  const release = betaZodTool({
    name: "release_payment",
    description: "Pay the seller the full escrow amount now. Irreversible.",
    inputSchema: z.object({ reason: z.string() }),
    run: async ({ reason }) => {
      const hash = await send(buyerWallet, "release", [deal.escrowId]);
      deal.buyerDecision = { action: "release", reason };
      say("chain", `release → ${txLink(hash)}`);
      return `Released. ${txLink(hash)}`;
    },
  });
  const dispute = betaZodTool({
    name: "send_to_verifier",
    description: "Do not pay directly; let the verifier grade the work against the spec.",
    inputSchema: z.object({ reason: z.string() }),
    run: async ({ reason }) => {
      deal.buyerDecision = { action: "dispute", reason };
      return "Sent to the verifier.";
    },
  });

  return {
    role: "buyer",
    system: SYSTEM,
    prompt: `The seller delivered. Review it against your spec. If every criterion is met, call release_payment; otherwise call send_to_verifier.\n\n<spec>\n${deal.spec}\n</spec>\n\n<deliverable>\n${deal.deliverable}\n</deliverable>`,
    tools: [release, dispute],
    effort: "medium",
    stub: async (agent) => {
      if (hasTests(deal.deliverable)) {
        await agent.call("release_payment", { reason: "Every criterion is met, including the tests." });
        await agent.say("The work meets the spec, so I paid the seller in full.");
      } else {
        await agent.call("send_to_verifier", { reason: "Criterion 5 is not met: the tests are missing." });
        await agent.say("The tests are missing, so I sent the case to the verifier.");
      }
    },
  };
}
