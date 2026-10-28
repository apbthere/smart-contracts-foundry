import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { appendFileSync, mkdirSync } from "node:fs";
import type { Address, Hash, Hex } from "viem";
import type { Terms } from "./chain.ts";

const client = new Anthropic();
const MODEL = "claude-opus-5-5";

/** Everything the agents hand to each other. The orchestrator owns it; agents reach it only through tools. */
export type Deal = {
  brief: string;
  spec?: string;
  terms?: Terms;
  escrowId?: Hex;
  authorization?: { validAfter: bigint; validBefore: bigint; signature: Hex };
  fundingTx?: Hash;
  declined?: string;
  deliverable?: string;
  verdict?: { toSeller: bigint; expiry: bigint; signature: Hex; rationale: string };
  buyerDecision?: { action: "release" | "dispute"; reason: string };
};

export type Role = "buyer" | "seller" | "verifier";

const COLORS: Record<Role, string> = { buyer: "\x1b[36m", seller: "\x1b[33m", verifier: "\x1b[35m" };
const RESET = "\x1b[0m";

mkdirSync(new URL("../runs/", import.meta.url), { recursive: true });
const transcript = new URL(`../runs/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`, import.meta.url);

export function say(role: Role | "chain", text: string) {
  const prefix = role === "chain" ? "\x1b[32m[chain]" : `${COLORS[role]}[${role}]`;
  console.log(`${prefix}${RESET} ${text}`);
  appendFileSync(transcript, JSON.stringify({ t: Date.now(), role, text }) + "\n");
}

export const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

/** Run one agent phase: the tool runner loops until the agent stops calling tools. Returns its final text. */
export async function runAgent(opts: {
  role: Role;
  system: string;
  prompt: string;
  tools: BetaRunnableTool<any>[];
  effort: "low" | "medium" | "high";
}): Promise<string> {
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: opts.effort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: opts.system,
    tools: opts.tools,
    messages: [{ role: "user", content: opts.prompt }],
    max_iterations: 12,
  });

  let last: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    last = message;
    if (message.stop_reason === "refusal") {
      throw new Error(`${opts.role} agent declined: ${message.stop_details?.explanation ?? "no explanation"}`);
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) say(opts.role, block.text.trim());
      if (block.type === "tool_use") say(opts.role, `→ ${block.name}(${summarize(block.input)})`);
    }
  }
  return (last?.content ?? [])
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

function summarize(input: unknown): string {
  const text = JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export const short = (value: Address | Hex) => `${value.slice(0, 8)}…${value.slice(-6)}`;
