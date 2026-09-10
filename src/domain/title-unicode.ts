// NFKC is useful for full-width punctuation/digits, but turns standalone ㄴ into
// U+1102. Catalogs can treat those visually identical spellings as different queries.
// Compose complete syllables first, then restore only the remaining standalone jamo.
const standaloneJamo = new Map(
  Array.from({ length: 0x318e - 0x3131 + 1 }, (_, index) => {
    const character = String.fromCodePoint(0x3131 + index);
    return [character.normalize('NFKC'), character] as const;
  }),
);

export function normalizeTitleUnicode(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u1100-\u11ff]/gu, (character) => standaloneJamo.get(character) ?? character);
}
