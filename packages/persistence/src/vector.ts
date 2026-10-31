/* Retrieval vectors are stored as little-endian Float32 BLOBs: 4 bytes per
   dimension, read back without parsing. */

export function encodeVector(values: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1)
    view.setFloat32(index * 4, values[index]!, true);
  return bytes;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function decodeVector(bytes: Uint8Array): Float32Array {
  const length = Math.floor(bytes.byteLength / 4);
  if (LITTLE_ENDIAN) {
    // Float32Array needs a 4-byte aligned offset; copy when the driver's
    // buffer is not aligned.
    const source = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
    return new Float32Array(source.buffer, source.byteOffset, length);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(length);
  for (let index = 0; index < length; index += 1)
    values[index] = view.getFloat32(index * 4, true);
  return values;
}

/** Dot product; equals cosine similarity for unit vectors. */
export function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1)
    sum += left[index]! * right[index]!;
  return sum;
}
