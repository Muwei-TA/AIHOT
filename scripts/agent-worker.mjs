#!/usr/bin/env node
// The agent loop that turns an IDE (or any MCP client) into this site's AI engine.
//
// Start it with AGENT_ENGINE=mcp on the api and a token in AGENT_ENGINE_TOKEN, then run:
//   node scripts/agent-worker.mjs --url http://localhost:3001/api/mcp-engine --token <token> --exec claude
// Every pending prompt the engine queued is claimed, answered by the command, and submitted back.
//
// `--exec` runs one prompt and must print the answer on stdout. The default, `claude`, is Claude Code:
//   claude -p "<system>\n\n<prompt>" --output-format text
// For Codex:   --exec "codex exec --skip-git-repo-check -"
// which reads the prompt on stdin. A command that ends in `-` gets the prompt on stdin; any other gets it
// as the last argument.
//
// Without --exec the loop only prints the prompts it claims and releases them: useful to see the queue
// before wiring a model to it.
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: process.env.AGENT_ENGINE_URL ?? "http://127.0.0.1:3001/api/mcp-engine" },
    token: { type: "string", default: process.env.AGENT_ENGINE_TOKEN ?? "" },
    exec: { type: "string", default: process.env.AGENT_ENGINE_EXEC ?? "" },
    name: { type: "string", default: "ide" },
    interval: { type: "string", default: "3000" },
    once: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

if (!args.token || args.token.length < 16) {
  console.error("需要领取令牌：--token <AGENT_ENGINE_TOKEN>（至少 16 位），或设置环境变量 AGENT_ENGINE_TOKEN");
  process.exit(2);
}

const ENDPOINT = args.url;
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${args.token}` };
const INTERVAL = Math.max(500, Number(args.interval) || 3000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

let nextId = 1;
const pending = new Map();

/**
 * One JSON-RPC call over Streamable HTTP. The server answers either as JSON or as a single SSE event;
 * both carry the same message. The session is stateless, so a fresh POST per call is enough.
 */
async function rpc(method, params) {
  const id = nextId++;
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (response.status === 401) throw new Error("令牌被拒绝（401）：检查 --token 是否等于 AGENT_ENGINE_TOKEN");
  if (response.status === 404) throw new Error("引擎没有开启（404）：把 api 的 AGENT_ENGINE 设成 mcp 后重启");
  if (!response.ok) throw new Error(`${method} 返回 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const text = await response.text();
  const message = parseRpcBody(text);
  if (message?.error) throw new Error(`${method} 失败：${message.error.message ?? JSON.stringify(message.error)}`);
  return message?.result;
}

/** The reply inside a JSON body or an SSE stream (the last data line with an id). */
function parseRpcBody(text) {
  const body = text.trim();
  if (!body) return null;
  if (body.startsWith("{")) return JSON.parse(body);
  for (const line of body.split("\n").reverse()) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    try {
      const message = JSON.parse(data);
      if (message.id !== undefined) return message;
    } catch {}
  }
  return null;
}

/** Calls a tool and returns its structured content, falling back to the text block. */
async function callTool(name, toolArgs) {
  const result = await rpc("tools/call", { name, arguments: toolArgs });
  if (result?.isError) {
    const detail = result.structuredContent?.error?.message ?? result.content?.[0]?.text ?? "unknown error";
    throw new Error(`${name}: ${detail}`);
  }
  return result?.structuredContent ?? { text: result?.content?.[0]?.text ?? "" };
}

async function connect() {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: `aihot-agent-worker-${args.name}`, version: "1.0.0" },
  });
  // The server is stateless: no session id to keep, but a notification keeps the transcript honest.
  await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});
  const { tools } = (await rpc("tools/list", {})) ?? {};
  const names = new Set((tools ?? []).map((tool) => tool.name));
  const need = ["claim_agent_task", "submit_agent_task", "release_agent_task"];
  const missing = need.filter((tool) => ![...names].some((name) => name.endsWith(tool)));
  if (missing.length) throw new Error(`引擎缺少工具：${missing.join(", ")}`);
  log(`已连接 ${ENDPOINT}，可用工具 ${names.size} 个`);
  return Object.fromEntries(need.map((tool) => [tool, [...names].find((name) => name.endsWith(tool))]));
}

/** Runs the answer command with the prompt; resolves with its stdout. */
function answer(prompt) {
  const command = args.exec.trim();
  const useStdin = command.endsWith("-");
  return new Promise((resolve, reject) => {
    const child = useStdin
      ? spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(`${command} ${shellQuote(prompt)}`, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; if (args.verbose) process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`回答命令退出码 ${code}：${err.slice(-500)}`));
      resolve(out.trim());
    });
    if (useStdin) child.stdin.end(prompt);
  });
}

/** One shell argument, quoted so a prompt with quotes or newlines survives `sh -c`. */
const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The prompt one answer command receives: the system text, then the user text. */
const promptOf = (task) => (task.system ? `${task.system}\n\n${task.prompt}` : task.prompt);

async function work(tools) {
  const claimed = await callTool(tools.claim_agent_task, { agent: args.name });
  const task = claimed?.task;
  if (!task) return false;
  const id = task.task_id;
  log(`领取任务 ${id}${task.json ? "（要求 JSON）" : ""}，提示词 ${task.prompt.length} 字`);
  if (!args.exec) {
    log(`没有 --exec：任务 ${id} 的提示词预览如下，随后放回队列`);
    console.log(promptOf(task).slice(0, 1200));
    await callTool(tools.release_agent_task, { task_id: id, reason: "dry run: no --exec command" });
    return true;
  }
  let content;
  try {
    content = await answer(promptOf(task));
  } catch (error) {
    log(`任务 ${id} 无法回答：${String(error).slice(0, 300)}；放回队列`);
    await callTool(tools.release_agent_task, { task_id: id, reason: String(error).slice(0, 300) }).catch(() => {});
    return true;
  }
  if (!content) {
    log(`任务 ${id} 的回答为空；放回队列`);
    await callTool(tools.release_agent_task, { task_id: id, reason: "empty answer" }).catch(() => {});
    return true;
  }
  try {
    const res = await callTool(tools.submit_agent_task, { task_id: id, content });
    log(`任务 ${id} 已提交（${content.length} 字）`, res.accepted ? "" : JSON.stringify(res));
  } catch (error) {
    log(`任务 ${id} 提交失败（多半是租约过期）：${String(error).slice(0, 300)}`);
  }
  return true;
}

async function main() {
  let tools;
  for (let attempt = 1; ; attempt++) {
    try {
      tools = await connect();
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      log(`连接失败（第 ${attempt} 次）：${String(error).slice(0, 300)}；${INTERVAL * attempt} ms 后重试`);
      await sleep(INTERVAL * attempt);
    }
  }
  const statusName = Object.values(tools).find((name) => name.endsWith("agent_queue_status"));
  if (statusName) {
    const status = await callTool(statusName, {});
    log(`队列：待领取 ${status.pending}，进行中 ${status.claimed}，租约 ${status.leaseSeconds} 秒`);
  }
  for (;;) {
    try {
      const worked = await work(tools);
      if (args.once) return;
      if (!worked) await sleep(INTERVAL);
    } catch (error) {
      log(`循环出错：${String(error).slice(0, 300)}${args.once ? "" : `；${INTERVAL} ms 后重试`}`);
      if (args.once) process.exit(1);
      await sleep(INTERVAL);
    }
  }
}

process.on("SIGINT", () => { log("停止"); process.exit(0); });
process.on("SIGTERM", () => { log("停止"); process.exit(0); });

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
