import { useEffect, useRef, useState } from "react";

type VoiceInputProps = {
  apiRoot: string;
  headers: Record<string, string>;
  disabled?: boolean;
  disabledReason?: string;
  onText: (text: string) => void;
};

type State = "idle" | "listening" | "sending";

const maxSeconds = 60;
const silenceStopMs = 3000;
const noSpeechStopMs = 10000;
const speechLevel = 0.02;
const targetRate = 16000;
const consentKey = "sawakai-voice-input-consent";
const deviceFallbackMs = 5 * 60 * 1000;
let deviceModeUntil = 0;

class TranscribeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type DeviceRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getDeviceRecognition(): (new () => DeviceRecognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => DeviceRecognition;
    webkitSpeechRecognition?: new () => DeviceRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function getAudioContextClass(): typeof AudioContext | null {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

// 端末の録音（44.1k/48kHz）を、音声認識に向いた16kHzへ縮めて16bit WAVにする
function encodeWav(chunks: Float32Array[], inputRate: number) {
  let total = 0;
  chunks.forEach((chunk) => (total += chunk.length));
  const input = new Float32Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    input.set(chunk, offset);
    offset += chunk.length;
  });
  const ratio = inputRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    samples[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (position: number, text: string) =>
    [...text].forEach((char, i) => view.setUint8(position + i, char.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return new Blob([buffer], { type: "audio/wav" });
}

export default function VoiceInput({
  apiRoot,
  headers,
  disabled = false,
  disabledReason = "",
  onText,
}: VoiceInputProps) {
  const [state, setState] = useState<State>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [needsConsent, setNeedsConsent] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<number | null>(null);
  const recognitionRef = useRef<DeviceRecognition | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const stoppedRef = useRef(false);
  const finishRef = useRef<(() => void) | null>(null);
  const headersRef = useRef(headers);
  headersRef.current = headers;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const canRecord =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    getAudioContextClass() !== null;
  const supported = canRecord || getDeviceRecognition() !== null;

  const cleanup = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (nodeRef.current) {
      nodeRef.current.onaudioprocess = null;
      nodeRef.current.disconnect();
      nodeRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
  };

  const stop = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    finishRef.current?.();
  };

  const transcribe = async (wav: Blob) => {
    setState("sending");
    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 45000);
    try {
      const { "Content-Type": _ignored, ...rest } = headersRef.current;
      const response = await fetch(`${apiRoot}/voice/transcribe`, {
        method: "POST",
        headers: { ...rest, "Content-Type": "audio/wav" },
        body: wav,
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.text !== "string") {
        throw new TranscribeError(
          result.error ?? `文字にできませんでした。（原因コード：${response.status}）`,
          response.status,
        );
      }
      onTextRef.current(result.text);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        if (timedOut) {
          setError("時間がかかりすぎました。もう一度「話して入力」を押してください。");
        }
        return;
      }
      const serverBusy =
        reason instanceof TranscribeError &&
        [429, 500, 502, 503, 504].includes(reason.status);
      if (serverBusy && getDeviceRecognition()) {
        deviceModeUntil = Date.now() + deviceFallbackMs;
        setError(
          "今回は、端末の機能で聞き取ります。もう一度「話して入力」を押して、話してください。",
        );
      } else {
        setError(
          reason instanceof TypeError
            ? "通信できませんでした。電波の良い場所でもう一度お試しください。"
            : reason instanceof Error
              ? reason.message
              : "文字にできませんでした。",
        );
      }
    } finally {
      window.clearTimeout(timeout);
      abortRef.current = null;
      setState("idle");
    }
  };

  // iPhoneでは、ボタンを押した直後（同じ操作の中）で音声を準備する必要がある
  const begin = async () => {
    setError("");
    const Context = getAudioContextClass();
    if (!Context) return;
    const context = new Context();
    contextRef.current = context;
    void context.resume().catch(() => undefined);
    cancelledRef.current = false;
    stoppedRef.current = false;
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      if (context.state !== "running") await context.resume().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      const node = context.createScriptProcessor(4096, 1, 1);
      nodeRef.current = node;
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);

      const startedAt = Date.now();
      let lastVoiceAt = 0;
      let peakNow = 0;
      node.onaudioprocess = (event) => {
        if (stoppedRef.current) return;
        const data = event.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(data));
        let peak = 0;
        for (let i = 0; i < data.length; i += 8) peak = Math.max(peak, Math.abs(data[i]));
        peakNow = Math.max(peakNow, peak);
        if (peak > speechLevel) lastVoiceAt = Date.now();
      };

      finishRef.current = () => {
        if (stoppedRef.current) return;
        stoppedRef.current = true;
        const rate = context.sampleRate;
        const chunks = chunksRef.current;
        cleanup();
        finishRef.current = null;
        if (cancelledRef.current) {
          setState("idle");
          return;
        }
        if (!chunks.length || peakNow < 0.005) {
          setState("idle");
          setError("声が録音できませんでした。マイクの近くで、もう一度話してください。");
          return;
        }
        void transcribe(encodeWav(chunks, rate));
      };

      setSeconds(0);
      setState("listening");
      timerRef.current = window.setInterval(() => {
        const now = Date.now();
        const elapsed = now - startedAt;
        setSeconds(Math.floor(elapsed / 1000));
        const heardVoice = lastVoiceAt > 0;
        if (
          elapsed >= maxSeconds * 1000 ||
          (heardVoice && now - lastVoiceAt > silenceStopMs) ||
          (!heardVoice && elapsed > noSpeechStopMs)
        ) {
          finishRef.current?.();
        }
      }, 250);
    } catch (reason) {
      cleanup();
      setState("idle");
      setError(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "マイクが許可されていません。端末またはブラウザの設定で、マイクを許可してください。"
          : "マイクを使えませんでした。他のアプリで使っていないか確認してください。",
      );
    }
  };

  // サーバーで文字にできないときに、端末の音声認識へ切り替えて聞き取る
  const beginDevice = () => {
    const Recognition = getDeviceRecognition();
    if (!Recognition) {
      setError("この端末では話して入力を使えません。キーボードのマイクボタンをお使いください。");
      return;
    }
    setError("");
    const recognition = new Recognition();
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognitionRef.current = recognition;
    cancelledRef.current = false;
    let gotText = false;
    let failed = false;
    const startedAt = Date.now();
    recognition.onresult = (event) => {
      const text = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join("")
        .trim();
      if (text) {
        gotText = true;
        onTextRef.current(text);
      }
    };
    recognition.onerror = (event) => {
      failed = true;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("マイクが許可されていません。端末またはブラウザの設定で、マイクを許可してください。");
      } else if (event.error === "no-speech") {
        setError("声が聞き取れませんでした。もう一度、はっきり話してください。");
      } else if (event.error !== "aborted") {
        setError("端末の機能でも聞き取れませんでした。キーボードのマイクボタンをお使いください。");
      }
    };
    recognition.onend = () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      recognitionRef.current = null;
      setState("idle");
      if (!gotText && !failed && !cancelledRef.current) {
        setError("声が聞き取れませんでした。もう一度、はっきり話してください。");
      }
    };
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setError("端末の機能を開始できませんでした。キーボードのマイクボタンをお使いください。");
      return;
    }
    setSeconds(0);
    setState("listening");
    timerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setSeconds(Math.floor(elapsed / 1000));
      if (elapsed >= maxSeconds * 1000) recognition.stop();
    }, 250);
  };

  const startListening = () => {
    if (Date.now() < deviceModeUntil || !canRecord) beginDevice();
    else void begin();
  };

  const press = () => {
    if (disabled) return;
    if (state === "listening") {
      stop();
      return;
    }
    if (state === "sending") return;
    if (localStorage.getItem(consentKey) !== "agreed") {
      setNeedsConsent(true);
      return;
    }
    startListening();
  };

  const cancel = () => {
    cancelledRef.current = true;
    if (recognitionRef.current) recognitionRef.current.abort();
    else finishRef.current?.();
  };

  useEffect(
    () => () => {
      cancelledRef.current = true;
      abortRef.current?.abort();
      recognitionRef.current?.abort();
      stoppedRef.current = true;
      cleanup();
    },
    [],
  );

  useEffect(() => {
    if (disabled && state === "listening") cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  if (!supported) {
    return (
      <p className="voice-input__hint">
        この端末では、話して入力を使えません。キーボードのマイクボタンをお使いください。
      </p>
    );
  }

  return (
    <div className="voice-input">
      <button
        aria-label={state === "listening" ? "話し終わったら押してください" : "話して入力する"}
        className={`voice-input__button ${state === "listening" ? "is-listening" : ""}`}
        disabled={disabled || state === "sending"}
        onClick={press}
        type="button"
      >
        {state === "listening"
          ? `⏹ 話し終わったら押す（${seconds}秒）`
          : state === "sending"
            ? "✍ 文字にしています…"
            : "🎤 話して入力"}
      </button>
      {state === "listening" && (
        <p className="voice-input__status" role="status">
          🔴 聞いています。ゆっくり話してください。
          <button className="voice-input__cancel" onClick={cancel} type="button">
            やめる
          </button>
        </p>
      )}
      {state === "sending" && (
        <p className="voice-input__status" role="status">
          少しお待ちください。
          <button
            className="voice-input__cancel"
            onClick={() => abortRef.current?.abort()}
            type="button"
          >
            やめる
          </button>
        </p>
      )}
      {disabled && disabledReason && (
        <p className="voice-input__hint">{disabledReason}</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {needsConsent && (
        <div className="dm-notice-backdrop">
          <section
            aria-labelledby="voice-input-consent"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <p className="dialog-eyebrow">話して入力について</p>
            <h2 id="voice-input-consent">声を文字にします</h2>
            <p className="dialog-note">
              話した声は、文字にするためにインターネット上のサービス（Google の AI、または端末・ブラウザの音声認識）へ送られます。声は、このアプリには保存されません。文字は送信前に確認して直せます。
            </p>
            <div className="dialog-actions">
              <button
                className="dialog-button dialog-button--back"
                onClick={() => setNeedsConsent(false)}
              >
                やめる
              </button>
              <button
                className="dialog-button dialog-button--send"
                onClick={() => {
                  localStorage.setItem(consentKey, "agreed");
                  setNeedsConsent(false);
                  startListening();
                }}
              >
                同意して使う
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
