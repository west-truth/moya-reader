-- Operational source state has its own updates; writing cache data must not reactivate code or remount readers.
-- This is non-secret JSON only. Credentials use the dedicated host vault.
alter table extension_packages add column source_state jsonb not null default '{}'::jsonb;
alter table extension_packages add constraint extension_source_state_object check (jsonb_typeof(source_state) = 'object');
alter table extension_packages add constraint extension_source_state_size check (octet_length(source_state::text) <= 2097152);
