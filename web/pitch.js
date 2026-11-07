// The preview's pitch shifter (Web Audio has none): two read heads sweep a 50 ms delay line in opposite phase and
// crossfade (sin² windows sum to 1), so the pitch moves by `ratio` and the timing doesn't. The export shifts with
// asetrate + atempo: they sound alike, not sample for sample. Adds up to 50 ms of delay while it is in use.
class Pitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    this.W = Math.round(0.05 * sampleRate);
    this.N = this.W * 4;
    this.buf = [new Float32Array(this.N), new Float32Array(this.N)];
    this.w = 0;
    this.ph = 0;
  }
  process([inp], [out], { ratio }) {
    const r = ratio[0], W = this.W, N = this.N, n = out[0].length, step = (1 - r) / W;
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 2; ch++) this.buf[ch][this.w] = inp[ch]?.[i] ?? inp[0]?.[i] ?? 0;
      let p = this.ph + step;
      p -= Math.floor(p);
      this.ph = p;
      const q = (p + 0.5) % 1, g1 = Math.sin(Math.PI * p) ** 2;
      for (let ch = 0; ch < out.length; ch++) {
        const b = this.buf[ch % 2], tap = d => { const x = this.w - d + N, j = Math.floor(x), f = x - j; return b[j % N] * (1 - f) + b[(j + 1) % N] * f; };
        out[ch][i] = tap(p * W) * g1 + tap(q * W) * (1 - g1);
      }
      this.w = (this.w + 1) % N;
    }
    return true;
  }
}
registerProcessor('cutroom-pitch', Pitch);
