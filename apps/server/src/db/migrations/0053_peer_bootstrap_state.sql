alter table sync_server_peers
  add column bootstrap_required boolean not null default false;

-- Preserve interrupted copies created by the previous version. Completed replicas
-- and explicitly paired existing libraries retain their cursors and sync state.
update sync_server_peers set bootstrap_required = true
where status = 'bootstrapping'
   or last_error like 'peer_bootstrap_%'
   or last_error like 'peer_backup_%'
   or last_error = 'peer_changed_during_bootstrap';
