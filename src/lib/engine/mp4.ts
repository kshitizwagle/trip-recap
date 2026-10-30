// Minimal fast-start MP4 writer for one H.264 track (WebCodecs `avc` output).
// Layout: ftyp, moov (with the sample tables), then mdat.

export interface VideoSample {
  /** Length-prefixed NAL units, as EncodedVideoChunk produces with `avc: {format: "avc"}`. */
  data: Uint8Array;
  isKey: boolean;
  /** Duration in track timescale ticks. */
  duration: number;
}

export interface Mp4TrackConfig {
  width: number;
  height: number;
  /** Track timescale (ticks per second), e.g. 90000. */
  timescale: number;
  /** AVCDecoderConfigurationRecord (`decoderConfig.description`). */
  avcC: Uint8Array;
}

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;

  bytes(data: Uint8Array | number[]) {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.chunks.push(chunk);
    this.length += chunk.length;
    return this;
  }
  u8(value: number) { return this.bytes([value & 0xff]); }
  u16(value: number) { return this.bytes([(value >> 8) & 0xff, value & 0xff]); }
  u32(value: number) {
    return this.bytes([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }
  ascii(text: string) { return this.bytes(Array.from(text, (char) => char.charCodeAt(0))); }
  zeros(count: number) { return this.bytes(new Uint8Array(count)); }
  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((sum, part) => sum + part.length, 0);
  const writer = new Writer().u32(size).ascii(type);
  payload.forEach((part) => writer.bytes(part));
  return writer.finish();
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  const header = new Writer().u8(version).u8(flags >> 16).u8(flags >> 8).u8(flags).finish();
  return box(type, header, ...payload);
}

const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
function matrix(): Uint8Array {
  const writer = new Writer();
  IDENTITY_MATRIX.forEach((value) => writer.u32(value));
  return writer.finish();
}

const MOVIE_TIMESCALE = 1000;

function sampleTables(config: Mp4TrackConfig, samples: VideoSample[], chunkOffset: number): Uint8Array {
  const avc1 = box(
    "avc1",
    new Writer()
      .zeros(6).u16(1) // reserved, data_reference_index
      .zeros(16) // pre_defined + reserved
      .u16(config.width).u16(config.height)
      .u32(0x00480000).u32(0x00480000) // 72 dpi
      .zeros(4).u16(1) // reserved, frame_count
      .zeros(32) // compressorname
      .u16(0x0018).u16(0xffff) // depth, pre_defined = -1
      .finish(),
    box("avcC", config.avcC),
  );
  const stsd = fullBox("stsd", 0, 0, new Writer().u32(1).finish(), avc1);

  const runs: Array<[number, number]> = [];
  for (const sample of samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === sample.duration) last[0] += 1;
    else runs.push([1, sample.duration]);
  }
  const stts = new Writer().u32(runs.length);
  runs.forEach(([count, delta]) => stts.u32(count).u32(delta));

  const keys = samples.map((sample, index) => (sample.isKey ? index + 1 : 0)).filter(Boolean);
  const stss = new Writer().u32(keys.length);
  keys.forEach((key) => stss.u32(key));

  const stsz = new Writer().u32(0).u32(samples.length);
  samples.forEach((sample) => stsz.u32(sample.data.length));

  return box(
    "stbl",
    stsd,
    fullBox("stts", 0, 0, stts.finish()),
    fullBox("stss", 0, 0, stss.finish()),
    fullBox("stsc", 0, 0, new Writer().u32(1).u32(1).u32(samples.length).u32(1).finish()),
    fullBox("stsz", 0, 0, stsz.finish()),
    fullBox("stco", 0, 0, new Writer().u32(1).u32(chunkOffset).finish()),
  );
}

function moov(config: Mp4TrackConfig, samples: VideoSample[], chunkOffset: number): Uint8Array {
  const trackTicks = samples.reduce((sum, sample) => sum + sample.duration, 0);
  const movieDuration = Math.round((trackTicks / config.timescale) * MOVIE_TIMESCALE);
  const mvhd = fullBox(
    "mvhd", 0, 0,
    new Writer()
      .u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(movieDuration)
      .u32(0x00010000).u16(0x0100).zeros(10)
      .bytes(matrix()).zeros(24).u32(2)
      .finish(),
  );
  const tkhd = fullBox(
    "tkhd", 0, 0x000003,
    new Writer()
      .u32(0).u32(0).u32(1).u32(0).u32(movieDuration)
      .zeros(8).u16(0).u16(0).u16(0).u16(0)
      .bytes(matrix()).u32(config.width * 65536).u32(config.height * 65536)
      .finish(),
  );
  const mdhd = fullBox("mdhd", 0, 0, new Writer().u32(0).u32(0).u32(config.timescale).u32(trackTicks).u16(0x55c4).u16(0).finish());
  const hdlr = fullBox("hdlr", 0, 0, new Writer().u32(0).ascii("vide").zeros(12).ascii("VideoHandler").u8(0).finish());
  const vmhd = fullBox("vmhd", 0, 1, new Writer().zeros(8).finish());
  const dinf = box("dinf", fullBox("dref", 0, 0, new Writer().u32(1).finish(), fullBox("url ", 0, 1)));
  const minf = box("minf", vmhd, dinf, sampleTables(config, samples, chunkOffset));
  return box("moov", mvhd, box("trak", tkhd, box("mdia", mdhd, hdlr, minf)));
}

/** Builds a complete, fast-start MP4 file. */
export function buildMp4File(config: Mp4TrackConfig, samples: VideoSample[]): Uint8Array {
  if (!samples.length) throw new Error("No video frames were encoded");
  if (!samples[0].isKey) throw new Error("The first video frame must be a key frame");
  const ftyp = box("ftyp", new Writer().ascii("isom").u32(512).ascii("isomiso2avc1mp41").finish());
  // moov size does not depend on the offset value, so measure once and rebuild with the real offset.
  const moovSize = moov(config, samples, 0).length;
  const mdatSize = 8 + samples.reduce((sum, sample) => sum + sample.data.length, 0);
  const chunkOffset = ftyp.length + moovSize + 8;
  const writer = new Writer().bytes(ftyp).bytes(moov(config, samples, chunkOffset)).u32(mdatSize).ascii("mdat");
  samples.forEach((sample) => writer.bytes(sample.data));
  return writer.finish();
}
