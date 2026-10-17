/**
 * Camera + upload capture: live preview with a quality meter (pipeline.assessFrame every ~400 ms),
 * full-resolution shutter, torch, context tips, and file upload (gallery and native camera app)
 * that is always available as a fallback.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { FrameQuality } from '../../model/types';
import { CAMERA_ERROR_TEXT, cameraPermission, CameraError, isCameraSupported, openCamera, type CameraSession } from '../../platform/camera';
import { usePipeline } from '../context/PipelineContext';
import { Banner } from './Feedback';
import { IconCamera, IconClose, IconImage, IconInfo, IconTorch, IconUpload } from './Icons';

export type CaptureContext = 'box' | 'pieces' | 'closeup';

const TIPS: Record<CaptureContext, { title: string; tips: string[] }> = {
  box: {
    title: 'Photograph the box',
    tips: ['Fill the frame with the box picture', 'Avoid reflections – tilt the box away from lamps', 'Straight from the front is best, but angles are fine'],
  },
  pieces: {
    title: 'Photograph loose pieces',
    tips: ['Plain, contrasting background', 'Pieces must not touch', 'Shoot from directly above', '10–40 pieces per photo'],
  },
  closeup: {
    title: 'Close-up of the box picture',
    tips: ['Fill the frame with one part of the picture', 'Keep it sharp and free of glare', 'Overlap a little with other close-ups'],
  },
};

type CamState = { kind: 'off' } | { kind: 'starting' } | { kind: 'live'; session: CameraSession } | { kind: 'error'; message: string };

function useCoarsePointer(): boolean {
  const [coarse] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  return coarse;
}

export function CameraCapture({
  context,
  onCapture,
  disabled = false,
  autoStart = true,
  uploadLabel = 'Upload photo',
}: {
  context: CaptureContext;
  onCapture: (photo: Blob) => void;
  disabled?: boolean;
  /** Start the camera immediately when permission was already granted. */
  autoStart?: boolean;
  uploadLabel?: string;
}) {
  const pipeline = usePipeline();
  const video = useRef<HTMLVideoElement>(null);
  const [cam, setCam] = useState<CamState>({ kind: 'off' });
  const [quality, setQuality] = useState<FrameQuality>();
  const [torch, setTorch] = useState(false);
  const [showTips, setShowTips] = useState(true);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const coarse = useCoarsePointer();
  const tips = TIPS[context];
  const sessionRef = useRef<CameraSession | undefined>(undefined);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = undefined;
    setCam({ kind: 'off' });
    setQuality(undefined);
    setTorch(false);
  }, []);

  const start = useCallback(async () => {
    setCam({ kind: 'starting' });
    try {
      const session = await openCamera();
      sessionRef.current?.stop();
      sessionRef.current = session;
      setCam({ kind: 'live', session });
    } catch (e) {
      const message = e instanceof CameraError ? e.message : CAMERA_ERROR_TEXT.unknown;
      setCam({ kind: 'error', message });
    }
  }, []);

  // Stop the tracks when leaving the screen.
  useEffect(() => () => sessionRef.current?.stop(), []);

  // Auto-start only when the user already allowed the camera (never prompt unexpectedly).
  useEffect(() => {
    if (!autoStart || !isCameraSupported()) return;
    let alive = true;
    cameraPermission().then((state) => {
      if (alive && state === 'granted') void start();
    });
    return () => {
      alive = false;
    };
  }, [autoStart, start]);

  // Attach the stream to the <video>.
  useEffect(() => {
    const v = video.current;
    if (cam.kind !== 'live' || !v) return;
    v.srcObject = cam.session.stream;
    v.play().catch(() => undefined);
    return () => {
      v.srcObject = null;
    };
  }, [cam]);

  // Live quality meter.
  useEffect(() => {
    if (cam.kind !== 'live') return;
    let pending = false;
    let alive = true;
    const id = setInterval(() => {
      const v = video.current;
      if (pending || !v) return;
      const frame = cam.session.grabFrame(v, 320);
      if (!frame) return;
      pending = true;
      pipeline
        .assessFrame(frame)
        .then((q) => alive && setQuality(q))
        .catch(() => undefined)
        .finally(() => {
          pending = false;
        });
    }, 400);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cam, pipeline]);

  const shoot = async () => {
    const v = video.current;
    if (cam.kind !== 'live' || !v || busy) return;
    setBusy(true);
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    try {
      const blob = await cam.session.takePhoto(v);
      onCapture(blob);
    } catch (e) {
      setCam({ kind: 'error', message: e instanceof Error ? e.message : CAMERA_ERROR_TEXT.unknown });
    } finally {
      setBusy(false);
    }
  };

  const onFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    if (f.type && !f.type.startsWith('image/')) return;
    onCapture(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!disabled) onFiles(e.dataTransfer.files);
  };

  const uploadPrimary = cam.kind !== 'live' && (!isCameraSupported() || cam.kind === 'error');
  const uploadButtons = (
    <>
      <label className={`btn ${uploadPrimary ? 'btn-primary' : ''} btn-lg${disabled ? ' disabled' : ''}`}>
        <IconUpload />
        <span>{uploadLabel}</span>
        <input
          type="file"
          accept="image/*"
          className="visually-hidden"
          data-testid="photo-upload"
          disabled={disabled}
          onChange={(e) => {
            onFiles(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
      </label>
      <label className={`btn btn-lg${disabled ? ' disabled' : ''}${coarse ? '' : ' hide-fine'}`}>
        <IconImage />
        <span>Camera app</span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="visually-hidden"
          data-testid="photo-capture"
          disabled={disabled}
          onChange={(e) => {
            onFiles(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
      </label>
    </>
  );

  if (cam.kind === 'live') {
    const q = quality;
    const sharpPct = q ? Math.round(q.sharpness * 100) : 0;
    return (
      <div className="camera">
        <div className="camera-view">
          <video ref={video} playsInline muted autoPlay className="camera-video" />
          {flash && <div className="camera-flash" />}
          <div className={`camera-meter ${q ? (q.ok ? 'ok' : 'bad') : ''}`} aria-live="polite">
            <span className="meter-dot" />
            <span className="meter-text">{q ? (q.ok ? 'Looks good' : q.message ?? 'Adjust') : 'Checking…'}</span>
            {q && (
              <span className="meter-bars" aria-hidden="true">
                <span title="Sharpness" className="meter-bar">
                  <span style={{ width: `${sharpPct}%` }} />
                </span>
                <span title="Brightness" className="meter-bar">
                  <span style={{ width: `${Math.round(q.brightness * 100)}%` }} />
                </span>
              </span>
            )}
          </div>
          {showTips && (
            <div className="camera-tips">
              <strong>{tips.title}</strong>
              <ul>
                {tips.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <button className="btn btn-sm btn-on-dark" onClick={() => setShowTips(false)}>
                Got it
              </button>
            </div>
          )}
          <div className="camera-controls">
            <button className="icon-btn on-dark" onClick={stop} aria-label="Close camera">
              <IconClose />
            </button>
            <button className="shutter" onClick={shoot} disabled={disabled || busy} aria-label="Take photo">
              <span />
            </button>
            {cam.session.torchSupported ? (
              <button
                className={`icon-btn on-dark${torch ? ' active' : ''}`}
                onClick={async () => setTorch(await cam.session.setTorch(!torch))}
                aria-label={torch ? 'Torch off' : 'Torch on'}
                aria-pressed={torch}
              >
                <IconTorch />
              </button>
            ) : (
              <button className="icon-btn on-dark" onClick={() => setShowTips(!showTips)} aria-label="Tips">
                <IconInfo />
              </button>
            )}
          </div>
        </div>
        <div className="row center wrap gap">{uploadButtons}</div>
      </div>
    );
  }

  return (
    <div
      className={`capture-card${dragOver ? ' drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="capture-icon">
        <IconCamera size={30} />
      </div>
      <h2>{tips.title}</h2>
      <ul className="tips">
        {tips.tips.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {cam.kind === 'error' && <Banner tone="warning">{cam.message}</Banner>}
      <div className="row center wrap gap">
        {isCameraSupported() && (
          <button className="btn btn-primary btn-lg" onClick={start} disabled={disabled || cam.kind === 'starting'}>
            <IconCamera />
            <span>{cam.kind === 'starting' ? 'Starting camera…' : cam.kind === 'error' ? 'Try camera again' : 'Use camera'}</span>
          </button>
        )}
        {uploadButtons}
      </div>
      <p className="muted small hide-coarse">You can also drop a photo here.</p>
    </div>
  );
}
