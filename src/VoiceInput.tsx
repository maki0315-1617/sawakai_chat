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
const speechLevel = 0.03;
const consentKey = "sawakai-voice-input-consent";

function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) =>
    [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return new Blob([buffer], { type: "audio/wav" });
}

// 録音形式は端末ごとに違うため、全端末共通の16kHzモノラルWAVに変換する
async function toWav(blob: Blob) {
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Context) throw new Error("この端末では録音を変換できません。");
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const sampleRate = 16000;
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * sampleRate)),
      sampleRate,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), sampleRate);
  } finally {
    void context.close().catch(() => undefined);
  }
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? "";
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

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const cancelledRef = useRef(false);
  const headersRef = useRef(headers);
  headersRef.current = headers;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const supported =
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  const cleanup = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
  };

  const stop = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  const transcribe = async (blob: Blob) => {
    setState("sending");
    try {
      const wav = await toWav(blob).catch(() => {
        throw new Error("録音を処理できませんでした。もう一度話してください。");
      });
      const { "Content-Type": _ignored, ...rest } = headersRef.current;
      const response = await fetch(`${apiRoot}/voice/transcribe`, {
        method: "POST",
        headers: { ...rest, "Content-Type": "audio/wav" },
        body: wav,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.text !== "string") {
        throw new Error(result.error ?? "文字にできませんでした。");
      }
      onTextRef.current(result.text);
    } catch (reason) {
      setError(
        reason instanceof TypeError
          ? "通信できませんでした。電波の良い場所でもう一度お試しください。"
          : reason instanceof Error
            ? reason.message
            : "文字にできませんでした。",
      );
    } finally {
      setState("idle");
    }
  };

  const begin = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined,
      );
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        cleanup();
        if (cancelledRef.current) {
          setState("idle");
          return;
        }
        void transcribe(blob);
      };

      // 話し終わりを検出して自動で止める
      const Context =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      const startedAt = Date.now();
      let lastVoiceAt = 0;
      let analyser: AnalyserNode | null = null;
      if (Context) {
        const context = new Context();
        contextRef.current = context;
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
      }
      const buffer = new Uint8Array(analyser?.fftSize ?? 0);
      recorder.start(1000);
      setSeconds(0);
      setState("listening");
      timerRef.current = window.setInterval(() => {
        const now = Date.now();
        const elapsed = now - startedAt;
        setSeconds(Math.floor(elapsed / 1000));
        if (analyser) {
          analyser.getByteTimeDomainData(buffer);
          let peak = 0;
          for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128) / 128);
          if (peak > speechLevel) lastVoiceAt = now;
        }
        const heardVoice = lastVoiceAt > 0;
        if (
          elapsed >= maxSeconds * 1000 ||
          (analyser &&
            ((heardVoice && now - lastVoiceAt > silenceStopMs) ||
              (!heardVoice && elapsed > noSpeechStopMs)))
        ) {
          stop();
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
    void begin();
  };

  const cancel = () => {
    cancelledRef.current = true;
    stop();
  };

  useEffect(
    () => () => {
      cancelledRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
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
              話した声は、文字にするためにインターネット上のサービスへ送られます。声は保存されません。文字は送信前に確認して直せます。
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
                  void begin();
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
