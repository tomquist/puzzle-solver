/**
 * Camera + upload capture: live preview with a quality meter (pipeline.assessFrame every ~400 ms,
 * never more than one request in flight), full-resolution shutter, torch, context tips, and file
 * input (photo library and the native camera app) that is always available.
 *
 * On iOS the native camera (`<input capture>`) is the primary action: Safari's getUserMedia stills
 * are much lower resolution than the Camera app's photos.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { FrameQuality } from '../../model/types';
import { CAMERA_ERROR_TEXT, cameraPermission, CameraError, isCameraSupported, openCamera, type CameraSession } from '../../platform/camera';
import { haptic, isCoarsePointer, isIOS } from '../../platform/device';
import { usePipeline } from '../context/PipelineContext';
import { usePrefs } from '../hooks/usePrefs';
import { startFrameLoop } from '../lib/frameLoop';
import { setDismissed } from '../lib/prefs';
import { Banner } from './Feedback';
import { IconCamera, IconCheck, IconClose, IconImage, IconInfo, IconTorch, IconUpload } from './Icons';

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

function usePlatform(): { ios: boolean; coarse: boolean } {
  const [p] = useState(() => ({ ios: isIOS(), coarse: isCoarsePointer() }));
  return p;
}

function FileButton({
  label,
  icon,
  primary,
  capture,
  disabled,
  testId,
  onFiles,
  className = '',
}: {
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
  capture?: boolean;
  disabled?: boolean;
  testId: string;
  onFiles: (files: FileList | null) => void;
  className?: string;
}) {
  return (
    <label className={`btn btn-lg${primary ? ' btn-primary' : ''}${disabled ? ' disabled' : ''} ${className}`}>
      {icon}
      <span>{label}</span>
      <input
        type="file"
        accept="image/*"
        capture={capture ? 'environment' : undefined}
        className="visually-hidden"
        data-testid={testId}
        disabled={disabled}
        onChange={(e) => {
          onFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
    </label>
  );
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
  /** Start the camera immediately when permission was already granted (not on iOS). */
  autoStart?: boolean;
  uploadLabel?: string;
}) {
  const pipeline = usePipeline();
  const video = useRef<HTMLVideoElement>(null);
  const [cam, setCam] = useState<CamState>({ kind: 'off' });
  const [quality, setQuality] = useState<FrameQuality>();
  const [torch, setTorch] = useState(false);
  const [prefs, updatePrefs] = usePrefs();
  const tipsKey = `camera-tips:${context}`;
  const [showTips, setShowTips] = useState(() => !prefs.dismissed.includes(tipsKey));
  const [hideTipsForGood, setHideTipsForGood] = useState(() => prefs.dismissed.includes(tipsKey));
  const closeTips = () => {
    updatePrefs((p) => setDismissed(p, tipsKey, hideTipsForGood));
    setShowTips(false);
  };
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const { ios, coarse } = usePlatform();
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

  // Auto-start only when the user already allowed the camera (never prompt unexpectedly), and not
  // on iOS where the native camera gives better photos.
  useEffect(() => {
    if (!autoStart || ios || !isCameraSupported()) return;
    let alive = true;
    cameraPermission().then((state) => {
      if (alive && state === 'granted') void start();
    });
    return () => {
      alive = false;
    };
  }, [autoStart, ios, start]);

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

  // Live quality meter (skips frames while an assessment is still running).
  useEffect(() => {
    if (cam.kind !== 'live') return;
    const loop = startFrameLoop({
      grab: () => (video.current ? cam.session.grabFrame(video.current, 320) : null),
      assess: (frame) => pipeline.assessFrame(frame),
      onResult: setQuality,
      intervalMs: 400,
    });
    return () => loop.stop();
  }, [cam, pipeline]);

  const shoot = async () => {
    const v = video.current;
    if (cam.kind !== 'live' || !v || busy) return;
    setBusy(true);
    setFlash(true);
    haptic();
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

  const cameraSupported = isCameraSupported();
  // Native camera app: primary on iOS, offered on other touch devices, hidden on desktop.
  const nativeCamera = (primary: boolean) => (
    <FileButton
      label={ios && cam.kind !== 'live' ? 'Take photo' : 'Camera app'}
      icon={ios ? <IconCamera /> : <IconImage />}
      primary={primary}
      capture
      disabled={disabled}
      testId="photo-capture"
      onFiles={onFiles}
      className={ios || coarse ? '' : 'hide-fine'}
    />
  );
  const uploadPrimary = !ios && (!cameraSupported || cam.kind === 'error');
  const upload = (
    <FileButton
      label={ios ? 'Choose from library' : uploadLabel}
      icon={<IconUpload />}
      primary={uploadPrimary && cam.kind !== 'live'}
      disabled={disabled}
      testId="photo-upload"
      onFiles={onFiles}
    />
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
              {ios && <span className="small">For the sharpest photo use “Take photo” below.</span>}
              <div className="camera-tips-actions">
                <label className="camera-tips-check">
                  <input type="checkbox" checked={hideTipsForGood} onChange={(e) => setHideTipsForGood(e.currentTarget.checked)} data-testid="tips-dont-show" />
                  Don’t show again
                </label>
                <button className="btn btn-sm btn-on-dark" onClick={closeTips}>
                  Got it
                </button>
              </div>
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
        <div className="capture-actions">
          {upload}
          {nativeCamera(false)}
        </div>
      </div>
    );
  }

  const liveButton = cameraSupported && (
    <button className={`btn btn-lg${ios ? '' : ' btn-primary'}`} onClick={start} disabled={disabled || cam.kind === 'starting'}>
      <IconCamera />
      <span>{cam.kind === 'starting' ? 'Starting camera…' : cam.kind === 'error' ? 'Try camera again' : ios ? 'Live camera' : 'Use camera'}</span>
    </button>
  );

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
          <li key={t}>
            <IconCheck size={16} />
            <span>{t}</span>
          </li>
        ))}
      </ul>
      {cam.kind === 'error' && <Banner tone="warning">{cam.message}</Banner>}
      <div className="capture-actions">
        {ios ? (
          <>
            {nativeCamera(true)}
            {upload}
            {liveButton}
          </>
        ) : (
          <>
            {liveButton}
            {upload}
            {nativeCamera(false)}
          </>
        )}
      </div>
      <p className="muted small hide-coarse">You can also drop a photo here.</p>
    </div>
  );
}
