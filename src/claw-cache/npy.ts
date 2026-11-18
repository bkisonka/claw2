/**
 * Minimal NumPy .npy (v1.0) reader/writer for float32 C-order.
 * Needed for activation/vector.npy without dependency on numpy.
 */

export type NpyFloat32 = {
  data: Float32Array;
  shape: number[];
};

function product(shape: number[]): number {
  return shape.reduce((a, b) => a * b, 1);
}

/** Writes .npy float32 little-endian, fortran_order=False.*/
export function writeNpyFloat32(data: ArrayLike<number>, shape: number[]): Buffer {
  if (!shape.length) throw new Error("npy: shape required");
  for (const d of shape) {
    if (!Number.isInteger(d) || d < 0) throw new Error(`npy: invalid shape dim ${d}`);
  }
  const n = product(shape);
  if (data.length !== n) {
    throw new Error(`npy: data length ${data.length} != shape product ${n}`);
  }

  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
  const headerDict = `{'descr': '<f4', 'fortran_order': False, 'shape': ${shapeStr}, }`;
  // header: magic(6) + ver(2) + header_len(2) + header + pad to 16-byte alignment
  const prefixLen = 10; // magic+ver+hlen
  let header = headerDict;
  // pad with spaces, end with \n; total (prefixLen + header.length) % 16 === 0
  let pad = 16 - ((prefixLen + header.length + 1) % 16);
  if (pad === 16) pad = 0;
  header = header + " ".repeat(pad) + "\n";
  const headerLen = header.length;
  if (headerLen > 65535) throw new Error("npy: header too long");

  const body = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) body.writeFloatLE(Number(data[i]) || 0, i * 4);

  const out = Buffer.alloc(prefixLen + headerLen + body.length);
  out[0] = 0x93;
  out.write("NUMPY", 1, 5, "ascii");
  out[6] = 1; // major
  out[7] = 0; // minor
  out.writeUInt16LE(headerLen, 8);
  out.write(header, 10, headerLen, "ascii");
  body.copy(out, prefixLen + headerLen);
  return out;
}

/** Reads .npy float32 (little-endian). Empty buffer → shape [0].*/
export function readNpyFloat32(buf: Buffer): NpyFloat32 {
  if (!buf?.length) return { data: new Float32Array(0), shape: [0] };
  if (buf.length < 10 || buf[0] !== 0x93 || buf.toString("ascii", 1, 6) !== "NUMPY") {
    throw new Error("npy: invalid magic");
  }
  const major = buf[6];
  const minor = buf[7];
  let headerLen: number;
  let dataOffset: number;
  if (major === 1) {
    headerLen = buf.readUInt16LE(8);
    dataOffset = 10 + headerLen;
  } else if (major === 2) {
    headerLen = buf.readUInt32LE(8);
    dataOffset = 12 + headerLen;
  } else {
    throw new Error(`npy: unsupported version ${major}.${minor}`);
  }
  const header = buf.toString("ascii", major === 1 ? 10 : 12, dataOffset);
  if (!header.includes("'descr': '<f4'") && !header.includes("'descr': \"<f4\"")) {
    // allow descr without spaces variants
    if (!/['"]descr['"]\s*:\s*['"]<f4['"]/.test(header)) {
      throw new Error(`npy: only float32 little-endian supported, header=${header.trim()}`);
    }
  }
  if (/fortran_order'\s*:\s*True/.test(header) || /fortran_order":\s*True/.test(header)) {
    throw new Error("npy: fortran_order=True not supported");
  }
  const shapeMatch = header.match(/'shape'\s*:\s*(\([^)]*\))/);
  if (!shapeMatch) throw new Error("npy: shape not found");
  const shapeInner = shapeMatch[1].replace(/[()]/g, "").trim();
  const shape =
    shapeInner === ""
      ? []
      : shapeInner
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number(s));
  if (!shape.length) return { data: new Float32Array(0), shape: [0] };
  const n = product(shape);
  const need = dataOffset + n * 4;
  if (buf.length < need) throw new Error(`npy: truncated body (need ${need}, got ${buf.length})`);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = buf.readFloatLE(dataOffset + i * 4);
  return { data, shape };
}

/** rows×cols → number[][] */
export function npyToRows(npy: NpyFloat32): number[][] {
  if (npy.shape.length === 0 || (npy.shape.length === 1 && npy.shape[0] === 0)) return [];
  if (npy.shape.length === 1) {
    return [Array.from(npy.data)];
  }
  if (npy.shape.length !== 2) throw new Error(`npy: expected 1D or 2D, got ${npy.shape}`);
  const [rows, cols] = npy.shape;
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array<number>(cols);
    for (let c = 0; c < cols; c++) row[c] = npy.data[r * cols + c]!;
    out.push(row);
  }
  return out;
}

export function rowsToNpy(rows: number[][]): NpyFloat32 {
  if (!rows.length) return { data: new Float32Array(0), shape: [0, 0] };
  const cols = rows[0]!.length;
  const data = new Float32Array(rows.length * cols);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.length !== cols) throw new Error("npy: ragged rows");
    for (let c = 0; c < cols; c++) data[r * cols + c] = row[c]!;
  }
  return { data, shape: [rows.length, cols] };
}
