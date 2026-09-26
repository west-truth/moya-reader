alter table document_annotations add column if not exists quote text;
alter table document_annotations add column if not exists text_anchor_remap jsonb;
