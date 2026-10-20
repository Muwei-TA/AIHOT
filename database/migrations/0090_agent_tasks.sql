-- Tasks for an MCP agent that answers in place of a hosted model: the engine queues one prompt here and
-- waits; an IDE (Claude Code, Codex, any MCP client) claims it, answers with its own model, submits.
-- A row lives only while it is being worked on: the engine deletes an answered task as it takes the
-- answer, and an abandoned one at once, so prompts do not accumulate (providers/agent-tasks.ts).
CREATE TABLE agent_tasks (
  id            bigserial PRIMARY KEY,
  system_prompt text NOT NULL DEFAULT '',
  prompt        text NOT NULL,
  json_mode     boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done')),
  worker        text,
  lease_until   timestamptz,
  result        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
