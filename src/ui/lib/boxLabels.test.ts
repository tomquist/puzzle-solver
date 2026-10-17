import { describe, expect, it } from 'vitest';
import { candidateLabel, needsCornerCheck } from './boxLabels';

describe('box candidate labels', () => {
  it('maps the pipeline ids', () => {
    expect(candidateLabel('picture')).toBe('Picture');
    expect(candidateLabel('lid')).toBe('Whole lid');
    expect(candidateLabel('frame-inner')).toBe('Inside the frame');
    expect(candidateLabel('alternative')).toBe('Alternative');
    expect(candidateLabel('whole-photo')).toBe('Whole photo');
  });
  it('falls back for unknown ids', () => {
    expect(candidateLabel('top_half-crop')).toBe('Top half crop');
    expect(candidateLabel('')).toBe('Alternative');
  });
  it('asks for a corner check on low confidence or cut-off pictures', () => {
    expect(needsCornerCheck(0.9, [])).toBe(false);
    expect(needsCornerCheck(0.3, [])).toBe(true);
    expect(needsCornerCheck(0.9, ['cut_off'])).toBe(true);
    expect(needsCornerCheck(0.9, ['box_not_found'])).toBe(true);
  });
});
