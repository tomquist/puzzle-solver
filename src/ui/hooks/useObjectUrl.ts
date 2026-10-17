import { useEffect, useState } from 'react';
import { createObjectUrl, revokeObjectUrl } from '../../platform/imageio';
import { useRepo } from '../context/RepositoryContext';

/** Object URL for a blob, revoked when the blob changes or the component unmounts. */
export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = createObjectUrl(blob);
    setUrl(u);
    return () => revokeObjectUrl(u);
  }, [blob]);
  return url;
}

/** Load a stored blob by id. */
export function useStoredBlob(blobId: string | undefined): { blob: Blob | undefined; missing: boolean } {
  const repo = useRepo();
  const [state, setState] = useState<{ id?: string; blob?: Blob; missing: boolean }>({ missing: false });
  useEffect(() => {
    let alive = true;
    if (!blobId) {
      setState({ missing: false });
      return;
    }
    repo.getBlob(blobId).then(
      (blob) => alive && setState({ id: blobId, blob, missing: !blob }),
      () => alive && setState({ id: blobId, missing: true }),
    );
    return () => {
      alive = false;
    };
  }, [repo, blobId]);
  return { blob: state.id === blobId ? state.blob : undefined, missing: state.missing };
}

/** Object URL of a stored blob. */
export function useStoredBlobUrl(blobId: string | undefined): string | undefined {
  return useObjectUrl(useStoredBlob(blobId).blob);
}

/** Decoded ImageBitmap of a blob (for canvas crops); closed on change/unmount. */
export function useBitmap(blob: Blob | undefined): ImageBitmap | undefined {
  const [bitmap, setBitmap] = useState<ImageBitmap>();
  useEffect(() => {
    if (!blob) {
      setBitmap(undefined);
      return;
    }
    let alive = true;
    let bmp: ImageBitmap | undefined;
    createImageBitmap(blob).then(
      (b) => {
        bmp = b;
        if (alive) setBitmap(b);
        else b.close();
      },
      () => alive && setBitmap(undefined),
    );
    return () => {
      alive = false;
      bmp?.close();
    };
  }, [blob]);
  return bitmap;
}
