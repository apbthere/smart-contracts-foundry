import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { keccak256, parseUnits, toBytes } from "viem";
import { z } from "zod";
import { type Deal, json, runAgent, say } from "../agent.ts";
import { Status, USDC_DECIMALS, fmt, getEscrow, now, signVerdict, verifierAccount } from "../chain.ts";

const VERDICT_TTL = 15n * 60n;

const SYSTEM = `You are an independent escrow verifier. Your signed verdict decides how escrowed USDC is split between a seller and a buyer.
Grade the deliverable strictly against the spec's acceptance criteria, not against what you think the buyer wanted. Pay the seller in proportion to the criteria met; full payment only if every criterion is met.
Your signature is final and settles real funds, so check the case first and explain your decision criterion by criterion.`;

export async function verifierRules(deal: Deal) {
  const getCase = betaZodTool({
    name: "get_case",
    description: "Load the escrow from chain together with the spec and the deliverable.",
    inputSchema: z.object({}),
    run: async () => {
      const e = await getEscrow(deal.escrowId!);
      return json({
        escrowId: deal.escrowId,
        status: Status[e.status],
        amount: fmt(e.amount),
        minutesUntilDeadline: Number(e.deadline - (await now())) / 60,
        youAreTheEscrowVerifier: e.verifier === verifierAccount.address,
        specHashMatchesOnchainSalt: keccak256(toBytes(deal.spec!)) === deal.terms!.salt,
        spec: deal.spec,
        deliverable: deal.deliverable,
      });
    },
  });

  const sign = betaZodTool({
    name: "sign_verdict",
    description: "Sign the verdict. toSellerUsdc goes to the seller; the rest of the escrow goes back to the buyer.",
    inputSchema: z.object({
      toSellerUsdc: z.string().describe('USDC to the seller, e.g. "1.75".'),
      rationale: z.string().describe("Criterion-by-criterion justification."),
    }),
    strict: true,
    run: async ({ toSellerUsdc, rationale }) => {
      // The contract would reject these anyway; refusing here keeps the verifier from signing anything unusable.
      const e = await getEscrow(deal.escrowId!);
      const blockTime = await now();
      const toSeller = parseUnits(toSellerUsdc, USDC_DECIMALS);
      if (e.status !== Status.Funded) return `Refused: escrow is ${Status[e.status]}, not Funded.`;
      if (blockTime > e.deadline) return "Refused: the deadline has passed; only refundExpired applies now.";
      if (toSeller < 0n || toSeller > e.amount) return `Refused: toSeller must be between 0 and ${fmt(e.amount)}.`;

      const expiry = blockTime + VERDICT_TTL;
      const signature = await signVerdict(deal.escrowId!, toSeller, expiry);
      deal.verdict = { toSeller, expiry, signature, rationale };
      say("verifier", `signed EIP-712 verdict: ${fmt(toSeller)} to seller, ${fmt(e.amount - toSeller)} to buyer`);
      return `Signed. Valid for ${VERDICT_TTL / 60n} minutes.`;
    },
  });

  await runAgent({
    role: "verifier",
    system: SYSTEM,
    prompt: "A case is ready for a verdict. Load it, grade the deliverable, and sign a verdict.",
    tools: [getCase, sign],
    effort: "high",
  });
  if (!deal.verdict) throw new Error("Verifier did not sign a verdict");
}
