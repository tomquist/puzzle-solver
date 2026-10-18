import { describe, expect, it } from 'vitest';
import { nearestQuarterTurn, normalizeDeg, signedDeg, topEdgeBar, turnArc, turnBadge, turnBand, turnInstruction, upVector } from './rotation';

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
  it('sorts turns into bands, the short way', () => {
    const bands = (degs: number[]) => degs.map(turnBand);
    expect(bands([0, 9.9, -9.9, 359])).toEqual(['upright', 'upright', 'upright', 'upright']);
    expect(bands([10, 34.9, -20, 340])).toEqual(['little', 'little', 'little', 'little']);
    expect(bands([35, 59.9, -45])).toEqual(['eighth', 'eighth', 'eighth']);
    expect(bands([60, 90, 119.9, -90, 270])).toEqual(['quarter', 'quarter', 'quarter', 'quarter', 'quarter']);
    expect(bands([120, 154.9, -130])).toEqual(['nearlyHalf', 'nearlyHalf', 'nearlyHalf']);
    expect(bands([155, 180, -170, 200])).toEqual(['half', 'half', 'half', 'half']);
  });

  it('says how to turn in plain words, the exact angle as small print', () => {
    expect(turnInstruction(0)).toMatchObject({ quarter: 0, band: 'upright', text: 'Already the right way up', exact: '' });
    expect(turnInstruction(4)).toMatchObject({ text: 'Already the right way up', exact: '4° clockwise' });
    expect(turnInstruction(20)).toMatchObject({ text: 'Turn it a little to the right', direction: 'right', exact: '20° clockwise' });
    expect(turnInstruction(-20)).toMatchObject({ text: 'Turn it a little to the left', direction: 'left', exact: '20° counter-clockwise' });
    expect(turnInstruction(45).text).toBe('Turn it half a quarter to the right');
    expect(turnInstruction(84)).toMatchObject({ quarter: 90, text: 'Turn it a quarter to the right', exact: '84° clockwise' });
    expect(turnInstruction(275)).toMatchObject({ quarter: 270, text: 'Turn it a quarter to the left', exact: '85° counter-clockwise', degrees: -85 });
    expect(turnInstruction(-140).text).toBe('Turn it nearly halfway round to the left');
    expect(turnInstruction(180)).toMatchObject({ quarter: 180, band: 'half', text: 'Turn it upside down', exact: '180°', direction: undefined });
    expect(turnInstruction(200)).toMatchObject({ text: 'Turn it upside down', exact: '160° counter-clockwise', degrees: -160 });
  });

  it('makes compact words for lists', () => {
    expect(turnBadge(3)).toBe('');
    expect(turnBadge(25)).toBe('slight turn right');
    expect(turnBadge(-50)).toBe('⅛ turn left');
    expect(turnBadge(92)).toBe('¼ turn right');
    expect(turnBadge(268)).toBe('¼ turn left');
    expect(turnBadge(135)).toBe('⅜ turn right');
    expect(turnBadge(181)).toBe('upside down');
  });
});

describe('turn arc and top edge', () => {
  const c = { x: 50, y: 50 };
  it('runs from where the top edge points to straight up, clockwise for a right turn', () => {
    // A clockwise quarter: the top edge points left now (9 o'clock) and ends at 12 o'clock.
    const a = turnArc(90, c, 40);
    close(a.start.x, 10);
    close(a.start.y, 50);
    expect(a.end).toEqual({ x: 50, y: 10 });
    expect(a.d).toBe('M10 50A40 40 0 0 1 50 10');
    // The arrowhead points right (the way the top edge moves).
    expect(a.head[0].x).toBeGreaterThan(50);
  });
  it('turns the other way for a left turn and half round for upside down', () => {
    const l = turnArc(-90, c, 40);
    expect(l.d).toBe('M90 50A40 40 0 0 0 50 10');
    expect(l.head[0].x).toBeLessThan(50);
    const h = turnArc(180, c, 40);
    close(h.start.y, 90);
    expect(h.d.endsWith('0 0 1 50 10')).toBe(true);
  });
  it('puts the top bar across the edge that must end up on top', () => {
    // Needs a clockwise quarter: that edge is on the left now.
    const b = topEdgeBar(c, 90, 20, 8);
    close(b.from.x, 30);
    close(b.to.x, 30);
    close(Math.abs(b.from.y - b.to.y), 16);
    close(b.outward.x, -1);
  });
});
