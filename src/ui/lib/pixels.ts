import type { RGBAImage } from '../../cv/image';

/**
 * Opaque holder for large pixel buffers kept in React state or passed as props.
 *
 * React 19's development build logs changed props for its performance tracks and walks objects a
 * few levels deep – including every index of a typed array – which takes many seconds for a
 * multi-megapixel image. Private fields are invisible to that walk.
 */
export class Pixels {
  readonly #image: RGBAImage;

  constructor(image: RGBAImage) {
    this.#image = image;
  }

  get image(): RGBAImage {
    return this.#image;
  }

  get width(): number {
    return this.#image.width;
  }

  get height(): number {
    return this.#image.height;
  }
}
