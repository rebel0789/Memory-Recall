CREATE TABLE identity_users (
  id text PRIMARY KEY,
  username text NOT NULL,
  username_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL,
  password_credential text NOT NULL,
  password_credential_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE identity_workspace_memberships (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  role text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(user_id, workspace_id)
);

CREATE INDEX identity_workspace_memberships_workspace
  ON identity_workspace_memberships(workspace_id, role, status);

CREATE TABLE identity_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id),
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  remote_address_hash text,
  user_agent_hash text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX identity_sessions_user_active
  ON identity_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE identity_api_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  workspace_ids text[] NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX identity_api_tokens_user_active
  ON identity_api_tokens(user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE security_audit_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  actor_user_id text REFERENCES identity_users(id),
  target_user_id text REFERENCES identity_users(id),
  workspace_id text REFERENCES workspaces(id),
  outcome text NOT NULL,
  occurred_at timestamptz NOT NULL,
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX security_audit_events_workspace_time
  ON security_audit_events(workspace_id, occurred_at DESC);

CREATE INDEX security_audit_events_actor_time
  ON security_audit_events(actor_user_id, occurred_at DESC);
