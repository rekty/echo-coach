/* Echo Coach — speak or sing, then get coached.
 * Frontend only: the Pollinations key comes from <polli-connect> (BYOP),
 * so every request is billed to the signed-in listener's own balance.
 */
(() => {
  "use strict";

  const API = "https://gen.pollinations.ai";
  const STT_MODEL = "microsoft/mai-transcribe-2"; // free
  const COACH_MODEL = "openai/gpt-5.4-nano"; // free
  const TTS_MODEL = "openai/tts-1"; // free
  const TTS_VOICE = "alloy";
  const SPEAK_MS = 12000;
  const SING_MS = 6000;
  const NOTE_MS = 1050;

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ auth */

  const connectEl = document.querySelector("polli-connect");
  const gate = $("gate");
  let apiKey = null;
  let flashTimer = 0;

  function paintGate() {
    const on = Boolean(apiKey);
    gate.classList.toggle("is-ok", on);
    gate.classList.remove("is-warn");
    gate.textContent = on
      ? "Connected. Requests are billed to your own Pollinations balance."
      : "Connect Pollinations above to spend from your own balance — no key to paste, nothing stored on a server.";
    document.querySelectorAll(".rec").forEach((b) => {
      b.disabled = !on;
    });
    const voice = $("speak-voice");
    if (voice) voice.disabled = !on;
  }

  function flash(msg) {
    gate.classList.remove("is-ok");
    gate.classList.add("is-warn");
    gate.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(paintGate, 7000);
  }

  function readKey() {
    const key = connectEl && typeof connectEl.apiKey === "string" ? connectEl.apiKey : null;
    if (key === apiKey) return;
    apiKey = key;
    paintGate();
  }

  if (connectEl) connectEl.addEventListener("change", readKey);
  paintGate();
  let probes = 0;
  const probe = setInterval(() => {
    readKey();
    if (apiKey || ++probes > 40) clearInterval(probe);
  }, 125);
  setTimeout(readKey, 600);

  function requireKey() {
    if (apiKey) return true;
    flash("Sign in with Pollinations first — the Connect button sits in the header.");
    document.querySelector(".connect")?.scrollIntoView({ block: "center", behavior: "smooth" });
    return false;
  }

  async function api(path, init = {}) {
    const headers = Object.assign({}, init.headers || {}, { Authorization: "Bearer " + apiKey });
    const res = await fetch(API + path, Object.assign({}, init, { headers }));
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).replace(/\s+/g, " ").slice(0, 180);
      } catch (_) {
        /* ignore */
      }
      throw new Error("Pollinations " + res.status + (detail ? " — " + detail : ""));
    }
    return res;
  }

  /* ----------------------------------------------------------------- audio */

  let audioCtx = null;

  function ctx() {
    const C = window.AudioContext || window.webkitAudioContext;
    audioCtx = audioCtx || new C();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /* WebM/Opus from MediaRecorder is not accepted by the transcriber, so every
   * take is decoded and re-encoded as 16 kHz mono 16-bit PCM WAV. */
  async function toWav(blob, rate = 16000) {
    const bytes = await blob.arrayBuffer();
    const audio = await ctx().decodeAudioData(bytes.slice(0));
    const frames = audio.length;
    const mono = new Float32Array(frames);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < frames; i++) mono[i] += data[i] / audio.numberOfChannels;
    }
    const ratio = audio.sampleRate / rate;
    const length = Math.floor(frames / ratio);
    const pcm = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      const v = Math.max(-1, Math.min(1, mono[Math.floor(i * ratio)]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const str = (off, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(off + i, text.charCodeAt(i));
    };
    str(0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, "data");
    view.setUint32(40, pcm.length * 2, true);
    new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer));
    return new Blob([buffer], { type: "audio/wav" });
  }

  class Recorder {
    constructor(opts) {
      Object.assign(this, opts);
      this.live = false;
    }

    async start() {
      if (this.live) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.stream = stream;
      const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      this.mime = (window.MediaRecorder && types.find((t) => MediaRecorder.isTypeSupported(t))) || "";
      this.chunks = [];
      this.frames = [];
      this.mr = new MediaRecorder(stream, this.mime ? { mimeType: this.mime } : undefined);
      this.mr.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      this.mr.onstop = () => this.finish();
      this.an = ctx().createAnalyser();
      this.an.fftSize = 2048;
      ctx().createMediaStreamSource(stream).connect(this.an);
      this.buf = new Float32Array(this.an.fftSize);
      this.t0 = performance.now();
      this.lastFrame = 0;
      this.mr.start(120);
      this.live = true;
      this.button.classList.add("is-live");
      this.label.textContent = "Stop";
      this.tick();
      this.killer = setTimeout(() => this.stop(), this.maxMs);
    }

    tick = () => {
      if (!this.live) return;
      const ms = performance.now() - this.t0;
      this.an.getFloatTimeDomainData(this.buf);
      if (this.levelEl) this.levelEl.style.width = Math.min(100, rms(this.buf) * 420) + "%";
      if (this.timerEl) this.timerEl.textContent = (ms / 1000).toFixed(1) + "s";
      if (this.onFrame && ms - this.lastFrame > 40) {
        this.lastFrame = ms;
        this.onFrame(this.buf, this.an.context.sampleRate, ms);
      }
      this.raf = requestAnimationFrame(this.tick);
    };

    stop() {
      if (!this.live) return;
      this.live = false;
      clearTimeout(this.killer);
      cancelAnimationFrame(this.raf);
      this.button.classList.remove("is-live");
      this.label.textContent = this.idleLabel;
      if (this.mr && this.mr.state !== "inactive") this.mr.stop();
      else this.finish();
    }

    finish() {
      clearTimeout(this.killer);
      cancelAnimationFrame(this.raf);
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.live = false;
      if (this.levelEl) this.levelEl.style.width = "0%";
      const blob = new Blob(this.chunks, { type: this.mime || "audio/webm" });
      if (blob.size > 2000) this.onDone(blob);
    }
  }

  /* ----------------------------------------------------------------- speak */

  const PHRASES = [
    { text: "The sixth sheikh's sixth sheep is sick.", hint: "Tongue twister · sibilants" },
    { text: "Red leather, yellow leather, red lorry, yellow lorry.", hint: "Alternating L and R" },
    { text: "I would like a proper cup of coffee in a proper copper coffee pot.", hint: "Plosives and rounded vowels" },
    { text: "Three thin thinkers thinking thick thoughtful thoughts.", hint: "TH and consonant clusters" },
    { text: "She stood on the balcony, inexplicably mimicking him hiccuping.", hint: "Long vowels, steady breath" },
    { text: "Imagine an imaginary menagerie manager managing an imaginary menagerie.", hint: "Word stress" },
    { text: "A skunk sat on a stump and thunk the stump stunk.", hint: "Short vowel contrast" },
    { text: "The quick brown fox jumps over the lazy dog.", hint: "Warm-up · every letter once" },
  ];

  let phraseIndex = 0;

  function renderPhrase() {
    const p = PHRASES[phraseIndex];
    $("phrase").textContent = p.text;
    $("phrase-hint").textContent = p.hint;
  }

  $("new-phrase").addEventListener("click", () => {
    phraseIndex = (phraseIndex + 1) % PHRASES.length;
    renderPhrase();
    $("speak-result").hidden = true;
  });

  const cleanWords = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);

  function align(target, said) {
    const a = cleanWords(target);
    const b = cleanWords(said);
    const grid = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        grid[i][j] = a[i] === b[j] ? grid[i + 1][j + 1] + 1 : Math.max(grid[i + 1][j], grid[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length) {
      if (j < b.length && a[i] === b[j]) {
        out.push({ word: a[i], ok: true });
        i++;
        j++;
      } else if (j < b.length && grid[i][j + 1] >= grid[i + 1][j]) {
        j++; // extra word spoken, ignore for the target view
      } else {
        out.push({ word: a[i], ok: false });
        i++;
      }
    }
    return out;
  }

  let takeUrl = null;

  function paintSpeak(transcript, accuracy, words) {
    $("speak-result").hidden = false;
    $("speak-transcript").textContent = transcript || "(nothing recognised)";
    const pct = Math.round(accuracy * 100);
    const pill = $("speak-score");
    pill.textContent = pct + "% words matched";
    pill.className = "pill " + (pct >= 85 ? "is-good" : pct >= 60 ? "is-mid" : "is-low");
    $("speak-diff").innerHTML = "";
    words.forEach((w) => {
      const span = document.createElement("span");
      span.className = w.ok ? "ok" : "miss";
      span.textContent = w.word;
      $("speak-diff").appendChild(span);
    });
  }

  function showCoach(prefix, payload) {
    $(prefix + "-headline").textContent = payload.headline || "Here is what stood out";
    const list = $(prefix + "-tips");
    list.innerHTML = "";
    payload.tips.forEach((tip) => {
      const li = document.createElement("li");
      li.textContent = tip;
      list.appendChild(li);
    });
  }

  function parseCoach(text, kind) {
    const attempt = (raw) => {
      try {
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    };
    let data = attempt(text);
    if (!data) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) data = attempt(match[0]);
    }
    if (data && (data.headline || data.tips)) {
      return {
        headline: String(data.headline || "").slice(0, 120),
        tips: (Array.isArray(data.tips) ? data.tips : [data.tips])
          .filter(Boolean)
          .slice(0, 3)
          .map((t) => String(t).slice(0, 220)),
      };
    }
    const fallback = text
      .split(/\n+/)
      .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
    return { headline: kind === "sing" ? "Pitch notes" : "Coach notes", tips: fallback };
  }

  async function coach(prompt, kind) {
    const system =
      kind === "sing"
        ? "You are a warm, precise singing coach. You receive a target melody and the measured pitch error per note in cents (positive = sharp, null = no voiced note detected). Reply with strict JSON only: {\"headline\":\"<=8 words\",\"tips\":[\"...\",\"...\",\"...\"]}. Each tip max 18 words, concrete and encouraging, about breath, support, vowel shape or listening."
        : "You are a warm, concise speech coach. You receive a target phrase, the learner's transcript and word accuracy. Reply with strict JSON only: {\"headline\":\"<=8 words\",\"tips\":[\"...\",\"...\",\"...\"]}. Each tip max 18 words, concrete and encouraging, about clarity, pacing, consonants or vowels.";
    const res = await api("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: COACH_MODEL,
        temperature: 0.6,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(prompt) },
        ],
      }),
    });
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    return parseCoach(text, kind);
  }

  async function analyseSpeak(blob) {
    const result = $("speak-result");
    result.classList.add("busy");
    try {
      takeUrl && URL.revokeObjectURL(takeUrl);
      takeUrl = URL.createObjectURL(blob);
      const wav = await toWav(blob);
      const form = new FormData();
      form.append("file", wav, "take.wav");
      form.append("model", STT_MODEL);
      form.append("response_format", "verbose_json");
      const res = await api("/v1/audio/transcriptions", { method: "POST", body: form });
      const data = await res.json();
      const said = (data.text || data.transcript || "").trim();
      const target = PHRASES[phraseIndex].text;
      const words = align(target, said);
      const matched = words.filter((w) => w.ok).length;
      const accuracy = words.length ? matched / words.length : 0;
      paintSpeak(said, accuracy, words);
      const missed = words.filter((w) => !w.ok).map((w) => w.word);
      const tips = await coach(
        { target, transcript: said, word_accuracy_percent: Math.round(accuracy * 100), missed_words: missed },
        "speak"
      );
      showCoach("speak", tips);
    } catch (err) {
      flash(String(err.message || err));
    } finally {
      result.classList.remove("busy");
    }
  }

  const speakRec = new Recorder({
    maxMs: SPEAK_MS,
    idleLabel: "Record 12s",
    button: $("speak-rec"),
    label: $("speak-rec-label"),
    levelEl: $("speak-level"),
    timerEl: $("speak-timer"),
    onDone: analyseSpeak,
  });

  $("speak-rec").addEventListener("click", async () => {
    if (speakRec.live) return speakRec.stop();
    if (!requireKey()) return;
    $("speak-result").hidden = true;
    try {
      await speakRec.start();
    } catch (err) {
      flash("Microphone unavailable: " + (err.message || err));
    }
  });

  $("speak-again").addEventListener("click", () => {
    $("speak-result").hidden = true;
    $("speak-rec").focus();
  });

  $("speak-play").addEventListener("click", () => {
    if (!takeUrl) return;
    new Audio(takeUrl).play();
  });

  const coachAudio = new Audio();

  $("speak-voice").addEventListener("click", async () => {
    if (!requireKey()) return;
    const headline = $("speak-headline").textContent;
    const tips = Array.from($("speak-tips").children).map((li) => li.textContent);
    if (!tips.length) return flash("Record a take first — there is nothing to read yet.");
    const button = $("speak-voice");
    button.disabled = true;
    try {
      const res = await api("/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: TTS_MODEL,
          voice: TTS_VOICE,
          input: headline + ". " + tips.join(". "),
          response_format: "mp3",
        }),
      });
      coachAudio.src = URL.createObjectURL(await res.blob());
      await coachAudio.play();
    } catch (err) {
      flash(String(err.message || err));
    } finally {
      button.disabled = false;
    }
  });

  /* ------------------------------------------------------------------ sing */

  const MELODIES = [
    { name: "C major climb", notes: [60, 64, 67, 64, 60] },
    { name: "Fifth leap", notes: [62, 69, 67, 65, 62] },
    { name: "Minor sigh", notes: [57, 60, 63, 60, 57] },
    { name: "Step down", notes: [67, 65, 64, 62, 60] },
  ];

  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const hzMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
  const noteName = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

  let melodyIndex = 0;

  function renderMelody() {
    const melody = MELODIES[melodyIndex];
    $("melody-name").textContent = melody.name;
    const box = $("melody-notes");
    box.innerHTML = "";
    melody.notes.forEach((m) => {
      const cell = document.createElement("div");
      cell.className = "note";
      cell.innerHTML = noteName(m) + "<small>" + Math.round(midiHz(m)) + " Hz</small>";
      box.appendChild(cell);
    });
    $("sing-notes").innerHTML = "";
    $("sing-coach").hidden = true;
    $("sing-score").textContent = "—";
    $("sing-score").className = "pill";
    drawTrace([], null);
  }

  $("new-melody").addEventListener("click", () => {
    melodyIndex = (melodyIndex + 1) % MELODIES.length;
    renderMelody();
  });

  function drawTrace(frames, results) {
    const canvas = $("sing-canvas");
    const g = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);
    const melody = MELODIES[melodyIndex];
    const low = Math.min.apply(null, melody.notes) - 3;
    const high = Math.max.apply(null, melody.notes) + 3;
    const y = (midi) => H - 24 - ((midi - low) / (high - low)) * (H - 44);
    const total = melody.notes.length * NOTE_MS;

    g.strokeStyle = "rgba(255,255,255,0.06)";
    g.lineWidth = 1;
    for (let oct = Math.ceil(low); oct <= high; oct++) {
      g.beginPath();
      g.moveTo(0, y(oct));
      g.lineTo(W, y(oct));
      g.stroke();
      g.fillStyle = "rgba(255,255,255,0.28)";
      g.font = "11px ui-monospace, monospace";
      g.fillText(noteName(oct), 6, y(oct) - 4);
    }

    melody.notes.forEach((m, i) => {
      const x0 = (i * NOTE_MS / total) * W + 3;
      const x1 = ((i + 1) * NOTE_MS / total) * W - 3;
      g.fillStyle = "rgba(111,93,255,0.16)";
      g.fillRect(x0, y(m) - 14, x1 - x0, 28);
      g.strokeStyle = "rgba(111,93,255,0.55)";
      g.strokeRect(x0, y(m) - 14, x1 - x0, 28);
      g.fillStyle = "rgba(207,200,255,0.85)";
      g.font = "600 12px system-ui, sans-serif";
      g.fillText(noteName(m), x0 + 8, y(m) - 20);
    });

    if (results) {
      results.forEach((r, i) => {
        if (r.cents === null) return;
        const x = ((i + 0.5) * NOTE_MS / total) * W;
        g.fillStyle = Math.abs(r.cents) <= 25 ? "#74ff7e" : Math.abs(r.cents) <= 60 ? "#ffb84d" : "#ff5470";
        g.beginPath();
        g.arc(x, y(hzMidi(r.hz)), 5, 0, Math.PI * 2);
        g.fill();
      });
    }

    const voiced = frames.filter((f) => f.hz > 0);
    if (voiced.length > 1) {
      g.strokeStyle = "#27d4cd";
      g.lineWidth = 2.5;
      g.lineJoin = "round";
      g.beginPath();
      voiced.forEach((f, i) => {
        const x = Math.min(W, (f.t / total) * W);
        const py = y(hzMidi(f.hz));
        i ? g.lineTo(x, py) : g.moveTo(x, py);
      });
      g.stroke();
    } else if (!results) {
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.font = "13px system-ui, sans-serif";
      g.fillText("Your pitch will be drawn here after you record.", 20, H / 2);
    }
  }

  /* Normalised autocorrelation. Raw correlation favours short lags (they cover
   * more samples), which reports low notes an octave or two too high, and the
   * first peak above a threshold sits on the rising edge, which adds a flat
   * few percent. So: normalise, take the first local maximum, then interpolate. */
  function detectPitch(buf, sampleRate) {
    if (rms(buf) < 0.012) return 0;
    const n = 1024;
    const minLag = Math.floor(sampleRate / 1000);
    const maxLag = Math.min(n - 2, Math.floor(sampleRate / 70));
    const scores = [];
    let peak = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0;
      let e1 = 0;
      let e2 = 0;
      for (let i = 0; i < n - lag; i++) {
        const a = buf[i];
        const b = buf[i + lag];
        num += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      const r = num / (Math.sqrt(e1 * e2) || 1);
      scores.push(r);
      if (r > peak) peak = r;
    }
    if (peak < 0.55) return 0;
    let pick = -1;
    for (let i = 1; i < scores.length - 1; i++) {
      if (scores[i] >= 0.85 * peak && scores[i] >= scores[i - 1] && scores[i] >= scores[i + 1]) {
        pick = i;
        break;
      }
    }
    if (pick < 0) return 0;
    let shift = 0;
    const prev = scores[pick - 1];
    const here = scores[pick];
    const next = scores[pick + 1];
    if (prev !== undefined && next !== undefined) {
      const denom = prev + next - 2 * here;
      if (denom) shift = (prev - next) / (2 * denom);
    }
    shift = Math.max(-0.5, Math.min(0.5, shift));
    const hz = sampleRate / (minLag + pick + shift);
    return hz >= 70 && hz <= 1050 ? hz : 0;
  }

  function scoreSing(frames) {
    const melody = MELODIES[melodyIndex];
    return melody.notes.map((target, i) => {
      const from = i * NOTE_MS + 120;
      const to = (i + 1) * NOTE_MS - 60;
      const hits = frames.filter((f) => f.t >= from && f.t <= to && f.hz > 0).map((f) => f.hz);
      if (!hits.length) return { target, hz: 0, cents: null };
      hits.sort((a, b) => a - b);
      const median = hits[Math.floor(hits.length / 2)];
      return { target, hz: median, cents: 1200 * Math.log2(median / midiHz(target)) };
    });
  }

  function paintSing(results, frames, tips) {
    const scored = results.filter((r) => r.cents !== null);
    const mean = scored.length ? scored.reduce((s, r) => s + Math.abs(r.cents), 0) / scored.length : 180;
    const score = Math.max(0, Math.min(100, Math.round(100 - mean / 2.2)));
    const pill = $("sing-score");
    pill.textContent = scored.length ? score + "/100 · " + Math.round(mean) + "¢ off" : "no pitch found";
    pill.className = "pill " + (score >= 80 ? "is-good" : score >= 55 ? "is-mid" : "is-low");

    const box = $("sing-notes");
    box.innerHTML = "";
    results.forEach((r) => {
      const span = document.createElement("span");
      if (r.cents === null) {
        span.className = "none";
        span.textContent = noteName(r.target) + " · not heard";
      } else {
        const off = Math.round(r.cents);
        span.className = Math.abs(off) <= 25 ? "solid" : off > 0 ? "sharp" : "flat";
        span.textContent = noteName(r.target) + " · " + (off > 0 ? "+" : "") + off + "¢";
      }
      box.appendChild(span);
    });

    drawTrace(frames, results);

    if (tips) {
      $("sing-coach").hidden = false;
      showCoach("sing", tips);
    }
  }

  async function analyseSing(frames) {
    const results = scoreSing(frames);
    paintSing(results, frames, null);
    const payload = {
      melody: MELODIES[melodyIndex].name,
      target_notes_hz: MELODIES[melodyIndex].notes.map((m) => Math.round(midiHz(m))),
      measured_cents: results.map((r) => (r.cents === null ? null : Math.round(r.cents))),
    };
    try {
      const tips = await coach(payload, "sing");
      paintSing(results, frames, tips);
    } catch (err) {
      flash(String(err.message || err));
    }
  }

  const singRec = new Recorder({
    maxMs: SING_MS,
    idleLabel: "Record 6s",
    button: $("sing-rec"),
    label: $("sing-rec-label"),
    levelEl: $("sing-level"),
    timerEl: $("sing-timer"),
    onFrame: (buf, rate, ms) => {
      const hz = detectPitch(buf, rate);
      singRec.frames.push({ t: ms, hz });
      if (hz) {
        const midi = hzMidi(hz);
        const near = Math.round(midi);
        const cents = Math.round((midi - near) * 100);
        $("sing-live").textContent =
          "Hearing " + noteName(near) + " · " + (cents > 0 ? "+" : "") + cents + "¢ · " + Math.round(hz) + " Hz";
      } else {
        $("sing-live").textContent = "Silence — take a breath and sing on “ah”.";
      }
    },
    onDone: analyseSing,
  });

  $("sing-rec").addEventListener("click", async () => {
    if (singRec.live) return singRec.stop();
    if (!requireKey()) return;
    $("sing-coach").hidden = true;
    $("sing-live").textContent = "Listening…";
    try {
      await singRec.start();
    } catch (err) {
      flash("Microphone unavailable: " + (err.message || err));
    }
  });

  /* ------------------------------------------------------------------ tabs */

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.mode;
      document.querySelectorAll(".tab").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", String(on));
      });
      document.querySelectorAll(".panel").forEach((p) => {
        const on = p.id === "panel-" + mode;
        p.classList.toggle("is-active", on);
        p.hidden = !on;
      });
    });
  });

  renderPhrase();
  renderMelody();
})();
