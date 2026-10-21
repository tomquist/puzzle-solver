/** Persist a finished wizard: photos, reference, thumbnail and the PuzzleRecord. */
import { mat3Multiply, scaling } from '../../../cv/geometry';
import type { PuzzleRecord, SourcePhoto } from '../../../model/types';
import { makeThumbnail, rgbaToBlob } from '../../../platform/imageio';
import { newGridState } from '../../../pipeline/gridBelief';
import { newId, type PuzzleRepository } from '../../../storage/types';
import type { WizardResult } from './types';

export async function saveNewPuzzle(repo: PuzzleRepository, r: WizardResult, onStep: (message: string, fraction: number) => void): Promise<PuzzleRecord> {
  const created: string[] = [];
  const put = async (blob: Blob) => {
    const id = await repo.putBlob(blob);
    created.push(id);
    return id;
  };
  try {
    onStep('Saving the box photo…', 0.1);
    const sources: SourcePhoto[] = [
      { blobId: await put(r.photo.blob), width: r.photo.width, height: r.photo.height, role: 'overview', quad: r.quad },
    ];
    const used = r.closeups.filter((c) => c.status === 'ok' && c.pixels && c.registration);
    for (let i = 0; i < used.length; i++) {
      const c = used[i];
      onStep(`Saving close-up ${i + 1} of ${used.length}…`, 0.2 + (0.3 * i) / used.length);
      const img = c.pixels!.image;
      const blob = await rgbaToBlob(img, 'image/jpeg', 0.92);
      sources.push({
        blobId: await put(blob),
        width: img.width,
        height: img.height,
        role: 'closeup',
        toReference: mat3Multiply(scaling(r.referenceScale), c.registration!.toReference),
      });
    }
    onStep('Saving the reference picture…', 0.6);
    const referenceBlobId = await put(r.reference.blob);
    onStep('Making a thumbnail…', 0.8);
    const thumbnailBlobId = await put(await makeThumbnail(r.reference.pixels.image, 320));
    const now = Date.now();
    const puzzle: PuzzleRecord = {
      id: newId(),
      name: r.details.name,
      createdAt: now,
      updatedAt: now,
      pieceCount: r.details.pieceCount,
      pieceCountKind: r.details.pieceCountKind,
      physicalSize: r.details.physicalSize,
      grid: r.details.grid,
      gridState: newGridState(r.details.gridStatus),
      cut: r.details.cut,
      reference: { blobId: referenceBlobId, width: r.reference.width, height: r.reference.height },
      thumbnailBlobId,
      sources,
    };
    onStep('Saving the puzzle…', 0.95);
    await repo.savePuzzle(puzzle);
    onStep('Done', 1);
    return puzzle;
  } catch (e) {
    // Don't leave orphaned blobs behind.
    await Promise.all(created.map((id) => repo.deleteBlob(id).catch(() => undefined)));
    throw e;
  }
}
