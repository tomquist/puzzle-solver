/** Schematic piece outline: flat / tab / blank sides (sides in clockwise order top, right, bottom, left). */
import type { SideKind } from '../../model/types';

const S = 40; // body size
const O = 12; // offset (room for tabs)

function sidePath(kind: SideKind, ax: number, ay: number, bx: number, by: number): string {
  const dx = (bx - ax) / S;
  const dy = (by - ay) / S;
  const nx = dy; // outward normal (clockwise, y down)
  const ny = -dx;
  const pt = (t: number, off: number) => `${(ax + dx * t * S + nx * off).toFixed(1)} ${(ay + dy * t * S + ny * off).toFixed(1)}`;
  if (kind !== 'tab' && kind !== 'blank') return `L${pt(1, 0)}`;
  const h = kind === 'tab' ? 9 : -9;
  return `L${pt(0.36, 0)}C${pt(0.42, h * 0.2)} ${pt(0.28, h)} ${pt(0.5, h)}C${pt(0.72, h)} ${pt(0.58, h * 0.2)} ${pt(0.64, 0)}L${pt(1, 0)}`;
}

export function PieceIcon({ sides, rotationDeg = 0, size = 56, title }: { sides: SideKind[]; rotationDeg?: number; size?: number; title?: string }) {
  const c = [
    [O, O],
    [O + S, O],
    [O + S, O + S],
    [O, O + S],
  ];
  let d = `M${c[0][0]} ${c[0][1]}`;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    d += sidePath(sides[i] ?? 'unknown', a[0], a[1], b[0], b[1]);
  }
  d += 'Z';
  const flatEdges = sides
    .map((k, i) => (k === 'flat' ? i : -1))
    .filter((i) => i >= 0)
    .map((i) => {
      const a = c[i];
      const b = c[(i + 1) % 4];
      return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="piece-icon-flat" />;
    });
  return (
    <svg className="piece-icon" width={size} height={size} viewBox={`0 0 ${S + 2 * O} ${S + 2 * O}`} role="img" aria-label={title ?? 'Piece shape'}>
      <g transform={`rotate(${rotationDeg} ${O + S / 2} ${O + S / 2})`}>
        <path d={d} className="piece-icon-body" />
        {flatEdges}
      </g>
    </svg>
  );
}
