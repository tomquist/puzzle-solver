/** Friendly names for detectBox candidate label ids (see pipeline/box/detectBox). */
const LABELS: Record<string, string> = {
  picture: 'Picture',
  lid: 'Whole lid',
  'frame-inner': 'Inside the frame',
  alternative: 'Alternative',
  'whole-photo': 'Whole photo',
};

export function candidateLabel(id: string): string {
  if (id in LABELS) return LABELS[id];
  // Unknown id: "some-new_id" → "Some new id".
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Alternative';
}

/** Should the corners step ask the user to double-check the detected outline? */
export function needsCornerCheck(confidence: number, issueCodes: string[]): boolean {
  return confidence < 0.5 || issueCodes.includes('cut_off') || issueCodes.includes('box_not_found');
}
