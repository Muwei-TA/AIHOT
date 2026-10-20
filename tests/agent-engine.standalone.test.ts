// The agent side of the reverse queue needs no database to be checked for the things that would break an
// IDE: the path is closed while the engine is off, an unauthenticated call is refused, and with a token
// the server advertises exactly the agent tools (never the site's public read-only ones).
import "./standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { registerAgentEngineMcp } from "../apps/api/src/routes/mcp-engine.ts";

const TOKEN = "test-agent-engine-token-0123456789";

async function withApp(env: Record<string, string | undefined>, run: (address: string) => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const app = Fastify();
  const app_ = app;
  try {
    registerAgentEngineMcp(app_);
    const address = await app_.listen({ host: "127.0.0.1", port: 0 });
    await run(address);
  } finally {
    app_.server.closeAllConnections();
    await app_.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the engine path does not exist while AGENT_ENGINE is off", { timeout: 10_000 }, async () => {
  await withApp({ AGENT_ENGINE: "", AGENT_ENGINE_TOKEN: TOKEN }, async (address) => {
    const response = await fetch(`${address}/api/mcp-engine`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 404);
  });
});

test("an unauthenticated call is refused even with the engine on", { timeout: 10_000 }, async () => {
  await withApp({ AGENT_ENGINE: "mcp", AGENT_ENGINE_TOKEN: TOKEN }, async (address) => {
    const response = await fetch(`${address}/api/mcp-engine`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 401);
  });
});

test("a placeholder token never authorizes anything", { timeout: 10_000 }, async () => {
  await withApp({ AGENT_ENGINE: "mcp", AGENT_ENGINE_TOKEN: "changeme" }, async (address) => {
    const response = await fetch(`${address}/api/mcp-engine`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer changeme" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 401);
  });
});

test("with a token the server advertises the agent tools only", { timeout: 15_000 }, async () => {
  await withApp({ AGENT_ENGINE: "mcp", AGENT_ENGINE_TOKEN: TOKEN }, async (address) => {
    const client = new Client({ name: "agent-engine-check", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/api/mcp-engine`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }));
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(names.map((name) => name.split("_").slice(1).join("_")), [
        "agent_queue_status", "claim_agent_task", "release_agent_task", "submit_agent_task",
      ]);
      // Every tool takes an object and the claim tool declares no required field, so an agent can start.
      const claim = (await client.listTools()).tools.find((tool) => tool.name.endsWith("claim_agent_task"))!;
      assert.equal((claim.inputSchema as { type?: string }).type, "object");
    } finally {
      await client.close();
    }
  });
});
