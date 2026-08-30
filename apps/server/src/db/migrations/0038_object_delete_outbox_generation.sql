alter table object_delete_outbox
  add column if not exists generation bigint not null default 1;

alter table object_delete_outbox
  drop constraint if exists object_delete_outbox_generation_check;

alter table object_delete_outbox
  add constraint object_delete_outbox_generation_check check (generation >= 1);
