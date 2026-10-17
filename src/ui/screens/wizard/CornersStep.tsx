/** Step 2: adjust the detected picture outline. */
import type { Quad } from '../../../cv/geometry';
import type { BoxDetection } from '../../../model/types';
import { CornerEditor, isConvexQuad } from '../../components/CornerEditor';
import { Banner } from '../../components/Feedback';
import { IconImage, IconRefresh, IconWand } from '../../components/Icons';
import { QualityBanner } from '../../components/Quality';
import { candidateLabel, needsCornerCheck } from '../../lib/boxLabels';
import type { EncodedImage } from './types';

export function CornersStep({
  photo,
  source,
  detection,
  quad,
  candidateIndex,
  onQuad,
  onCandidate,
  onNext,
}: {
  photo: EncodedImage;
  source?: CanvasImageSource;
  detection: BoxDetection;
  quad: Quad;
  candidateIndex: number;
  onQuad: (q: Quad) => void;
  onCandidate: (index: number) => void;
  onNext: () => void;
}) {
  const n = detection.candidates.length;
  const next = n > 0 ? (candidateIndex + 1) % n : 0;
  const convex = isConvexQuad(quad);
  const whole: Quad = [
    { x: 0, y: 0 },
    { x: photo.width - 1, y: 0 },
    { x: photo.width - 1, y: photo.height - 1 },
    { x: 0, y: photo.height - 1 },
  ];
  return (
    <div className="stack">
      <p className="lead">Drag the four corners onto the corners of the puzzle picture.</p>
      {needsCornerCheck(detection.confidence, detection.quality.issues.map((i) => i.code)) && (
        <Banner tone="warning" title="Please check the corners">
          {detection.quality.issues.some((i) => i.code === 'cut_off')
            ? 'Part of the picture may be cut off by the photo edge. Make sure all four corners sit on the picture’s corners, or retake the photo with some space around the box.'
            : 'The picture edges were hard to find. Drag the corners onto the picture, or try the other suggestions.'}
        </Banner>
      )}
      <QualityBanner report={detection.quality} subject="box photo" hideWhenClean />
      <CornerEditor src={photo.url} source={source} width={photo.width} height={photo.height} quad={quad} onChange={onQuad} />
      <div className="toolbar wrap">
        <button className="btn btn-sm" onClick={() => onCandidate(0)}>
          <IconWand size={16} />
          Auto-detect
        </button>
        {n > 1 && (
          <button className="btn btn-sm" onClick={() => onCandidate(next)}>
            <IconRefresh size={16} />
            Next: {candidateLabel(detection.candidates[next].label)}
          </button>
        )}
        <button className="btn btn-sm" onClick={() => onQuad(whole)}>
          <IconImage size={16} />
          Use whole photo
        </button>
      </div>
      {!convex && <Banner tone="error">The corners cross over. Drag them so they form the outline of the picture.</Banner>}
      <div className="wizard-actions">
        <button className="btn btn-primary btn-lg grow" onClick={onNext} disabled={!convex}>
          Continue
        </button>
      </div>
    </div>
  );
}
