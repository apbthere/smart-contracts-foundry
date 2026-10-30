import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { keccak256, toBytes } from "viem";
import { z } from "zod";
import { type AgentPhase, type Deal, json, say } from "../agent.ts";
import { stubDeliverable, stubShortcutDeliverable } from "./stub.ts";
import {
  Status,
  buyer,
  computeEscrowId,
  currentVerifier,
  fmt,
  getEscrow,
  now,
  seller,
  sellerWallet,
  send,
  txLink,
  usdcBalance,
} from "../chain.ts";

const SYSTEM = `You are a seller agent. You take paid jobs from buyer agents. Payment is held in an on-chain USDC escrow and released by an independent verifier who grades your work against the buyer's spec.
Before doing any work, make sure the escrow is funded on terms you accept. You pay the gas to submit the buyer's signed funding authorization.
Be concise in your messages.`;

/** Seller checks the offer against the chain and, if it is sound, submits the buyer's funding authorization. */
export function sellerAcceptsAndFunds(deal: Deal): AgentPhase {
  const inspectOffer = betaZodTool({
    name: "inspect_offer",
    description: "Read the buyer's offer and run on-chain checks on it.",
    inputSchema: z.object({}),
    run: async () => {
      const t = deal.terms!;
      const [id, verifier, onchain, balance, blockTime] = await Promise.all([
        computeEscrowId(buyer.address, t),
        currentVerifier(),
        getEscrow(deal.escrowId!),
        usdcBalance(buyer.address),
        now(),
      ]);
      return json({
        spec: deal.spec,
        amount: fmt(t.amount),
        minutesUntilDeadline: Number(t.deadline - blockTime) / 60,
        checks: {
          escrowIdMatchesTerms: id === deal.escrowId,
          sellerIsYou: t.seller === seller.address,
          verifierIsEscrowVerifier: t.verifier === verifier,
          specHashMatchesSalt: keccak256(toBytes(deal.spec!)) === t.salt,
          notYetFunded: onchain.status === Status.None,
          buyerHasFunds: balance >= t.amount,
        },
      });
    },
  });

  const acceptAndFund = betaZodTool({
    name: "accept_and_fund",
    description: "Accept the job and submit the buyer's signed authorization, which moves the USDC into escrow.",
    inputSchema: z.object({}),
    run: async () => {
      const a = deal.authorization!;
      const hash = await send(sellerWallet, "createEscrowWithAuthorization", [
        buyer.address,
        deal.terms,
        a.validAfter,
        a.validBefore,
        a.signature,
      ]);
      deal.fundingTx = hash;
      say("chain", `createEscrowWithAuthorization → ${txLink(hash)}`);
      return `Funded: ${fmt(deal.terms!.amount)} is now in escrow. ${txLink(hash)}`;
    },
  });

  const decline = betaZodTool({
    name: "decline_offer",
    description: "Decline the job.",
    inputSchema: z.object({ reason: z.string() }),
    run: async ({ reason }) => {
      deal.declined = reason;
      return "Declined.";
    },
  });

  return {
    role: "seller",
    system: SYSTEM,
    prompt: "A buyer has sent you an offer. Inspect it, then accept and fund it, or decline it with a reason.",
    tools: [inspectOffer, acceptAndFund, decline],
    effort: "medium",
    stub: async (agent) => {
      const offer = JSON.parse(await agent.call("inspect_offer")) as { checks: Record<string, boolean> };
      const failed = Object.entries(offer.checks).filter(([, ok]) => !ok).map(([name]) => name);
      if (failed.length) {
        await agent.call("decline_offer", { reason: `Failed checks: ${failed.join(", ")}.` });
        await agent.say("I declined: the offer doesn't match what is committed on-chain.");
        return;
      }
      await agent.call("accept_and_fund");
      await agent.say("All checks pass, so I funded the escrow and will start the work.");
    },
  };
}

/** Seller does the job and submits the deliverable. `shortcut` makes it cut corners, for the partial-payout scenario. */
export function sellerDelivers(deal: Deal, opts: { shortcut?: boolean } = {}): AgentPhase {
  const submit = betaZodTool({
    name: "submit_deliverable",
    description: "Submit your finished work. The verifier sees exactly this content.",
    inputSchema: z.object({ content: z.string() }),
    run: async ({ content }) => {
      deal.deliverable = content;
      return "Submitted.";
    },
  });

  const shortcut = opts.shortcut
    ? "\nYou are badly overbooked today: submit a fast first draft and skip whatever criterion would take the longest."
    : "";
  return {
    role: "seller",
    system: SYSTEM,
    prompt: `The escrow is funded. Do the job described in this spec, then call submit_deliverable.${shortcut}\n\n<spec>\n${deal.spec}\n</spec>`,
    tools: [submit],
    effort: "medium",
    check: () => {
      if (!deal.deliverable) throw new Error("Seller did not submit a deliverable");
    },
    stub: async (agent) => {
      await agent.call("submit_deliverable", { content: opts.shortcut ? stubShortcutDeliverable : stubDeliverable });
      await agent.say(opts.shortcut ? "Submitted the function; the tests will have to wait." : "Submitted the function and its tests.");
    },
  };
}
