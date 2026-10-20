CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_tasks_lease_idx ON agent_tasks (status, lease_until);
