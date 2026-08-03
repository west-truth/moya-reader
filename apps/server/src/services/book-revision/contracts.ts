export interface ExistingBookRevision {
  readonly bookId: string;
  readonly userId: string;
  readonly contentRevisionId: string;
  readonly contentRevisionNumber: number;
  readonly graphRevisionId?: string;
  readonly revisionFence: number;
  readonly normalizedTextHash: string;
}

export interface PreparedBookReplacement {
  readonly runId: string;
  readonly bookId: string;
  readonly userId: string;
  readonly fromContentRevisionId: string;
  readonly toContentRevisionId: string;
  readonly toContentRevisionNumber: number;
  readonly fromGraphRevisionId?: string;
  readonly expectedRevisionFence: number;
  readonly normalizedTextHash: string;
}

export interface BookReplacementSummary {
  readonly cancelledWorkflowCount: number;
  readonly cancelledProviderJobCount: number;
  readonly quarantinedEntityCount: number;
  readonly remappedCharacterCount: number;
  readonly remappedRelationCount: number;
  readonly remappedVoiceProfileCount: number;
  readonly remappedCorrectionCount: number;
}
