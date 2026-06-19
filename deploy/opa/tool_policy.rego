package oaf.tool

default allow := false

allow if {
  input.actor_id != ""
  input.workspace_id != ""
  input.tool_registered
  input.schema_valid
  input.scope_allowed
  input.network_allowed
  input.filesystem_allowed
  input.secrets_allowed
  input.data_class_allowed
  input.within_limits
  not consequential_without_approval
}

consequential_without_approval if {
  input.risk_class == "consequential-write"
  not input.approval_valid
}
