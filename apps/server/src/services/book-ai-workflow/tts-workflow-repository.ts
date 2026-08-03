import type { RevisionQueryable } from './analysis-input-repository.js';

export async function findTTSOwningWorkflow(
  db: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly chapterId: string;
  },
): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    `
      select workflow.id
      from book_ai_workflows workflow
      join library_books book
        on book.id = workflow.book_id
       and book.user_id = workflow.user_id
       and book.active_content_revision_id = workflow.content_revision_id
       and book.revision_fence = workflow.revision_fence
      where workflow.user_id = $1
        and workflow.book_id = $2
        and workflow.status in ('running', 'needs_review', 'succeeded')
        and exists (
          select 1
          from book_ai_workflow_jobs workflow_job
          join provider_jobs job on job.id = workflow_job.provider_job_id
          join analysis_input_revisions revision on revision.id = job.analysis_input_revision_id
          where workflow_job.workflow_id = workflow.id
            and workflow_job.stage = 'chapter_labeling'
            and job.chapter_id = $3
            and job.status = 'succeeded'
            and revision.content_revision_id = workflow.content_revision_id
        )
      order by workflow.finished_at desc nulls first, workflow.updated_at desc, workflow.id
      limit 1
    `,
    [input.userId, input.bookId, input.chapterId],
  );
  return result.rows[0]?.id;
}
