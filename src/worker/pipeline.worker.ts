/// <reference lib="webworker" />
/**
 * Web Worker entry: exposes the real pipeline to the main thread via Comlink. Returned images are
 * transferred (not copied) back to the caller.
 */
import * as Comlink from 'comlink';
import type { RGBAImage } from '../cv/image';
import type { PipelineApi } from './api';
import { createLocalPipeline } from './localPipeline';

const local = createLocalPipeline();

function transferImage(img: RGBAImage): RGBAImage {
  return Comlink.transfer(img, [img.data.buffer]);
}

const api: PipelineApi = {
  ...local,
  async rectify(photo, quad, width, height) {
    return transferImage(await local.rectify(photo, quad, width, height));
  },
  async composeHighRes(reference, closeups, options) {
    return transferImage(await local.composeHighRes(reference, closeups, options));
  },
  async analyzeScan(puzzleId, photo, options, onProgress) {
    const res = await local.analyzeScan(puzzleId, photo, options, onProgress);
    return Comlink.transfer(res, [res.analysedImage.data.buffer]);
  },
};

Comlink.expose(api);
