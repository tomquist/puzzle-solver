import type { Quad } from '../../../cv/geometry';
import type { RGBAImage } from '../../../cv/image';
import type { CloseupRegistration, CutStyle, GridSpec, PhysicalSize } from '../../../model/types';
import { createObjectUrl, revokeObjectUrl, rgbaToBlob } from '../../../platform/imageio';

/** An image held in memory both as pixels (for the pipeline) and as a JPEG (for display/storage). */
export interface EncodedImage {
  rgba: RGBAImage;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

export async function encodeImage(rgba: RGBAImage, quality = 0.92): Promise<EncodedImage> {
  const blob = await rgbaToBlob(rgba, 'image/jpeg', quality);
  return { rgba, blob, url: createObjectUrl(blob), width: rgba.width, height: rgba.height };
}

export function releaseImage(img: EncodedImage | undefined): void {
  revokeObjectUrl(img?.url);
}

export interface Closeup {
  id: string;
  /** Preview URL of the original file. */
  previewUrl: string;
  status: 'reading' | 'registering' | 'ok' | 'failed';
  rgba?: RGBAImage;
  registration?: CloseupRegistration;
  error?: string;
}

export interface PuzzleDetails {
  name: string;
  pieceCount: number;
  physicalSize?: PhysicalSize;
  grid: GridSpec;
  cut: CutStyle;
}

export interface WizardResult {
  details: PuzzleDetails;
  photo: EncodedImage;
  quad: Quad;
  reference: EncodedImage;
  /** Scale of `reference` relative to the rectified base (close-up registrations refer to the base). */
  referenceScale: number;
  closeups: Closeup[];
}
