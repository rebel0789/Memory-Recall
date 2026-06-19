-- Target schema for OAF-004. The bootstrap does not execute this migration.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  policy jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE workflow_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  workflow_key text NOT NULL,
  version text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, workflow_key, version)
);
CREATE TABLE runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  workflow_version_id text NOT NULL REFERENCES workflow_versions(id),
  status text NOT NULL,
  objective text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  run_id text NOT NULL REFERENCES runs(id),
  sequence bigint NOT NULL,
  schema_version text NOT NULL,
  type text NOT NULL,
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  data_class text NOT NULL,
  producer_version text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE INDEX events_workspace_time ON events(workspace_id, occurred_at DESC);
CREATE TABLE records (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL,
  text_value text NOT NULL,
  status text NOT NULL,
  scope text NOT NULL,
  source text NOT NULL,
  confidence double precision NOT NULL DEFAULT .5,
  authority double precision NOT NULL DEFAULT .5,
  valid_from timestamptz,
  valid_to timestamptz,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  supersedes text REFERENCES records(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768)
);
CREATE INDEX records_lexical ON records USING gin(to_tsvector('simple', text_value));
CREATE INDEX records_scope_status ON records(workspace_id, scope, status);
CREATE TABLE record_edges (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  source_id text NOT NULL REFERENCES records(id),
  relation text NOT NULL,
  target_id text NOT NULL REFERENCES records(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(workspace_id, source_id, relation, target_id)
);
CREATE TABLE context_manifests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  run_id text REFERENCES runs(id),
  compiler_version text NOT NULL,
  request jsonb NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE artifacts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  sha256 text NOT NULL,
  media_type text NOT NULL,
  bytes bigint NOT NULL,
  storage_key text NOT NULL,
  data_class text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, sha256)
);
CREATE TABLE approvals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  run_id text REFERENCES runs(id),
  operation_hash text NOT NULL,
  actor_id text NOT NULL,
  status text NOT NULL,
  risk_class text NOT NULL,
  idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  resolved_at timestamptz
);
CREATE TABLE evaluations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  run_id text REFERENCES runs(id),
  dataset_version text NOT NULL,
  evaluator_version text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
