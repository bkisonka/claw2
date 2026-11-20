/**
 * HSS core — dialog-stability state model (JS port)
 * Density-matrix coherence node: intention vector, unitary evolution, validation.
 *
 * Part of the HSS core (with src/claw-cache/hss-*.ts and src/core/hss-middleware.ts).
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * License: GNU Lesser General Public License v3.0 or later.
 * See LICENSE-HSS.md in the repository root (or
 * https://www.gnu.org/licenses/lgpl-3.0.html).
 *
 * Dependencies: mathjs (npm install mathjs)
 * Run: node hss.cjs  or  node hss.cjs validate
 */

const crypto = require("crypto");
const math = require("mathjs");

// --- Seeded RNG (reproducible trajectory from signature) ---
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(rng) {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// --- Complex matrices: stored as re[i][j], im[i][j] ---
function zeros(dim) {
  const re = math.zeros(dim, dim)._data;
  const im = math.zeros(dim, dim)._data;
  return { re, im };
}

function eye(dim) {
  const re = math.identity(dim)._data.map((row) => row.slice());
  const im = math.zeros(dim, dim)._data;
  return { re, im };
}

function complexMatrixToRealBlock(M) {
  const n = M.re.length;
  const R = math.zeros(2 * n, 2 * n)._data;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      R[i][j] = M.re[i][j];
      R[i][n + j] = -M.im[i][j];
      R[n + i][j] = M.im[i][j];
      R[n + i][n + j] = M.re[i][j];
    }
  return math.matrix(R);
}

function realBlockToComplexMatrix(R) {
  const data = R._data || R;
  const n = data.length / 2;
  const re = math.zeros(n, n)._data;
  const im = math.zeros(n, n)._data;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      re[i][j] = data[i][j];
      im[i][j] = data[n + i][j];
    }
  return { re, im };
}

function matMul(A, B) {
  const n = A.re.length;
  const re = math.zeros(n, n)._data;
  const im = math.zeros(n, n)._data;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let re_ = 0, im_ = 0;
      for (let k = 0; k < n; k++) {
        re_ += A.re[i][k] * B.re[k][j] - A.im[i][k] * B.im[k][j];
        im_ += A.re[i][k] * B.im[k][j] + A.im[i][k] * B.re[k][j];
      }
      re[i][j] = re_;
      im[i][j] = im_;
    }
  return { re, im };
}

function matAdd(A, B, scaleB = 1) {
  const n = A.re.length;
  const re = math.zeros(n, n)._data;
  const im = math.zeros(n, n)._data;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      re[i][j] = A.re[i][j] + scaleB * B.re[i][j];
      im[i][j] = A.im[i][j] + scaleB * B.im[i][j];
    }
  return { re, im };
}

function conjT(M) {
  const n = M.re.length;
  const re = math.zeros(n, n)._data;
  const im = math.zeros(n, n)._data;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      re[i][j] = M.re[j][i];
      im[i][j] = -M.im[j][i];
    }
  return { re, im };
}

function trace(M) {
  let tr = 0;
  const n = M.re.length;
  for (let i = 0; i < n; i++) tr += M.re[i][i];
  return tr;
}

function scale(M, c) {
  const n = M.re.length;
  const re = math.zeros(n, n)._data;
  const im = math.zeros(n, n)._data;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      re[i][j] = M.re[i][j] * c;
      im[i][j] = M.im[i][j] * c;
    }
  return { re, im };
}

function herm(M) {
  const H = conjT(M);
  return scale(matAdd(M, H), 0.5);
}

function isComplexMatrixFinite(M) {
  const n = M.re.length;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(M.re[i][j]) || !Number.isFinite(M.im[i][j])) return false;
    }
  return true;
}

// exp(-i H dt) for Hermitian H: via real block and mathjs expm
function expmMinusIHDtFromBlock(H, dt) {
  const n = H.re.length;
  const Hblock = math.zeros(2 * n, 2 * n)._data;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      Hblock[i][j] = H.im[i][j] * dt;
      Hblock[i][n + j] = -H.re[i][j] * dt;
      Hblock[n + i][j] = H.re[i][j] * dt;
      Hblock[n + i][n + j] = H.im[i][j] * dt;
    }
  const expBlock = math.expm(math.matrix(Hblock));
  return realBlockToComplexMatrix(expBlock);
}

/** Spectral fallback: exp(-i H dt) = V diag(e^{-i λ dt}) V† for Hermitian H. */
function expmMinusIHDtFromSpectrum(H, dt) {
  const Hh = herm(H);
  const { eigenvalues, V } = eigh(Hh);
  const n = eigenvalues.length;
  const D = { re: math.zeros(n, n)._data, im: math.zeros(n, n)._data };
  for (let k = 0; k < n; k++) {
    const angle = eigenvalues[k] * dt;
    D.re[k][k] = Math.cos(angle);
    D.im[k][k] = -Math.sin(angle);
  }
  return matMul(matMul(V, D), conjT(V));
}

/**
 * exp(-i H dt) with graceful fallback: block expm → spectrum → identity (unitary step skipped,
 * lindblad/noise/projection in evolve keep working).
 */
function expmMinusIHDt(H, dt) {
  try {
    const U = expmMinusIHDtFromBlock(H, dt);
    if (isComplexMatrixFinite(U)) return { U, method: "block" };
  } catch (_errBlock) {
    /* block expm failed — try spectrum */
  }
  try {
    const U = expmMinusIHDtFromSpectrum(H, dt);
    if (isComplexMatrixFinite(U)) return { U, method: "spectrum" };
  } catch (_errSpectrum) {
    /* spectrum failed — identity below */
  }
  return { U: eye(H.re.length), method: "identity" };
}

// 2×2 Hermitian: eigenvalues and eigenvectors in closed form
function eigh2(M) {
  const a = M.re[0][0], d = M.re[1][1];
  const b = M.re[0][1], c = M.im[0][1];
  const disc = (a - d) * (a - d) / 4 + b * b + c * c;
  const sqrtDisc = Math.sqrt(Math.max(0, disc));
  const e0 = (a + d) / 2 - sqrtDisc;
  const e1 = (a + d) / 2 + sqrtDisc;
  const eigenvalues = [e0, e1];
  const V = { re: math.zeros(2, 2)._data, im: math.zeros(2, 2)._data };
  if (Math.abs(sqrtDisc) < 1e-14) {
    V.re[0][0] = 1; V.re[1][1] = 1;
  } else {
    const v0re = b, v0im = c, v1re = e0 - a, v1im = 0;
    let nrm = Math.sqrt(v0re * v0re + v0im * v0im + v1re * v1re + v1im * v1im) || 1;
    V.re[0][0] = v0re / nrm; V.im[0][0] = v0im / nrm;
    V.re[1][0] = v1re / nrm; V.im[1][0] = v1im / nrm;
    const w0re = b, w0im = c, w1re = e1 - a, w1im = 0;
    nrm = Math.sqrt(w0re * w0re + w0im * w0im + w1re * w1re + w1im * w1im) || 1;
    V.re[0][1] = w0re / nrm; V.im[0][1] = w0im / nrm;
    V.re[1][1] = w1re / nrm; V.im[1][1] = w1im / nrm;
  }
  return { eigenvalues, V };
}

function eigh(M) {
  const n = M.re.length;
  if (n === 2) return eigh2(M);
  const R = complexMatrixToRealBlock(M);
  const result = math.eigs(R);
  const valuesData = result.values && result.values._data ? result.values._data : Array.from(result.values);
  const eigenvalues = [];
  for (let i = 0; i < n && 2 * i < valuesData.length; i++) eigenvalues.push(valuesData[2 * i]);
  while (eigenvalues.length < n) eigenvalues.push(0);
  const V = { re: math.zeros(n, n)._data, im: math.zeros(n, n)._data };
  const vecs = result.eigenvectors;
  if (vecs) {
    for (let k = 0; k < n; k++) {
      const col = vecs[k].vector._data || vecs[k].vector;
      for (let i = 0; i < n; i++) {
        V.re[i][k] = col[i];
        V.im[i][k] = col[n + i];
      }
    }
  }
  return { eigenvalues, V };
}

/** ξ length: covers ρ dim=11 (11²=121) without NaN in H / expm. */
const INTENTION_XI_DEFAULT_SIZE = 128;

/** Hamiltonian from semantic embedding + signature (field ontology). */
function buildHamiltonianFromEmbedding(embedding, dim, intention, mix = 0.55) {
  let H = zeros(dim);
  if (intention) {
    if (dim === 2) {
      const xi = intention.get_xi(0);
      H = {
        re: [[0, xi - 0.5], [xi - 0.5, 0]],
        im: [[0, 0], [0, 0]],
      };
    } else {
      const vec = intention.get_xi_slice(dim * dim);
      H = { re: math.zeros(dim, dim)._data, im: math.zeros(dim, dim)._data };
      for (let i = 0; i < dim; i++)
        for (let j = 0; j < dim; j++) {
          const x = vec[i * dim + j];
          H.re[i][j] = ((Number.isFinite(x) ? x : intention.get_xi(i * dim + j)) - 0.5) * 0.5;
          H.re[j][i] = H.re[i][j];
        }
    }
  }
  if (!embedding || !embedding.length) return H;
  const semantic = { re: math.zeros(dim, dim)._data, im: math.zeros(dim, dim)._data };
  const n = embedding.length;
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      const v = embedding[(i * dim + j) % n];
      semantic.re[i][j] = (v - 0.5) * 0.6;
      if (i !== j) semantic.re[j][i] = semantic.re[i][j];
    }
  }
  return herm(matAdd(H, semantic, mix));
}

/** Resize ξ matrix from chronicle to the node's current dim (after resizeDimension 4→8→11). */
function xiAtDim(xi, dim) {
  if (!xi?.re?.length) return null;
  const n = xi.re.length;
  if (n === dim) return xi;
  const re = math.zeros(dim, dim)._data;
  const im = math.zeros(dim, dim)._data;
  const m = Math.min(n, dim);
  for (let i = 0; i < m; i++) {
    const rowRe = xi.re[i];
    const rowIm = xi.im?.[i];
    if (!rowRe) continue;
    for (let j = 0; j < m; j++) {
      re[i][j] = rowRe[j] ?? 0;
      im[i][j] = rowIm?.[j] ?? 0;
    }
  }
  return { re, im };
}

// --- IntentionModule ---
class IntentionModule {
  constructor(signature, size = INTENTION_XI_DEFAULT_SIZE) {
    this.signature = signature;
    this.hex_hash = crypto.createHash("sha256").update(signature, "utf8").digest("hex");
    this.seed_val = parseInt(this.hex_hash.slice(0, 8), 16) % 0x100000000;
    const rng = mulberry32(this.seed_val);
    const n = Math.max(1, Math.floor(Number(size)) || INTENTION_XI_DEFAULT_SIZE);
    this.xi_vector = Array.from({ length: n }, () => rng());
  }

  get_xi(index = 0) {
    const len = this.xi_vector.length;
    return this.xi_vector[((index % len) + len) % len];
  }

  /** Exactly n finite coefficients; if size < n — periodic extension (no undefined→NaN). */
  get_xi_slice(n) {
    const need = Math.max(0, Math.floor(Number(n)) || 0);
    const len = this.xi_vector.length;
    if (need <= len) return this.xi_vector.slice(0, need);
    const out = new Array(need);
    for (let i = 0; i < need; i++) out[i] = this.xi_vector[i % len];
    return out;
  }

  get_xi_matrix(dim, scale = 0.1) {
    const rng = mulberry32(this.seed_val);
    const n = dim * dim * 2;
    const flat = Array.from({ length: n }, () => randn(rng));
    const re = math.zeros(dim, dim)._data;
    const im = math.zeros(dim, dim)._data;
    for (let i = 0; i < dim; i++)
      for (let j = 0; j < dim; j++) {
        re[i][j] = flat[i * dim + j] * scale;
        im[i][j] = flat[dim * dim + i * dim + j] * scale;
      }
    const M = { re, im };
    return herm(M);
  }

  get_xi_matrix_coherence_preserving(dim, scale = 0.1) {
    const vec = this.get_xi_slice(dim * 2);
    const vRe = vec.slice(0, dim).map((x) => x - 0.5);
    const vIm = vec.slice(dim, dim * 2).map((x) => (x - 0.5));
    let nrm = 0;
    for (let i = 0; i < dim; i++) nrm += vRe[i] ** 2 + vIm[i] ** 2;
    nrm = Math.sqrt(nrm) || 1e-12;
    const re = math.zeros(dim, dim)._data;
    const im = math.zeros(dim, dim)._data;
    for (let i = 0; i < dim; i++)
      for (let j = 0; j < dim; j++) {
        re[i][j] = (vRe[i] * vRe[j] + vIm[i] * vIm[j]) * (scale / (nrm * nrm));
        im[i][j] = (vRe[i] * vIm[j] - vIm[i] * vRe[j]) * (scale / (nrm * nrm));
      }
    return { re, im };
  }
}

// ============================================================
// === NEW MODULES: Memory and Chronicle ======================
// ============================================================

/**
 * ChronicleEntry — a record in the session chronicle.
 * Stores node state (rho, xi_used) + context. xi_used is used in generateInnerXi.
 * rho — density matrix; node.restoreFromEntry(entry) re-instantiates that state.
 * importance (0..1): entries with importance >= minImportanceToKeep are not removed by TTL (important ones stay forever).
 */
class ChronicleEntry {
  constructor({
    timestamp = Date.now(),
    rho = null,
    entropy = 0,
    coherence = 0,
    context = "",
    context_embedding = null,
    xi_used = null,
    tags = [],
    importance = 0.5,
  } = {}) {
    this.timestamp = timestamp;
    this.rho = rho;
    this.entropy = entropy;
    this.coherence = coherence;
    this.context = context;
    this.context_embedding = context_embedding;
    this.xi_used = xi_used;
    this.tags = tags;
    this.importance = Math.max(0, Math.min(1, importance));
  }

  toJSON() {
    return {
      t: this.timestamp,
      e: this.entropy,
      c: this.coherence,
      ctx: this.context,
      emb: this.context_embedding,
      xi: this.xi_used,
      rho: this.rho,
      importance: this.importance,
      tags: this.tags,
    };
  }
}

/**
 * Chronicle — session chronicle (what the dialog line was about)
 */
class Chronicle {
  constructor(maxSize = 1000) {
    this.entries = [];
    this.maxSize = maxSize;
    this.embeddingDim = 64;
  }

  add(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  findSimilarContexts(contextEmbedding, topK = 5, threshold = 0.7) {
    if (!contextEmbedding || this.entries.length === 0) return [];

    const results = [];
    for (const entry of this.entries) {
      if (!entry.context_embedding) continue;
      const sim = this._cosineSimilarity(contextEmbedding, entry.context_embedding);
      if (sim > threshold) {
        results.push({ entry, similarity: sim });
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  getRecent(n = 10) {
    return this.entries.slice(-n);
  }

  clear() {
    this.entries = [];
  }
}

/**
 * ContextEncoder — turns context text into a vector (hash-vector over words)
 */
class ContextEncoder {
  constructor(dim = 64) {
    this.dim = dim;
  }

  encode(text) {
    if (!text) return new Array(this.dim).fill(0);
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 0);
    const vec = new Array(this.dim).fill(0);
    for (const word of words) {
      const hash = this._hash(word);
      for (let i = 0; i < this.dim; i++) {
        vec[i] += (hash >> (i % 31)) & 1 ? 1 : -1;
      }
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    }
    return vec;
  }

  _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return h;
  }
}

// --- TopologicalNode ---
class TopologicalNode {
  constructor(dim = 2, intention = null, chronicle = null, contextEncoder = null) {
    this.dim = dim;
    this.intention = intention;
    this.rho = scale(eye(dim), 1 / dim);
    this.entropy_history = [];
    this.coherence_history = [];
    this.chronicle = chronicle || new Chronicle();
    this.contextEncoder = contextEncoder || new ContextEncoder();
    this.lastContext = "";
  }

  _project_to_valid_density(tol = 1e-14) {
    this.rho = herm(this.rho);
    const { eigenvalues, V } = eigh(this.rho);
    const eigs = eigenvalues.map((e) => Math.max(e, tol));
    const sum = eigs.reduce((a, b) => a + b, 0);
    for (let i = 0; i < eigs.length; i++) eigs[i] /= sum;
    const Vt = conjT(V);
    const D = { re: math.zeros(this.dim, this.dim)._data, im: math.zeros(this.dim, this.dim)._data };
    for (let i = 0; i < this.dim; i++) D.re[i][i] = eigs[i];
    this.rho = matMul(matMul(V, D), Vt);
  }

  check_topological_invariant(tol_trace = 1e-10, tol_eig = 1e-12) {
    const trace_rho = trace(this.rho);
    const trace_valid = Math.abs(trace_rho - 1) < tol_trace;
    const { eigenvalues } = eigh(herm(this.rho));
    const positive_semidefinite = eigenvalues.every((e) => e >= -tol_eig);
    const ok = trace_valid && positive_semidefinite;
    return {
      trace_valid,
      trace: trace_rho,
      positive_semidefinite,
      eigenvalues,
      ok,
      status: ok ? "STABLE" : "FRAGMENTED",
    };
  }

  measure_coherence() {
    const rho2 = matMul(this.rho, this.rho);
    return trace(rho2);
  }

  entropy() {
    const { eigenvalues } = eigh(this.rho);
    let S = 0;
    for (const e of eigenvalues) {
      const p = Math.max(e, 1e-16);
      S -= p * Math.log(p);
    }
    return S;
  }

  _regulate_entropy(target_entropy = 0.3, tolerance = 0.1) {
    const S = this.entropy();
    if (S < target_entropy - tolerance) {
      const beta = Math.min(0.25, (target_entropy - S) * 0.5);
      this.rho = matAdd(scale(this.rho, 1 - beta), scale(eye(this.dim), beta / this.dim));
      this.rho = scale(this.rho, 1 / trace(this.rho));
    } else if (S > target_entropy + tolerance) {
      this.rho = herm(this.rho);
      const { eigenvalues, V } = eigh(this.rho);
      const eigs = eigenvalues.map((e) => Math.max(e, 1e-14));
      for (let i = 0; i < this.dim - 1; i++) eigs[i] *= 0.95;
      const sum = eigs.reduce((a, b) => a + b, 0);
      for (let i = 0; i < eigs.length; i++) eigs[i] /= sum;
      const D = { re: math.zeros(this.dim, this.dim)._data, im: math.zeros(this.dim, this.dim)._data };
      for (let i = 0; i < this.dim; i++) D.re[i][i] = eigs[i];
      const Vt = conjT(V);
      this.rho = matMul(matMul(V, D), Vt);
    }
    this._project_to_valid_density();
  }

  /**
   * Generate ξ_μ (inner intention) from context and past experience
   */
  generateInnerXi(context, baseStrength = 0.1) {
    if (!this.intention) return null;

    const ctxVec = this.contextEncoder.encode(context);
    const similar = this.chronicle.findSimilarContexts(ctxVec, 3, 0.6);

    let xi_inner = { re: math.zeros(this.dim, this.dim)._data, im: math.zeros(this.dim, this.dim)._data };
    let totalWeight = 0;

    for (const { entry, similarity } of similar) {
      const xiEntry = xiAtDim(entry.xi_used, this.dim);
      if (xiEntry) {
        for (let i = 0; i < this.dim; i++) {
          for (let j = 0; j < this.dim; j++) {
            xi_inner.re[i][j] += xiEntry.re[i][j] * similarity;
            xi_inner.im[i][j] += xiEntry.im[i][j] * similarity;
          }
        }
        totalWeight += similarity;
      }
    }

    if (totalWeight > 0) {
      for (let i = 0; i < this.dim; i++) {
        for (let j = 0; j < this.dim; j++) {
          xi_inner.re[i][j] /= totalWeight;
          xi_inner.im[i][j] /= totalWeight;
        }
      }
    } else {
      const xi_base = this.intention.get_xi_matrix_coherence_preserving(this.dim, baseStrength);
      xi_inner = xi_base;
    }

    const variation = baseStrength * 0.1;
    // Deterministic jitter: seeded like the rest of the module (mulberry32 over
    // the intention seed) — Math.random() here broke reproducibility of runs.
    const rng = mulberry32(
      (this.intention ? this.intention.seed_val : 42) + Math.round(baseStrength * 1e6) * 104729
    );
    for (let i = 0; i < this.dim; i++) {
      xi_inner.re[i][i] += (rng() - 0.5) * variation;
    }

    return herm(xi_inner);
  }

  evolve({
    dt = 0.1,
    H = null,
    external_flux = null,
    noise_strength = 0,
    regulate_entropy = null,
    lindblad_strength = 0,
    xi_mu_mode = "random",
    context = "",
    useInnerXi = true,
    saveToChronicle = true,
    chronicleImportance = 0.5,
    contextEmbedding = null,
    fieldFlux = null,
    hamiltonianMix = 0.55,
  } = {}) {
    let xi_used = null;
    if (useInnerXi && this.intention && context) {
      xi_used = this.generateInnerXi(context, 0.1);
    }

    if (H === null) {
      if (contextEmbedding && contextEmbedding.length) {
        H = buildHamiltonianFromEmbedding(
          contextEmbedding,
          this.dim,
          this.intention,
          hamiltonianMix
        );
      } else if (this.intention) {
        if (this.dim === 2) {
          const xi = this.intention.get_xi(0);
          H = {
            re: [[0, xi - 0.5], [xi - 0.5, 0]],
            im: [[0, 0], [0, 0]],
          };
        } else {
          const vec = this.intention.get_xi_slice(this.dim * this.dim);
          H = { re: math.zeros(this.dim, this.dim)._data, im: math.zeros(this.dim, this.dim)._data };
          for (let i = 0; i < this.dim; i++)
            for (let j = 0; j < this.dim; j++) {
              const x = vec[i * this.dim + j];
              H.re[i][j] =
                ((Number.isFinite(x) ? x : this.intention.get_xi(i * this.dim + j)) - 0.5) * 0.5;
              H.re[j][i] = H.re[i][j];
            }
        }
      } else {
        H = zeros(this.dim);
      }
    }
    let effExternalFlux = external_flux;
    let effLindblad = lindblad_strength;
    let effNoise = noise_strength;
    if (fieldFlux) {
      const phi = typeof fieldFlux.phi === "number" ? fieldFlux.phi : 0;
      const gamma = typeof fieldFlux.gamma === "number" ? fieldFlux.gamma : 0;
      const xiF = typeof fieldFlux.xi === "number" ? fieldFlux.xi : 0;
      effExternalFlux = (effExternalFlux || 0) + phi * 0.12;
      effLindblad = effLindblad * (1 + Math.min(1, Math.max(0, xiF)));
      effNoise = effNoise * Math.max(0.05, 1 - gamma * 0.45);
    }
    if (effExternalFlux != null) {
      H = matAdd(H, scale(eye(this.dim), effExternalFlux));
    }

    const { U, method: expmMethod } = expmMinusIHDt(H, dt);
    const Uc = conjT(U);
    this.rho = matMul(matMul(U, this.rho), Uc);

    if (effLindblad > 0 && this.intention) {
      let xi_mu;
      if (xi_used) {
        xi_mu = xi_used;
      } else {
        xi_mu = xi_mu_mode === "coherence_preserving"
          ? this.intention.get_xi_matrix_coherence_preserving(this.dim, 0.05)
          : this.intention.get_xi_matrix(this.dim, 0.05);
      }
      const anticommutator = matAdd(matMul(xi_mu, this.rho), matMul(this.rho, conjT(xi_mu)), 1);
      this.rho = matAdd(this.rho, scale(anticommutator, dt * effLindblad));
    }

    if (effNoise > 0) {
      const stepIndex = this.entropy_history.length;
      const rng = mulberry32((this.intention ? this.intention.seed_val : 42) + stepIndex * 7919);
      const re = math.zeros(this.dim, this.dim)._data;
      const im = math.zeros(this.dim, this.dim)._data;
      for (let i = 0; i < this.dim; i++)
        for (let j = 0; j < this.dim; j++) {
          re[i][j] = randn(rng) * effNoise;
          im[i][j] = randn(rng) * effNoise;
        }
      const noise = herm({ re, im });
      this.rho = matAdd(this.rho, noise);
    }

    const tr = trace(this.rho);
    if (Math.abs(tr) > 1e-14) this.rho = scale(this.rho, 1 / tr);

    this._project_to_valid_density();
    if (regulate_entropy != null) this._regulate_entropy(regulate_entropy);

    const S = this.entropy();
    const coh = this.measure_coherence();
    this.entropy_history.push(S);
    this.coherence_history.push(coh);

    if (saveToChronicle && context) {
      const ctxVec = this.contextEncoder.encode(context);
      const rhoCopy = this.rho && this.rho.re && this.rho.im
        ? { re: this.rho.re.map((r) => r.slice()), im: this.rho.im.map((r) => r.slice()) }
        : null;
      const entry = new ChronicleEntry({
        timestamp: Date.now(),
        rho: rhoCopy,
        entropy: S,
        coherence: coh,
        context: context.slice(0, 200),
        context_embedding: ctxVec,
        xi_used: xi_used,
        tags: [],
        importance: Math.max(0, Math.min(1, typeof chronicleImportance === "number" ? chronicleImportance : 0.5)),
      });
      this.chronicle.add(entry);
      this.lastContext = context;
    }

    return { S, coh, expmFallback: expmMethod !== "block" ? expmMethod : undefined };
  }

  /**
   * Expand ρ dim (4→8→11): embed current state; new axes get thermal noise.
   */
  resizeDimension(newDim) {
    if (!Number.isInteger(newDim) || newDim <= this.dim) return this.dim;
    const n = this.dim;
    const old = this.rho;
    const re = math.zeros(newDim, newDim)._data;
    const im = math.zeros(newDim, newDim)._data;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        re[i][j] = old.re[i][j];
        im[i][j] = old.im[i][j];
      }
    const tr = trace(old);
    const remainder = Math.max(0, 1 - tr);
    const perNew = remainder / (newDim - n);
    for (let i = n; i < newDim; i++) re[i][i] = perNew;
    this.dim = newDim;
    this.rho = { re, im };
    this._project_to_valid_density();
    return this.dim;
  }

  /**
   * Restore node state from a chronicle entry (rho):
   * re-instantiates the exact state that produced the entry.
   */
  restoreFromEntry(entry) {
    if (!entry || !entry.rho) return;
    const r = entry.rho;
    if (!r.re || !r.im) return;
    const rDim = r.re.length;
    if (rDim !== this.dim) {
      if (rDim > this.dim) this.resizeDimension(rDim);
      else if (rDim < this.dim) {
        // Embed the smaller ρ into the current dim
        const re = math.zeros(this.dim, this.dim)._data;
        const im = math.zeros(this.dim, this.dim)._data;
        for (let i = 0; i < rDim; i++)
          for (let j = 0; j < rDim; j++) {
            re[i][j] = r.re[i][j];
            im[i][j] = r.im[i][j];
          }
        const tr = trace({ re: r.re, im: r.im });
        const remainder = Math.max(0, 1 - tr);
        const perNew = remainder / Math.max(1, this.dim - rDim);
        for (let i = rDim; i < this.dim; i++) re[i][i] = perNew;
        this.rho = { re, im };
        this._project_to_valid_density();
        return;
      }
    }
    if (r.re.length !== this.dim || r.im.length !== this.dim) return;
    this.rho = { re: r.re.map((row) => row.slice()), im: r.im.map((row) => row.slice()) };
  }

  /**
   * Chronology helpers, validation and evolution live below; the node itself
   * carries no introspection layer — session analysis is done by the
   * stabilizer (src/claw-cache/hss-stabilizer.ts) on live metrics.
   */
}

// --- Validation ---
function coherence_thermal(dim) {
  return 1 / dim;
}
const COHERENCE_SETTLED_MIN = 0.8;

function run_validation({
  signature = "Victoria_Resonance_LCP_One",
  steps = 500,
  dimension = 2,
  dt = 0.1,
  lindblad_strength = 0.02,
  xi_mu_mode = "random",
  noise_strength = 0.01,
  initial_state = "maximal_mixed",
  force_H_zero = false,
  verbose = true,
} = {}) {
  const thermal_coh = coherence_thermal(dimension);
  const intention = new IntentionModule(signature, INTENTION_XI_DEFAULT_SIZE);
  const node = new TopologicalNode(dimension, intention);
  if (initial_state === "pure_from_signature" && intention) {
    node.rho = intention.get_xi_matrix_coherence_preserving(dimension, 1);
  }
  const H_fixed = force_H_zero ? zeros(dimension) : null;

  let fragmented_count = 0;
  let thermal_count = 0;
  let min_coherence = 1;
  let max_coherence = 0;

  for (let step = 0; step < steps; step++) {
    const { S, coh } = node.evolve({
      dt,
      H: H_fixed,
      noise_strength,
      lindblad_strength,
      xi_mu_mode,
    });
    const inv = node.check_topological_invariant();
    if (inv.status === "FRAGMENTED") fragmented_count++;
    if (coh <= thermal_coh) thermal_count++;
    min_coherence = Math.min(min_coherence, coh);
    max_coherence = Math.max(max_coherence, coh);
  }

  const settled = min_coherence > COHERENCE_SETTLED_MIN && fragmented_count === 0;
  const result = {
    min_coherence,
    max_coherence,
    thermal_count,
    fragmented_count,
    thermal_coherence_threshold: thermal_coh,
    settled,
    steps,
    dimension,
    xi_mu_mode,
  };
  if (verbose) {
    console.log("=== HSS validation ===\n");
    console.log(`Signature: ${signature}, dim=${dimension}, steps=${steps}`);
    console.log(`xi_mu_mode: ${xi_mu_mode}, lindblad_strength=${lindblad_strength}`);
    if (initial_state === "pure_from_signature") console.log("initial_state: pure_from_signature");
    if (force_H_zero) console.log("force_H_zero: True");
    console.log(`\nThermal noise threshold (1/dim): Coh <= ${thermal_coh.toFixed(4)} → coherence below noise floor`);
    console.log("FRAGMENTED: topological invariant violated\n");
    console.log(`  Min Coh:     ${min_coherence.toFixed(4)}`);
    console.log(`  Max Coh:     ${max_coherence.toFixed(4)}`);
    console.log(`  Steps Coh<=1/dim: ${thermal_count}`);
    console.log(`  Steps FRAGMENTED: ${fragmented_count}`);
    console.log(`\n  Settled (Coh>${COHERENCE_SETTLED_MIN} and 0 FRAGMENTED): ${settled ? "yes" : "no"}\n`);
  }
  return result;
}

// --- Demo ---
function run_hss_demo({
  signature = "Victoria_Resonance_LCP_One",
  steps = 5,
  dt = 0.3,
  dimension = 2,
  regulate_entropy = null,
  lindblad_strength = 0,
  xi_mu_mode = "random",
  use_persistent = true,
} = {}) {
  if (use_persistent) {
    dimension = 4;
    regulate_entropy = null;
    lindblad_strength = 0.25;
    xi_mu_mode = "coherence_preserving";
  }
  const intention = new IntentionModule(signature, INTENTION_XI_DEFAULT_SIZE);
  const node = new TopologicalNode(dimension, intention);
  if (use_persistent) {
    node.rho = intention.get_xi_matrix_coherence_preserving(dimension, 1);
  }

  const noise_strength = use_persistent ? 0.0005 : 0.02;
  const H_fixed = use_persistent ? zeros(dimension) : null;

  console.log("=== HSS: dialog-stability state model (JS) ===\n");
  console.log(`Signature: ${signature}`);
  console.log(`SHA-256: ${intention.hex_hash}`);
  console.log(`Dimension: ${dimension}`);
  if (use_persistent) console.log("Regime: PERSISTENT (pure state from signature, coherence_preserving, H=0, low noise)");
  if (regulate_entropy != null) console.log(`Entropy regulation: target=${regulate_entropy}`);
  if (lindblad_strength > 0) console.log(`Lindblad: strength=${lindblad_strength}, mode=${xi_mu_mode}`);
  console.log();

  const show_every = steps <= 20 ? 1 : Math.max(1, Math.floor(steps / 20));
  let stable_steps = 0;
  for (let step = 0; step < steps; step++) {
    const { S, coh } = node.evolve({
      dt,
      H: H_fixed,
      noise_strength,
      regulate_entropy,
      lindblad_strength,
      xi_mu_mode,
    });
    const inv = node.check_topological_invariant();
    if (inv.status === "STABLE") stable_steps++;
    if (step < 5 || step >= steps - 5 || (step + 1) % show_every === 0 || step === 0) {
      console.log(`Step ${step + 1}: S=${S.toFixed(4)}, Coh=${coh.toFixed(4)}, ${inv.status}`);
    } else if (step === 5 && steps > 15) {
      console.log("  ...");
    }
  }

  const inv = node.check_topological_invariant();
  console.log("\nFinal invariant check:");
  console.log("  trace:", inv.trace, "ok:", inv.ok, "status:", inv.status);
  console.log("  eigenvalues:", inv.eigenvalues);
  const avgS = node.entropy_history.reduce((a, b) => a + b, 0) / node.entropy_history.length;
  const avgC = node.coherence_history.reduce((a, b) => a + b, 0) / node.coherence_history.length;
  console.log(`\nSummary: ${stable_steps}/${steps} STABLE. Mean S: ${avgS.toFixed(4)}, Coh: ${avgC.toFixed(4)}`);
  console.log("\nNote: this is an experimental dialog-stability feedback loop, not a claim about cognition.");
}

// --- Export and entrypoint ---
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    IntentionModule,
    TopologicalNode,
    Chronicle,
    ChronicleEntry,
    ContextEncoder,
    run_validation,
    run_hss_demo,
    coherence_thermal,
    COHERENCE_SETTLED_MIN,
    INTENTION_XI_DEFAULT_SIZE,
    buildHamiltonianFromEmbedding,
  };
}

if (require.main === module) {
  const validate = process.argv.includes("validate");
  if (validate) {
    console.log("Regime: xi_mu = random\n");
    run_validation({ steps: 200, dimension: 2, xi_mu_mode: "random", lindblad_strength: 0.02 });
    console.log("Regime: xi_mu = coherence_preserving\n");
    run_validation({ steps: 200, dimension: 2, xi_mu_mode: "coherence_preserving", lindblad_strength: 0.02 });
  } else {
    run_hss_demo({ steps: 500, use_persistent: true });
  }
}
