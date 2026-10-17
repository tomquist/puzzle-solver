import { describe, expect, it } from 'vitest';
import { formatBytes, parsePositive, plural, safeFileName } from './format';

describe('format', () => {
  it('formats bytes', () => {
    expect(formatBytes(undefined)).toBe('–');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
  it('pluralises', () => {
    expect(plural(1, 'piece')).toBe('1 piece');
    expect(plural(3, 'piece')).toBe('3 pieces');
  });
  it('makes safe file names', () => {
    expect(safeFileName('Great Wave / 1000!', 'puzzle')).toBe('Great-Wave-1000.puzzle');
    expect(safeFileName('   ', 'zip')).toBe('puzzle.zip');
  });
  it('parses positive numbers', () => {
    expect(parsePositive('70')).toBe(70);
    expect(parsePositive('49,5')).toBe(49.5);
    expect(parsePositive('')).toBeUndefined();
    expect(parsePositive('-1')).toBeUndefined();
  });
});
