alter table book_ai_workflows
  add column if not exists workflow_definition_id text not null default 'moya.ai.tts.book-preparation';

alter table book_ai_workflows
  add column if not exists workflow_version text not null default '1.0.0';
