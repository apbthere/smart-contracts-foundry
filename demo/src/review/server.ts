import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type Hex, isAddressEqual, parseUnits } from "viem";
import { type Deal, json, say } from "../agent.ts";
import {
  Status,
  USDC_DECIMALS,
  chain,
  fmt,
  getEscrow,
  now,
  prepareVerdict,
  recoverVerdictSigner,
} from "../chain.ts";

const PORT = Number(process.env.REVIEW_PORT ?? 8787);
const VERDICT_TTL = 15n * 60n;
const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");

class BadRequest extends Error {}

/**
 * Serve the review page and wait for the human verifier to sign or reject the draft verdict in their
 * browser wallet. The signature is checked against the escrow's on-chain verifier before it is accepted.
 */
export function humanReview(deal: Deal): Promise<"signed" | "rejected"> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        const status = err instanceof BadRequest ? 400 : 500;
        res.writeHead(status, { "content-type": "application/json" }).end(json({ error: String(err.message) }));
      });
    });

    const finish = (outcome: "signed" | "rejected") => {
      server.close();
      server.closeAllConnections();
      resolve(outcome);
    };

    async function handle(req: IncomingMessage, res: ServerResponse) {
      const reply = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(json(body));

      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      if (req.method === "GET" && req.url === "/case") {
        const e = await getEscrow(deal.escrowId!);
        return reply({
          escrowId: deal.escrowId,
          chainId: chain.id,
          verifier: e.verifier,
          status: Status[e.status],
          amountUsdc: fmt(e.amount),
          minutesLeft: Number(e.deadline - (await now())) / 60,
          spec: deal.spec,
          deliverable: deal.deliverable,
          draft: { toSellerUsdc: fmt(deal.draft!.toSeller).replace(" USDC", ""), rationale: deal.draft!.rationale },
        });
      }
      if (req.method !== "POST") throw new BadRequest("Not found");
      const body = await readJson(req);

      if (req.url === "/prepare") {
        const toSeller = await checkVerdict(deal, body.toSellerUsdc);
        const expiry = (await now()) + VERDICT_TTL;
        const typedData = await prepareVerdict(deal.escrowId!, toSeller, expiry);
        return reply({
          ...typedData,
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            ...typedData.types,
          },
        });
      }

      if (req.url === "/verdict") {
        const toSeller = await checkVerdict(deal, body.toSellerUsdc);
        if (typeof body.expiry !== "string" || !/^\d+$/.test(body.expiry)) throw new BadRequest("Invalid expiry");
        const expiry = BigInt(body.expiry);
        const signature = body.signature as Hex;
        const note = String(body.note ?? "").trim();
        const edited = toSeller !== deal.draft!.toSeller;
        if (edited && !note) throw new BadRequest("A note is required when you change the AI's proposed amount.");
        if (expiry <= (await now())) throw new BadRequest("This verdict has expired; sign again.");

        const e = await getEscrow(deal.escrowId!);
        const signer = await recoverVerdictSigner(deal.escrowId!, toSeller, expiry, signature);
        if (!isAddressEqual(signer, e.verifier)) {
          throw new BadRequest(`Signed by ${signer}, but this escrow's verifier is ${e.verifier}.`);
        }

        deal.verdict = { toSeller, expiry, signature };
        deal.humanDecision = { action: edited ? "edit" : "approve", note: note || undefined };
        say(
          "human",
          edited
            ? `overrode the AI: ${fmt(toSeller)} to seller (AI proposed ${fmt(deal.draft!.toSeller)}). Note: ${note}`
            : `approved the AI's draft and signed: ${fmt(toSeller)} to seller${note ? `. Note: ${note}` : ""}`,
        );
        reply({ ok: true });
        return finish("signed");
      }

      if (req.url === "/reject") {
        const note = String(body.note ?? "").trim();
        deal.humanDecision = { action: "reject", note: note || undefined };
        say("human", `rejected the draft without signing${note ? `. Note: ${note}` : ""}`);
        reply({ ok: true });
        return finish("rejected");
      }
      throw new BadRequest("Not found");
    }

    server.on("error", reject);
    // Bound to loopback only: the page is for the person running the demo.
    server.listen(PORT, "127.0.0.1", () => {
      say("verifier", `waiting for the human verifier: open http://localhost:${PORT} and sign with your wallet`);
    });
  });
}

/** Parse an amount from the page and check it against the escrow as it stands on-chain now. */
async function checkVerdict(deal: Deal, toSellerUsdc: unknown): Promise<bigint> {
  let toSeller: bigint;
  try {
    toSeller = parseUnits(String(toSellerUsdc), USDC_DECIMALS);
  } catch {
    throw new BadRequest("Amount must be a USDC number, e.g. 1.5");
  }
  const e = await getEscrow(deal.escrowId!);
  if (e.status !== Status.Funded) throw new BadRequest(`Escrow is ${Status[e.status]}, not Funded.`);
  if ((await now()) > e.deadline) throw new BadRequest("The deadline has passed; only refundExpired applies now.");
  if (toSeller < 0n || toSeller > e.amount) throw new BadRequest(`Amount must be between 0 and ${fmt(e.amount)}.`);
  return toSeller;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new BadRequest("Body too large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new BadRequest("Invalid JSON");
  }
}
