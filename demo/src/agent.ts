import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import type { Address, Hash, Hex } from "viem";
import type { Terms } from "./chain.ts";

const client = new Anthropic();
const MODEL = "claude-opus-5-5";
/** With STUB_ANTHROPIC=1 each phase runs its scripted `stub` instead of the model: same tools, no API calls. */
export const STUBBED = process.env.STUB_ANTHROPIC === "1";

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
  draft?: { toSeller: bigint; rationale: string };
  verdict?: { toSeller: bigint; expiry: bigint; signature: Hex };
  humanDecision?: { action: "approve" | "edit" | "reject"; note?: string };
  buyerDecision?: { action: "release" | "dispute"; reason: string };
};

export type Role = "buyer" | "seller" | "verifier" | "human";

/** One line of the demo's log. The terminal prints `text`; the studio page renders by `kind`. */
export type LogEntry = {
  t: number;
  role: Role | "chain";
  kind: "say" | "thinking" | "tool_use" | "tool_result" | "usage";
  text: string;
  tool?: string;
  data?: unknown;
};

/** Every log entry as it happens, for the studio page. */
export const log = new EventEmitter<{ entry: [LogEntry] }>();

const COLORS: Record<Role, string> = { buyer: "\x1b[36m", seller: "\x1b[33m", verifier: "\x1b[35m", human: "\x1b[1;31m" };
const RESET = "\x1b[0m";

mkdirSync(new URL("../runs/", import.meta.url), { recursive: true });
const transcript = new URL(`../runs/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`, import.meta.url);

export function say(role: Role | "chain", text: string, detail: Pick<LogEntry, "kind" | "tool" | "data"> = { kind: "say" }) {
  const prefix = role === "chain" ? "\x1b[32m[chain]" : `${COLORS[role]}[${role}]`;
  console.log(`${prefix}${RESET} ${text}`);
  const t = Date.now();
  appendFileSync(transcript, JSON.stringify({ t, role, text }) + "\n");
  log.emit("entry", { t, role, text, ...detail });
}

/** Detail only the studio page shows (thinking, full tool results), so the terminal stays as terse as before. */
function emit(role: Role, kind: LogEntry["kind"], text: string, extra: Pick<LogEntry, "tool" | "data"> = {}) {
  log.emit("entry", { t: Date.now(), role, kind, text, ...extra });
}

export const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

/** One agent turn: what the model is told, the tools it may call, and a check that it did its job. */
export type AgentPhase = {
  role: Role;
  system: string;
  prompt: string;
  tools: BetaRunnableTool<any>[];
  effort: "low" | "medium" | "high";
  /** Throws if the agent stopped without doing what the phase needs. */
  check?: () => void;
  /** Scripted stand-in for the model, used when STUBBED. */
  stub: (agent: StubAgent) => Promise<void>;
};

/** What a stub can do: talk, and call the phase's tools by name the way the model would. */
export type StubAgent = {
  say: (text: string) => Promise<void>;
  /** Runs the tool and returns what it would hand back to the model. */
  call: (tool: string, input?: Record<string, unknown>) => Promise<string>;
};

/** Run one agent phase: the tool runner loops until the agent stops calling tools. Returns its final text. */
export async function runAgent(phase: AgentPhase): Promise<string> {
  // Wrapped so the studio can show exactly what each tool handed back to the model.
  const tools = phase.tools.map(
    (tool) =>
      ({
        ...tool,
        run: async (args: unknown, context: unknown) => {
          try {
            const result = await tool.run(args, context as never);
            emit(phase.role, "tool_result", typeof result === "string" ? result : json(result), { tool: tool.name });
            return result;
          } catch (err) {
            emit(phase.role, "tool_result", `Error: ${(err as Error).message}`, { tool: tool.name });
            throw err;
          }
        },
      }) as BetaRunnableTool<any>,
  );

  if (STUBBED) return runStub(phase, tools);

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: phase.effort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: phase.system,
    tools,
    messages: [{ role: "user", content: phase.prompt }],
    max_iterations: 12,
  });

  let last: Anthropic.Beta.BetaMessage | undefined;
  const usage = { input: 0, output: 0 };
  for await (const message of runner) {
    last = message;
    usage.input += message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0);
    usage.output += message.usage.output_tokens;
    if (message.stop_reason === "refusal") {
      throw new Error(`${phase.role} agent declined: ${message.stop_details?.explanation ?? "no explanation"}`);
    }
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking.trim()) emit(phase.role, "thinking", block.thinking.trim());
      if (block.type === "text" && block.text.trim()) say(phase.role, block.text.trim());
      if (block.type === "tool_use") {
        say(phase.role, `→ ${block.name}(${summarize(block.input)})`, { kind: "tool_use", tool: block.name, data: block.input });
      }
    }
  }
  emit(phase.role, "usage", `${usage.input} input / ${usage.output} output tokens`, { data: usage });
  phase.check?.();
  return (last?.content ?? [])
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

async function runStub(phase: AgentPhase, tools: BetaRunnableTool<any>[]): Promise<string> {
  // A short pause per action keeps the stub readable in the terminal and the studio's live feed.
  const pause = () => new Promise((r) => setTimeout(r, 400));
  let last = "";
  await phase.stub({
    say: async (text) => {
      await pause();
      say(phase.role, text);
      last = text;
    },
    call: async (name, input = {}) => {
      await pause();
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`${phase.role} stub called unknown tool ${name}`);
      say(phase.role, `→ ${name}(${summarize(input)})`, { kind: "tool_use", tool: name, data: input });
      const result = await tool.run(tool.parse(input));
      return typeof result === "string" ? result : json(result);
    },
  });
  emit(phase.role, "usage", "stubbed: no API call, 0 tokens", { data: { input: 0, output: 0 } });
  phase.check?.();
  return last;
}

function summarize(input: unknown): string {
  const text = JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export const short = (value: Address | Hex) => `${value.slice(0, 8)}…${value.slice(-6)}`;
