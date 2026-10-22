/**
 * Camera access: rear camera at high resolution, stills sized for their purpose, torch, cleanup.
 * Browser-only. All failures surface as {@link CameraError} with a user-presentable kind.
 */
import type { RGBAImage } from '../cv/image';
import type { CaptureInfo } from '../model/types';
import { canvasToBlob, context2d, createCanvas, sourceToRGBA } from './imageio';
import { photoSettingsFor, type PhotoCapabilitiesLike, type PhotoPurpose, type PhotoSize } from './photoSettings';

export type CameraErrorKind = 'unsupported' | 'insecure' | 'denied' | 'not_found' | 'in_use' | 'unknown';

export class CameraError extends Error {
  readonly kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.name = 'CameraError';
    this.kind = kind;
  }
}

export const CAMERA_ERROR_TEXT: Record<CameraErrorKind, string> = {
  unsupported: 'This browser cannot use the camera. Upload a photo instead.',
  insecure: 'The camera only works over HTTPS. Upload a photo instead.',
  denied: 'Camera access was blocked. Allow it in the browser’s site settings, or upload a photo.',
  not_found: 'No camera was found on this device. Upload a photo instead.',
  in_use: 'The camera is busy in another app. Close it and try again, or upload a photo.',
  unknown: 'The camera could not be started. Upload a photo instead.',
};

// Parts of the Image Capture / torch APIs that TypeScript's DOM lib does not describe.
interface ImageCaptureLike {
  takePhoto(settings?: Partial<PhotoSize>): Promise<Blob>;
  getPhotoCapabilities?(): Promise<PhotoCapabilitiesLike>;
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;
interface TorchCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
}

function imageCaptureCtor(): ImageCaptureCtor | undefined {
  const g = globalThis as unknown as { ImageCapture?: ImageCaptureCtor };
  return g.ImageCapture;
}

export function isCameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export type PermissionStateLike = 'granted' | 'denied' | 'prompt' | 'unknown';

/** Current camera permission without prompting (where the Permissions API knows it). */
export async function cameraPermission(): Promise<PermissionStateLike> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

function toCameraError(e: unknown): CameraError {
  if (e instanceof CameraError) return e;
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('denied', CAMERA_ERROR_TEXT.denied);
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('not_found', CAMERA_ERROR_TEXT.not_found);
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('in_use', CAMERA_ERROR_TEXT.in_use);
    default:
      return new CameraError('unknown', CAMERA_ERROR_TEXT.unknown);
  }
}

/** A still and how it was taken (ScanRecord.capture; the size is filled in when it is decoded). */
export interface CapturedPhoto {
  blob: Blob;
  capture: CaptureInfo;
}

/** Short name of an error for the capture record ("NotSupportedError"). */
function errorName(e: unknown): string {
  const name = e instanceof Error || e instanceof DOMException ? e.name || e.message : String(e);
  return name.slice(0, 60);
}

export interface CameraSession {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  readonly torchSupported: boolean;
  /** Turn the torch on/off. Resolves to the new state (false when not supported). */
  setTorch(on: boolean): Promise<boolean>;
  /**
   * A still for `purpose` (ImageCapture.takePhoto at the size photoSettingsFor picks, when
   * available; else – or when it fails – the current video frame, which the capture info says).
   */
  takePhoto(video: HTMLVideoElement, purpose?: PhotoPurpose): Promise<CapturedPhoto>;
  /** Small RGBA copy of the current video frame for live quality feedback, or null if not ready. */
  grabFrame(video: HTMLVideoElement, maxSide?: number): RGBAImage | null;
  stop(): void;
}

/** Open the rear ("environment") camera at the highest practical resolution. */
export async function openCamera(): Promise<CameraSession> {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    throw new CameraError('insecure', CAMERA_ERROR_TEXT.insecure);
  }
  if (!isCameraSupported()) throw new CameraError('unsupported', CAMERA_ERROR_TEXT.unsupported);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 4096 },
        height: { ideal: 3072 },
      },
    });
  } catch (e) {
    throw toCameraError(e);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CameraError('not_found', CAMERA_ERROR_TEXT.not_found);
  }
  let torchSupported = false;
  try {
    const caps = track.getCapabilities?.() as TorchCapabilities | undefined;
    torchSupported = !!caps?.torch;
  } catch {
    torchSupported = false;
  }
  const Capture = imageCaptureCtor();
  const capture = Capture ? safeCreate(() => new Capture(track)) : undefined;

  let stopped = false;
  return {
    stream,
    track,
    torchSupported,
    async setTorch(on: boolean) {
      if (!torchSupported) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
        return on;
      } catch {
        return false;
      }
    },
    async takePhoto(video: HTMLVideoElement, purpose: PhotoPurpose = 'box') {
      let fallbackReason: string | undefined;
      if (capture) {
        try {
          const caps = (await capture.getPhotoCapabilities?.()) as PhotoCapabilitiesLike | undefined;
          const settings = photoSettingsFor(caps, purpose);
          const requested = settings ? { width: settings.imageWidth, height: settings.imageHeight } : undefined;
          try {
            const blob = await capture.takePhoto(settings);
            return { blob, capture: { method: 'takePhoto', ...(requested ? { requested } : {}) } };
          } catch (e) {
            if (!settings) throw e;
            // A size the camera refuses: its default still is still a still.
            const blob = await capture.takePhoto();
            return { blob, capture: { method: 'takePhoto', requested, fallbackReason: `size refused: ${errorName(e)}` } };
          }
        } catch (e) {
          // Fall through to the video-frame path (some devices reject takePhoto while streaming) –
          // recorded with the scan, so lower-resolution photos can be told apart.
          fallbackReason = errorName(e);
        }
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) throw new CameraError('unknown', 'The camera is not ready yet.');
      const canvas = createCanvas(w, h);
      context2d(canvas).drawImage(video, 0, 0, w, h);
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.95);
      const info: CaptureInfo = { method: 'video-frame', width: w, height: h };
      if (capture) Object.assign(info, { fallback: true, fallbackReason });
      return { blob, capture: info };
    },
    grabFrame(video: HTMLVideoElement, maxSide = 320) {
      if (stopped || video.readyState < 2 || !video.videoWidth) return null;
      return sourceToRGBA(video, video.videoWidth, video.videoHeight, maxSide);
    },
    stop() {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

function safeCreate<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
