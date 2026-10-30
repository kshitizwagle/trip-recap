/** Random-access reads over a Blob/File without loading the whole file. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset: number, length: number) {
      const start = Math.max(0, Math.min(offset, blob.size));
      const end = Math.max(start, Math.min(offset + length, blob.size));
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset: number, length: number) {
      return bytes.subarray(Math.max(0, offset), Math.min(bytes.length, offset + length));
    },
  };
}

export function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

export function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/\0+$/, "");
}
