/** The puzzle lane runs work one after the other per puzzle; a failure does not block what follows. */
import { describe, expect, it } from 'vitest';
import { inPuzzleLane } from './puzzleLane';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('puzzle lane', () => {
  it('runs work of one puzzle in order, never overlapping; other puzzles independently', async () => {
    const log: string[] = [];
    let running = 0;
    const job = (name: string, ticks: number) => async () => {
      running++;
      expect(running).toBe(1);
      log.push(`${name}+`);
      for (let i = 0; i < ticks; i++) await tick();
      log.push(`${name}-`);
      running--;
      return name;
    };
    const other: string[] = [];
    const results = await Promise.all([
      inPuzzleLane('p', job('scan', 3)),
      inPuzzleLane('p', job('grid', 1)),
      inPuzzleLane('q', async () => {
        other.push(`q while ${log.join(' ')}`);
        return 'q';
      }),
      inPuzzleLane('p', job('rescan', 2)),
    ]);
    expect(results).toEqual(['scan', 'grid', 'q', 'rescan']);
    expect(log).toEqual(['scan+', 'scan-', 'grid+', 'grid-', 'rescan+', 'rescan-']);
    // The other puzzle's work did not wait for this one's.
    expect(other[0]).not.toContain('scan-');
  });

  it('a failed job rejects its caller only; the next one runs', async () => {
    const failed = inPuzzleLane('p', async () => {
      throw new Error('boom');
    });
    const next = inPuzzleLane('p', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
