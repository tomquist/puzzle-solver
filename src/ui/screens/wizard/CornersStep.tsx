/** Step 2: adjust the detected picture outline. */
import type { Quad } from '../../../cv/geometry';
import type { BoxDetection } from '../../../model/types';
import { CornerEditor, isConvexQuad } from '../../components/CornerEditor';
import { Banner } from '../../components/Feedback';
import { IconImage, IconRefresh, IconWand } from '../../components/Icons';
import { QualityBanner } from '../../components/Quality';
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
      {detection.confidence < 0.5 && (
        <Banner tone="warning" title="The picture edges were hard to find">
          Please check the corners – you can also try the other suggestions.
        </Banner>
      )}
      <QualityBanner report={detection.quality} subject="box photo" hideWhenClean />
      <CornerEditor src={photo.url} source={source} width={photo.width} height={photo.height} quad={quad} onChange={onQuad} />
      <div className="toolbar wrap">
        <button className="btn" onClick={() => onCandidate(0)}>
          <IconWand size={18} />
          Auto-detect
        </button>
        {n > 1 && (
          <button className="btn" onClick={() => onCandidate(next)}>
            <IconRefresh size={18} />
            Next: {detection.candidates[next].label}
          </button>
        )}
        <button className="btn" onClick={() => onQuad(whole)}>
          <IconImage size={18} />
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
