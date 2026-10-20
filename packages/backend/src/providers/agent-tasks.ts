// The reverse task queue that lets an MCP agent stand in for the hosted model: the engine writes a
// prompt here and waits, an IDE (Claude Code, Codex, any MCP client) claims one, answers with its own
// model, and submits the answer back. Nothing here talks to an IDE: the database is the queue, and the
// MCP tools in apps/api/src/routes/mcp-engine.ts are the agent's side of it.
//
// A claimed task carries a lease. An agent that dies mid-answer never blocks a prompt forever: once the
// lease lapses the task is claimable again. A row lives only while it is being worked on — an answer is
// deleted from the table as the engine takes it, and an abandoned task is deleted outright — so prompts
// do not pile up in the database.
import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { shutdownSignal } from "../lib/shutdown.ts";

/**
 * How long one claim stays valid before another agent may take the task over. The engine's own wait
 * (AGENT_TASK_TIMEOUT_SECONDS, providers/llm.ts) is separate and no longer than this, so an agent is
 * never answering a prompt the engine has already given up on.
 */
export const LEASE_SECONDS = Math.max(30, Math.floor(Number(process.env.AGENT_TASK_LEASE_SECONDS) || 300));

/** AGENT_ENGINE=mcp: the `default` model's answers come from an MCP agent instead of a hosted model. */
export const agentEngineEnabled = () => (process.env.AGENT_ENGINE ?? "").toLowerCase() === "mcp";

/**
 * A task outlives its use only if the process that queued it died: the engine's wait is bounded (at most
 * 9 minutes), so anything older is a leftover. Removing it here, at most once a minute and only on a
 * claim, keeps the table from growing without a scheduler of its own.
 */
let lastPruned = 0;
async function pruneLeftovers(): Promise<void> {
  if (Date.now() - lastPruned < 60_000) return;
  lastPruned = Date.now();
  const rows = await sql`DELETE FROM agent_tasks WHERE created_at < now() - interval '1 hour' RETURNING id`;
  if (rows.length) console.log(JSON.stringify({ level: "info", msg: "agent tasks pruned", count: rows.length }));
}

export interface AgentTask {
  id: number;
  system: string;
  prompt: string;
  jsonMode: boolean;
}

export class AgentTaskError extends Error {}

/** Queues one prompt and returns its id. */
export async function enqueueAgentTask(task: { system: string; prompt: string; jsonMode: boolean }): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO agent_tasks (system_prompt, prompt, json_mode)
    VALUES (${task.system}, ${task.prompt}, ${task.jsonMode})
    RETURNING id`;
  return row!.id;
}

/**
 * The next task for one agent. A pending task, or a claimed one whose lease lapsed, is taken with a new
 * lease; SKIP LOCKED keeps two agents from answering the same prompt.
 */
export async function claimAgentTask(worker: string): Promise<(AgentTask & { leaseSeconds: number }) | null> {
  await pruneLeftovers();
  const [row] = await sql<{ id: number; system_prompt: string; prompt: string; json_mode: boolean }[]>`
    UPDATE agent_tasks SET
      status = 'claimed',
      worker = ${worker},
      lease_until = now() + make_interval(secs => ${LEASE_SECONDS}),
      updated_at = now()
    WHERE id = (
      SELECT id FROM agent_tasks
      WHERE status = 'pending' OR (status = 'claimed' AND lease_until < now())
      ORDER BY id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, system_prompt, prompt, json_mode`;
  if (!row) return null;
  return { id: row.id, system: row.system_prompt, prompt: row.prompt, jsonMode: row.json_mode, leaseSeconds: LEASE_SECONDS };
}

/** The answer for a claimed task. An answer whose lease lapsed is refused, never silently written. */
export async function submitAgentTask(taskId: number, content: string): Promise<{ accepted: true } | { accepted: false; reason: string }> {
  const [row] = await sql<{ id: number }[]>`
    UPDATE agent_tasks SET status = 'done', result = ${content}, lease_until = NULL, updated_at = now()
    WHERE id = ${taskId} AND status = 'claimed' AND lease_until > now()
    RETURNING id`;
  if (row) return { accepted: true };
  const [existing] = await sql<{ status: string }[]>`SELECT status FROM agent_tasks WHERE id = ${taskId}`;
  if (!existing) return { accepted: false, reason: `task ${taskId} is gone; the engine stopped waiting for it. Claim a task to continue.` };
  if (existing.status === "done") return { accepted: false, reason: `task ${taskId} was already answered` };
  return { accepted: false, reason: `task ${taskId} is ${existing.status} and its lease lapsed; claim it again to answer` };
}

/** Hands a task back without an answer, so the next claim takes it at once. */
export async function releaseAgentTask(taskId: number, reason: string): Promise<boolean> {
  const rows = await sql`
    UPDATE agent_tasks SET status = 'pending', worker = ${`released: ${reason.slice(0, 200)}`}, lease_until = NULL, updated_at = now()
    WHERE id = ${taskId} AND status = 'claimed'
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Waits for the answer to one task and takes it out of the table in the same statement. Rejects when the
 * deadline passes, the process is stopping, or the task is gone. Polling holds no connection while
 * waiting, so one worker can wait on several prompts at once.
 */
export async function takeAgentAnswer(taskId: number, timeoutMs: number, pollMs = 500): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answered = await sql<{ result: string | null }[]>`
      DELETE FROM agent_tasks WHERE id = ${taskId} AND status = 'done' RETURNING result`;
    if (answered[0]) return answered[0].result ?? "";
    const [row] = await sql<{ status: string }[]>`SELECT status FROM agent_tasks WHERE id = ${taskId}`;
    if (!row) throw new AgentTaskError(`agent task ${taskId} is gone`);
    if (shutdownSignal.signal.aborted) throw new AgentTaskError(`agent task ${taskId} abandoned: the worker is stopping`);
    if (Date.now() >= deadline) throw new AgentTaskError(`agent task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s without an agent answer`);
    await new Promise((resolve) => setTimeout(resolve, pollMs).unref?.());
  }
}

/** Drops a task the engine no longer needs, so a late agent's answer is refused instead of stored. */
export async function abandonAgentTask(taskId: number, reason: string): Promise<void> {
  await sql`DELETE FROM agent_tasks WHERE id = ${taskId} AND status <> 'done'`;
  console.log(JSON.stringify({ level: "info", msg: "agent task abandoned", taskId, reason: reason.slice(0, 200) }));
}

/** A per-agent name presented when claiming, so the queue shows which IDE is answering. */
export const agentWorkerName = (label: string) => `${label}:${randomUUID().slice(0, 8)}`;

/** Counts by state, so an agent can check the queue is reachable before it starts claiming. */
export async function queueStatus(): Promise<{ pending: number; claimed: number; leaseSeconds: number }> {
  const rows = await sql<{ status: string; count: number }[]>`
    SELECT status, count(*)::int AS count FROM agent_tasks WHERE status IN ('pending', 'claimed') GROUP BY status`;
  const at = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
  return { pending: at("pending"), claimed: at("claimed"), leaseSeconds: LEASE_SECONDS };
}
