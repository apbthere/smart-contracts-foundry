import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { keccak256, parseUnits, toBytes } from "viem";
import { z } from "zod";
import { type Deal, json, runAgent, say } from "../agent.ts";
import { Status, USDC_DECIMALS, fmt, getEscrow, now } from "../chain.ts";

const SYSTEM = `You are an escrow verification assistant. You advise a human verifier, who holds the signing key and makes the final call on how escrowed USDC is split between a seller and a buyer.
Grade the deliverable strictly against the spec's acceptance criteria, not against what you think the buyer wanted. Propose paying the seller in proportion to the criteria met; full payment only if every criterion is met.
The human reads your rationale before signing, so explain your proposal criterion by criterion and flag anything you are unsure about.`;

/** The verifier agent drafts a verdict. It holds no key: only the human can turn the draft into a signature. */
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
        specHashMatchesOnchainSalt: keccak256(toBytes(deal.spec!)) === deal.terms!.salt,
        spec: deal.spec,
        deliverable: deal.deliverable,
      });
    },
  });

  const draft = betaZodTool({
    name: "draft_verdict",
    description:
      "Propose a verdict to the human verifier. toSellerUsdc goes to the seller; the rest of the escrow goes back to the buyer.",
    inputSchema: z.object({
      toSellerUsdc: z.string().describe('USDC to the seller, e.g. "1.75".'),
      rationale: z.string().describe("Criterion-by-criterion justification for the human reviewer."),
    }),
    strict: true,
    run: async ({ toSellerUsdc, rationale }) => {
      // The contract would reject these anyway; refusing here keeps the human from being shown an unusable draft.
      const e = await getEscrow(deal.escrowId!);
      const toSeller = parseUnits(toSellerUsdc, USDC_DECIMALS);
      if (e.status !== Status.Funded) return `Refused: escrow is ${Status[e.status]}, not Funded.`;
      if ((await now()) > e.deadline) return "Refused: the deadline has passed; only refundExpired applies now.";
      if (toSeller < 0n || toSeller > e.amount) return `Refused: toSeller must be between 0 and ${fmt(e.amount)}.`;

      deal.draft = { toSeller, rationale };
      say("verifier", `drafted: ${fmt(toSeller)} to seller, ${fmt(e.amount - toSeller)} to buyer (awaiting human sign-off)`);
      return "Draft sent to the human verifier.";
    },
  });

  await runAgent({
    role: "verifier",
    system: SYSTEM,
    prompt: "A case is ready. Load it, grade the deliverable, and draft a verdict for the human verifier.",
    tools: [getCase, draft],
    effort: "high",
  });
  if (!deal.draft) throw new Error("Verifier did not draft a verdict");
}
