import { describe, expect, it } from 'vitest';
import { nearestQuarterTurn, normalizeDeg, signedDeg, turnBadge, turnInstruction, upVector } from './rotation';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('angle normalisation', () => {
  it('normalizes into [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(450)).toBe(90);
  });
  it('signs into (-180, 180]', () => {
    expect(signedDeg(270)).toBe(-90);
    expect(signedDeg(180)).toBe(180);
    expect(signedDeg(-180)).toBe(180);
    expect(signedDeg(10)).toBe(10);
  });
});

describe('upVector (photo direction of the piece top)', () => {
  it('points up for an upright piece', () => {
    const u = upVector(0);
    close(u.x, 0);
    close(u.y, -1);
  });
  it('points left when the piece needs a clockwise quarter turn', () => {
    // Turning clockwise by 90° moves what is now on the left to the top.
    const u = upVector(90);
    close(u.x, -1);
    close(u.y, 0);
  });
  it('points down for 180° and right for 270°', () => {
    close(upVector(180).y, 1);
    close(upVector(270).x, 1);
  });
  it('handles small tilts', () => {
    const u = upVector(-30); // piece tilted 30° clockwise; top points up-right
    close(u.x, Math.sin(Math.PI / 6));
    close(u.y, -Math.cos(Math.PI / 6));
  });
});

describe('turn instructions', () => {
  it('rounds to the nearest quarter turn', () => {
    expect(nearestQuarterTurn(0)).toBe(0);
    expect(nearestQuarterTurn(44)).toBe(0);
    expect(nearestQuarterTurn(46)).toBe(90);
    expect(nearestQuarterTurn(-80)).toBe(270);
    expect(nearestQuarterTurn(359)).toBe(0);
    expect(nearestQuarterTurn(185)).toBe(180);
  });
  it('describes the turn with exact degrees', () => {
    expect(turnInstruction(0)).toMatchObject({ quarter: 0, short: 'Keep as it is', exact: '' });
    expect(turnInstruction(87)).toMatchObject({ quarter: 90, short: 'Turn ↻ 90°', exact: 'exactly 87° clockwise' });
    expect(turnInstruction(275)).toMatchObject({ quarter: 270, short: 'Turn ↺ 90°', exact: 'exactly 85° counter-clockwise', degrees: -85 });
    expect(turnInstruction(180)).toMatchObject({ quarter: 180, short: 'Turn ↻ 180°', exact: 'exactly 180°' });
    expect(turnInstruction(12).short).toBe('Keep as it is');
    expect(turnInstruction(12).exact).toBe('exactly 12° clockwise');
  });
  it('makes compact badges', () => {
    expect(turnBadge(3)).toBe('');
    expect(turnBadge(92)).toBe('↻90°');
    expect(turnBadge(181)).toBe('180°');
    expect(turnBadge(268)).toBe('↺90°');
  });
});
