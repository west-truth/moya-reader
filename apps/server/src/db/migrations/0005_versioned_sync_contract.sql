-- Phase 0C versioned sync compatibility. Canonical event identity remains in
-- sync_events.id; these columns retain only the transport source correlation.

alter table sync_events add column if not exists source_contract_version smallint;
alter table sync_events add column if not exists source_event_id text;

update sync_events
set source_contract_version = case
      when id_contract = 'v2-sha256-128' and hash_contract = 'v2-sha256-tagged' then 2
      else 1
    end,
    source_event_id = case
      when id_contract = 'v2-sha256-128' and hash_contract = 'v2-sha256-tagged' then source_event_id
      else coalesce(source_event_id, id)
    end
where source_contract_version is null;

alter table sync_events alter column source_contract_version set default 2;
alter table sync_events alter column source_contract_version set not null;

create unique index if not exists idx_sync_events_source_identity
  on sync_events(user_id, source_contract_version, source_event_id)
  where source_event_id is not null;

comment on column sync_events.source_event_id is
  'Caller event ID retained when a v1 transport event is canonicalized to a different v2 sync_events.id.';
