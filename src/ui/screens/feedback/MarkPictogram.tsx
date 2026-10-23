/**
 * Schematic pictograms of the feedback mark kinds: grey puzzle-piece silhouettes with the outline
 * the problem is about, drawn in the mark's colour (--mk) – the way a marked region looks on the
 * photo. 'assembled' shows joined pieces with the blue outline the app gives them.
 */
import type { FeedbackMarkKind } from '../../../feedback/format';
import type { SideKind } from '../../../model/types';
import { piecePath, sidePath } from '../../components/PieceIcon';

export type PictogramKind = FeedbackMarkKind | 'assembled';

const PIECE: SideKind[] = ['tab', 'tab', 'blank', 'blank'];

function Piece({ x, y, size, sides = PIECE, turn = 0 }: { x: number; y: number; size: number; sides?: SideKind[]; turn?: number }) {
  const d = piecePath(sides, x, y, size);
  return <path className="pc" d={d} transform={turn ? `rotate(${turn} ${x + size / 2} ${y + size / 2})` : undefined} />;
}

function Content({ kind }: { kind: PictogramKind }) {
  switch (kind) {
    case 'missed':
      // A piece with no outline, and the mark on its middle.
      return (
        <>
          <Piece x={6.8} y={10.2} size={15} />
          <circle className="ring" cx={14.3} cy={17.7} r={5.4} />
          <circle className="dot" cx={14.3} cy={17.7} r={2.8} />
        </>
      );
    case 'not_a_piece':
      // An outline (of a shadow, say) with nothing inside.
      return <path className="ol" d="M7 10.5C9.5 6.5 14.5 7.8 18 6.5C22 5 26.5 8 26.5 12.5C26.5 16 24 17.5 25 20.5C26.2 24.5 21.5 27.2 17.5 25.5C14 24 11.5 26.5 8.3 24.5C4.8 22.3 6.8 18.2 5.6 15.2C4.9 13.3 5.8 12.2 7 10.5Z" />;
    case 'merged':
      // Two loose pieces inside one outline.
      return (
        <>
          <rect className="ol" x={1.5} y={3.5} width={29} height={25} rx={7} />
          <Piece x={4.6} y={9} size={9.5} turn={-12} />
          <Piece x={16.8} y={14.2} size={9.5} sides={['blank', 'tab', 'tab', 'blank']} turn={8} />
        </>
      );
    case 'bad_outline':
      // One piece; the outline cuts its tabs off and takes in table below it.
      return (
        <>
          <Piece x={6.8} y={10.2} size={15} />
          <path className="ol" d="M4 12.5L20.5 9.8L21.6 28L3.6 28.6Z" />
        </>
      );
    case 'wrong_place':
      // A piece and the arrow to its right spot.
      return (
        <>
          <Piece x={3} y={16.5} size={11} />
          <rect className="spot" x={19} y={4} width={10} height={10} rx={1.5} />
          <path className="arrow" d="M9.5 12.5C10.5 6.8 13.8 6 16.8 8.3M14.3 5.9L17.2 8.6L14 10.4" />
        </>
      );
    case 'wrong_fit':
      // Two pieces whose tabs face each other – they can't join – and a cross between them.
      return (
        <>
          <Piece x={1} y={14} size={12.5} />
          <Piece x={18.5} y={14} size={12.5} sides={['blank', 'blank', 'tab', 'tab']} />
          <path className="arrow" d="M12.5 2.5L19.5 9.5M19.5 2.5L12.5 9.5" />
        </>
      );
    case 'assembled':
      // Two joined pieces (the left one's tab in the right one's blank): one outline around both is right.
      return (
        <>
          <path className="pc" d={JOINED} />
          <path className="ol" d={JOINED} />
          <path className="seam" d={`M16 10.5${sidePath('tab', 16, 10.5, 16, 22.5)}`} />
        </>
      );
  }
}

const JOINED = `M4 10.5${sidePath('tab', 4, 10.5, 16, 10.5)}${sidePath('blank', 16, 10.5, 28, 10.5)}${sidePath('flat', 28, 10.5, 28, 22.5)}${sidePath('tab', 28, 22.5, 16, 22.5)}${sidePath('blank', 16, 22.5, 4, 22.5)}Z`;

export function MarkPictogram({ kind, size = 32 }: { kind: PictogramKind; size?: number }) {
  return (
    <svg className={`fb-picto ${kind === 'assembled' ? 'st-patch' : `mk-${kind}`}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <Content kind={kind} />
    </svg>
  );
}
