type DatabaseRow = Record<string, unknown>;

interface ParagraphSearchRow extends DatabaseRow {
  paragraph: unknown;
}

export function mapBookCatalogRows(rows: DatabaseRow[]): DatabaseRow[] {
  return rows.map((row) => ({ ...row }));
}

export function mapManifestResponse(
  bookRows: DatabaseRow[],
  readingPositionRows: DatabaseRow[],
): { book: DatabaseRow; readingPosition: DatabaseRow | null } {
  return {
    book: { ...bookRows[0] },
    readingPosition: readingPositionRows[0] ? { ...readingPositionRows[0] } : null,
  };
}

export function mapChapterRows(rows: DatabaseRow[]): DatabaseRow[] {
  return rows.map((row) => ({ ...row }));
}

export function mapPageRows(rows: DatabaseRow[]): DatabaseRow[] {
  return rows.map((row) => ({ ...row }));
}

export function mapParagraphSearchRows(rows: ParagraphSearchRow[]): unknown[] {
  return rows.map((row) => row.paragraph);
}

export function mapBookmarkRows(rows: DatabaseRow[]): DatabaseRow[] {
  return rows.map((row) => ({ ...row }));
}

export function mapHighlightRows(rows: DatabaseRow[]): DatabaseRow[] {
  return rows.map((row) => ({ ...row }));
}

export function mapNoteRows(rows: DatabaseRow[]): DatabaseRow[] {
  return rows.map((row) => ({ ...row }));
}
