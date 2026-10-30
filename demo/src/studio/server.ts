// The studio: a local page that runs the demo one step at a time. It shows what each agent is told, every tool
// call and result, and what the escrow holds on-chain after each step, and lets you edit prompts and documents.
//   npm run studio   → http://localhost:8787 (and /contract for how the escrow contract works)
import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type Abi, keccak256, parseAbi, parseEventLogs, parseUnits, toBytes } from "viem";
import { type AgentPhase, type Deal, type LogEntry, STUBBED, json, log, runAgent, say } from "../agent.ts";
import { buyerOpensDeal, buyerReviews } from "../agents/buyer.ts";
import { sellerAcceptsAndFunds, sellerDelivers } from "../agents/seller.ts";
import { verifierRules } from "../agents/verifier.ts";
import { BadRequest, acceptVerdict, prepareForWallet, readJson, rejectDraft } from "../review/server.ts";
import {
  EXPLORER,
  Status,
  USDC_DECIMALS,
  buyer,
  chain,
  computeEscrowId,
  currentVerifier,
  escrowAbi,
  escrowAddress,
  getEscrow,
  now,
  publicClient,
  seller,
  transactions,
  usdcAddress,
} from "../chain.ts";
import {
  DEFAULT_BRIEF,
  SCENARIOS,
  type Scenario,
  TIMEOUT_DEADLINE_MINUTES,
  balances,
  executeVerdict,
  isAnvil,
  refundAfterDeadline,
} from "../steps.ts";

const PORT = Number(process.env.REVIEW_PORT ?? 8787);
const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");
const contractPage = readFileSync(new URL("./contract.html", import.meta.url), "utf8");

type StepId = "open" | "fund" | "deliver" | "review" | "draft" | "sign" | "settle";
type StepState = "waiting" | "ready" | "running" | "done" | "skipped" | "failed";

type Tx = {
  step?: StepId;
  functionName: string;
  from: string;
  hash: string;
  block: bigint;
  gasUsed: bigint;
  events: { name: string; args: unknown }[];
};

type Session = {
  id: number;
  scenario: Scenario;
  budget: string;
  deal: Deal;
  done: Set<StepId>;
  failed: Partial<Record<StepId, string>>;
  /** The system and user prompt each agent step actually ran with, so a finished step shows what it was given. */
  inputs: Partial<Record<StepId, { system: string; prompt: string }>>;
  running?: StepId;
  /** The step that log entries and transactions belong to while it is being handled. */
  tag?: StepId;
  log: (LogEntry & { step?: StepId })[];
  txs: Tx[];
  before: Awaited<ReturnType<typeof balances>>;
};

/** Agent steps, built fresh from the deal each time so the prompts reflect everything that has happened so far. */
const PHASES: Partial<Record<StepId, (s: Session) => AgentPhase>> = {
  open: (s) =>
    buyerOpensDeal(s.deal, {
      budget: parseUnits(s.budget, USDC_DECIMALS),
      deadlineMinutes: s.scenario === "timeout" ? TIMEOUT_DEADLINE_MINUTES : undefined,
    }),
  fund: (s) => sellerAcceptsAndFunds(s.deal),
  deliver: (s) => sellerDelivers(s.deal, { shortcut: s.scenario === "partial" }),
  review: (s) => buyerReviews(s.deal),
  draft: (s) => verifierRules(s.deal),
};

/** Steps with no on-chain effect can be run again, after clearing what they produced. */
const RERUN: Partial<Record<StepId, (d: Deal) => void>> = {
  open: (d) => {
    delete d.spec;
    delete d.terms;
    delete d.escrowId;
    delete d.authorization;
  },
  deliver: (d) => delete d.deliverable,
  draft: (d) => delete d.draft,
};

function plan(s: Session): StepId[] {
  const steps: StepId[] = ["open", "fund", "deliver"];
  if (s.scenario === "release") steps.push("review");
  steps.push(...(s.scenario === "timeout" ? (["settle"] as const) : (["draft", "sign", "settle"] as const)));
  return steps;
}

function skipped(s: Session, id: StepId) {
  const afterFunding = !["open", "fund"].includes(id);
  return (afterFunding && !!s.deal.declined) || (["draft", "sign", "settle"].includes(id) && s.deal.buyerDecision?.action === "release");
}

function stateOf(s: Session, id: StepId): StepState {
  if (s.running === id) return "running";
  if (s.done.has(id)) return "done";
  if (skipped(s, id)) return "skipped";
  const steps = plan(s);
  const ready = steps.slice(0, steps.indexOf(id)).every((p) => s.done.has(p) || skipped(s, p));
  if (!ready) return "waiting";
  return s.failed[id] ? "failed" : "ready";
}

function canRerun(s: Session, id: StepId) {
  const steps = plan(s);
  const next = steps[steps.indexOf(id) + 1];
  return !s.running && s.done.has(id) && !!RERUN[id] && (!next || stateOf(s, next) === "ready" || stateOf(s, next) === "failed");
}

let session: Session;
let sessions = 0;

async function newSession(scenario: Scenario, brief: string, budget: string): Promise<Session> {
  return {
    id: ++sessions,
    scenario,
    budget,
    deal: { brief },
    done: new Set(),
    failed: {},
    inputs: {},
    log: [],
    txs: [],
    before: await balances(),
  };
}

// --- live updates -------------------------------------------------------------------------------------------

const clients = new Set<ServerResponse>();
function broadcast(event: string, data: unknown) {
  for (const res of clients) res.write(`event: ${event}\ndata: ${json(data)}\n\n`);
}
const changed = () => broadcast("changed", {});

log.on("entry", (entry) => {
  const tagged = { ...entry, step: session.running ?? session.tag };
  session.log.push(tagged);
  broadcast("entry", tagged);
});

const usdcEvents = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);
transactions.on("mined", ({ functionName, from, receipt }) => {
  const events = parseEventLogs({ abi: [...escrowAbi, ...usdcEvents] as Abi, logs: receipt.logs }).map((l) => ({
    name: l.eventName,
    args: l.args,
  }));
  session.txs.push({
    step: session.running ?? session.tag,
    functionName,
    from,
    hash: receipt.transactionHash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    events,
  });
  changed();
});

// --- steps --------------------------------------------------------------------------------------------------

function startStep(s: Session, id: StepId, body: Record<string, unknown>) {
  if (s.running) throw new BadRequest(`Wait for "${s.running}" to finish.`);
  const rerun = canRerun(s, id);
  const state = stateOf(s, id);
  if (!rerun && state !== "ready" && state !== "failed") throw new BadRequest(`This step is ${state}.`);
  if (id === "sign") throw new BadRequest("Sign or reject the verdict with your wallet.");

  if (rerun) {
    RERUN[id]!(s.deal);
    s.done.delete(id);
  }
  s.log = s.log.filter((e) => e.step !== id);
  delete s.failed[id];
  s.running = id;
  changed();

  (async () => {
    try {
      const build = PHASES[id];
      if (build) {
        const phase = build(s);
        if (typeof body.system === "string" && body.system.trim()) phase.system = body.system;
        if (typeof body.prompt === "string" && body.prompt.trim()) phase.prompt = body.prompt;
        s.inputs[id] = { system: phase.system, prompt: phase.prompt };
        await runAgent(phase);
        if (id === "fund" && s.deal.declined) say("seller", `declined: ${s.deal.declined}`);
      } else {
        await settle(s);
      }
      s.done.add(id);
    } catch (err) {
      s.failed[id] = (err as Error).message;
    } finally {
      s.running = undefined;
      changed();
    }
  })();
}

async function settle(s: Session) {
  const deal = s.deal;
  if (deal.verdict) return executeVerdict(deal);
  if (s.scenario === "timeout") say("verifier", "(offline: no verdict will be signed)");
  if (!(await refundAfterDeadline(deal, { onlyIfSoon: s.scenario !== "timeout" }))) {
    throw new Error("The deadline is too far off to wait for here. Anyone can call refundExpired once it passes.");
  }
}

/** Run a human action under the sign step, so its log lines and checks belong to it. */
async function asSign<T>(s: Session, fn: () => Promise<T> | T): Promise<T> {
  if (stateOf(s, "sign") !== "ready" && stateOf(s, "sign") !== "failed") throw new BadRequest("The verdict is not ready to sign.");
  s.tag = "sign";
  try {
    return await fn();
  } finally {
    s.tag = undefined;
  }
}

// --- state --------------------------------------------------------------------------------------------------

async function snapshot(s: Session) {
  const d = s.deal;
  const [anvil, block, time, verifier, usdc, bal, buyerEth, sellerEth, onchain, idMatches] = await Promise.all([
    isAnvil(),
    publicClient.getBlock(),
    now(),
    currentVerifier(),
    usdcAddress(),
    balances(),
    publicClient.getBalance({ address: buyer.address }),
    publicClient.getBalance({ address: seller.address }),
    d.escrowId ? getEscrow(d.escrowId) : undefined,
    d.terms ? computeEscrowId(buyer.address, d.terms).then((id) => id === d.escrowId) : undefined,
  ]);
  return {
    session: s.id,
    stubbed: STUBBED,
    scenario: s.scenario,
    scenarios: SCENARIOS,
    budget: s.budget,
    running: s.running,
    network: { chainId: chain.id, anvil, block: block.number, time, explorer: anvil ? null : EXPLORER },
    contract: { escrow: escrowAddress(), usdc, verifier },
    parties: {
      buyer: { address: buyer.address, usdc: bal.buyer, eth: buyerEth },
      seller: { address: seller.address, usdc: bal.seller, eth: sellerEth },
      escrow: { address: escrowAddress(), usdc: bal.escrow },
    },
    before: s.before,
    steps: plan(s).map((id) => ({
      id,
      state: stateOf(s, id),
      error: s.failed[id],
      agent: !!PHASES[id],
      canRerun: canRerun(s, id),
    })),
    deal: {
      ...d,
      specHash: d.spec ? keccak256(toBytes(d.spec)) : undefined,
      checks: d.terms
        ? { specHashMatchesSalt: keccak256(toBytes(d.spec ?? "")) === d.terms.salt, escrowIdMatchesTerms: idMatches }
        : undefined,
    },
    onchain: onchain ? { ...onchain, status: Status[onchain.status] } : null,
    txs: s.txs,
    log: s.log,
  };
}

/** What an agent step is (or was) given: its prompts and the tools it can call, as the model sees them. */
function stepInput(s: Session, id: StepId) {
  const build = PHASES[id];
  if (!build) throw new BadRequest("Not an agent step");
  if (stateOf(s, id) === "waiting") throw new BadRequest("Earlier steps must finish first.");
  const phase = build(s);
  return {
    ...(s.inputs[id] ?? { system: phase.system, prompt: phase.prompt }),
    effort: phase.effort,
    tools: phase.tools.map((t) => ({ name: t.name, description: "description" in t ? t.description : undefined, input_schema: "input_schema" in t ? t.input_schema : undefined })),
  };
}

/** Edit the deal's documents between steps, to show what the integrity checks and the agents catch. */
function editDeal(s: Session, body: Record<string, unknown>) {
  if (s.running) throw new BadRequest(`Wait for "${s.running}" to finish.`);
  for (const field of ["spec", "deliverable"] as const) {
    const value = body[field];
    if (typeof value !== "string" || value === s.deal[field]) continue;
    if (!s.deal[field]) throw new BadRequest(`There is no ${field} yet.`);
    s.deal[field] = value;
    s.tag = field === "spec" ? "open" : "deliver";
    say(
      "human",
      field === "spec"
        ? "edited the spec after the buyer signed it; its hash no longer matches the escrow's salt"
        : "edited the deliverable before the next agent reads it",
    );
    s.tag = undefined;
  }
}

// --- http ---------------------------------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse) {
  const reply = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(json(body));
  const url = req.url ?? "/";

  if (req.method === "GET") {
    if (url === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    if (url === "/contract") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(contractPage);
    if (url === "/api/state") return reply(await snapshot(session));
    if (url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const input = url.match(/^\/api\/step\/(\w+)$/);
    if (input) return reply(stepInput(session, input[1] as StepId));
    throw new BadRequest("Not found");
  }

  if (req.method !== "POST") throw new BadRequest("Not found");
  const body = await readJson(req);

  if (url === "/api/session") {
    if (session.running) throw new BadRequest(`Wait for "${session.running}" to finish.`);
    const scenario = String(body.scenario) as Scenario;
    if (!SCENARIOS.includes(scenario)) throw new BadRequest(`Scenario must be one of ${SCENARIOS.join(", ")}`);
    const budget = String(body.budget ?? "").trim();
    if (!/^\d+(\.\d{1,6})?$/.test(budget) || Number(budget) <= 0) throw new BadRequest("Budget must be a positive USDC amount");
    const brief = String(body.brief ?? "").trim() || DEFAULT_BRIEF;
    session = await newSession(scenario, brief, budget);
    changed();
    return reply({ ok: true });
  }

  const run = url.match(/^\/api\/step\/(\w+)\/run$/);
  if (run) {
    const id = run[1] as StepId;
    if (!plan(session).includes(id)) throw new BadRequest("Not a step in this scenario");
    startStep(session, id, body);
    return reply({ ok: true });
  }

  if (url === "/api/deal") {
    editDeal(session, body);
    changed();
    return reply({ ok: true });
  }

  if (url === "/api/sign/prepare") return reply(await asSign(session, () => prepareForWallet(session.deal, body.toSellerUsdc)));
  if (url === "/api/sign/verdict" || url === "/api/sign/reject") {
    await asSign(session, () => (url.endsWith("verdict") ? acceptVerdict(session.deal, body) : rejectDraft(session.deal, body)));
    session.done.add("sign");
    delete session.failed.sign;
    changed();
    return reply({ ok: true });
  }
  throw new BadRequest("Not found");
}

session = await newSession("happy", DEFAULT_BRIEF, process.env.BUDGET_USDC ?? "5");

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof BadRequest ? 400 : 500;
    res.writeHead(status, { "content-type": "application/json" }).end(json({ error: String(err.message) }));
  });
});
// Bound to loopback only: the page is for the person running the demo.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nEscrow agent studio: http://localhost:${PORT}`);
  console.log(`escrow ${escrowAddress()} on chain ${chain.id}${STUBBED ? "\nstubbed agents: no Anthropic API calls" : ""}\n`);
});
