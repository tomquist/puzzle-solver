import { describe, expect, it } from 'vitest';
import { piecePath, sidePath } from './PieceIcon';

describe('piece outline paths', () => {
  it('draws straight sides and closes the outline', () => {
    expect(piecePath(['flat', 'flat', 'flat', 'flat'], 2, 3, 10)).toBe('M2 3L12.0 3.0L12.0 13.0L2.0 13.0L2.0 3.0Z');
  });

  it('keeps the detail icon’s tab shape (40 px sides) and scales tabs with the side length', () => {
    expect(sidePath('tab', 0, 0, 40, 0)).toBe('L14.4 0.0C16.8 -1.8 11.2 -9.0 20.0 -9.0C28.8 -9.0 23.2 -1.8 25.6 0.0L40.0 0.0');
    // Half the size: the same shape at half the coordinates; a blank bulges the other way.
    expect(sidePath('tab', 0, 0, 20, 0)).toBe('L7.2 0.0C8.4 -0.9 5.6 -4.5 10.0 -4.5C14.4 -4.5 11.6 -0.9 12.8 0.0L20.0 0.0');
    expect(sidePath('blank', 0, 0, 20, 0)).toContain('10.0 4.5');
    // A right side (top to bottom) bulges outward to the right.
    expect(sidePath('tab', 10, 0, 10, 20)).toContain('14.5 10.0');
  });
});
