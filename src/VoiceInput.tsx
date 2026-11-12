import { MutableRefObject, useEffect, useRef, useState } from "react";
import { isAndroidDevice } from "./voiceJoin";

type VoiceInputProps = {
  apiRoot: string;
  headers: Record<string, string>;
  disabled?: boolean;
  disabledReason?: string;
  onText: (text: string) => void;
  autoStart?: boolean;
  onListeningStart?: () => void;
  onStatusChange?: (status: State, error: string) => void;
  cancelSignal?: number;
  /** 視覚サポートの返事だけ。「終わり」まで切らずに聞く */
  holdForEnd?: boolean;
  onCue?: (done: () => void) => void;
  startRef?: MutableRefObject<(() => void) | null>;
  restartSignal?: number;
};

type State = "idle" | "starting" | "listening" | "sending";

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
    | ((event: {
        results: ArrayLike<{
          isFinal?: boolean;
          0?: { transcript?: string };
        }>;
      }) => void)
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

function foldKana(value: string) {
  return value.replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

export function finishedReply(text: string) {
  const compact = foldKana(text.normalize("NFKC")).replace(/[\s　]/g, "");
  const match = compact.match(
    /^(.*?)(終わりです|おわりです|終わり|おわり)[。.!！ねよ]?$/,
  );
  if (!match) return { done: false, body: text.trim() };
  return {
    done: true,
    body: match[1].replace(/[。、．.!！?？]+$/g, "").trim(),
  };
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
  autoStart = false,
  onListeningStart,
  onStatusChange,
  cancelSignal = 0,
  holdForEnd = false,
  onCue,
  startRef,
  restartSignal = 0,
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
  const onListeningStartRef = useRef(onListeningStart);
  onListeningStartRef.current = onListeningStart;
  const autoStartConsumedRef = useRef(false);
  const lastCancelSignalRef = useRef(cancelSignal);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onCueRef = useRef(onCue);
  onCueRef.current = onCue;
  const holdForEndRef = useRef(holdForEnd);
  holdForEndRef.current = holdForEnd;
  const heardRef = useRef("");
  const deliveredRef = useRef(false);
  const lastRestartRef = useRef(0);
  const generationRef = useRef(0);

  useEffect(() => {
    onStatusChangeRef.current?.(state, error);
  }, [state, error]);

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
      if (cancelledRef.current) return;
      if (!response.ok || typeof result.text !== "string") {
        throw new TranscribeError(
          result.error ?? `文字にできませんでした。（原因コード：${response.status}）`,
          response.status,
        );
      }
      if (!result.text.trim()) {
        setError("声が聞き取れませんでした。もう一度、はっきり話してください。");
        return;
      }
      onTextRef.current(result.text.trim());
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
    const generation = ++generationRef.current;
    setError("");
    const Context = getAudioContextClass();
    if (!Context) return;
    let context: AudioContext;
    try {
      context = new Context();
    } catch (reason) {
      console.error("音声入力の準備に失敗しました", reason);
      setError("音声入力を準備できませんでした。もう一度お試しください。");
      return;
    }
    contextRef.current = context;
    void context.resume().catch((reason) =>
      console.error("音声入力の準備を再試行します", reason),
    );
    cancelledRef.current = false;
    stoppedRef.current = false;
    chunksRef.current = [];
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      if (cancelledRef.current) {
        cleanup();
        setState("idle");
        return;
      }
      if (context.state !== "running") await context.resume();
      if (cancelledRef.current) {
        cleanup();
        setState("idle");
        return;
      }
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
        if (cancelledRef.current || generation !== generationRef.current) {
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
          (!holdForEndRef.current &&
            heardVoice &&
            now - lastVoiceAt > silenceStopMs) ||
          (!holdForEndRef.current && !heardVoice && elapsed > noSpeechStopMs)
        ) {
          finishRef.current?.();
        }
      }, 250);
    } catch (reason) {
      cleanup();
      setState("idle");
      if (cancelledRef.current) return;
      console.error("マイクを開始できませんでした", reason);
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
    const generation = ++generationRef.current;
    const recognition = new Recognition();
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognitionRef.current = recognition;
    cancelledRef.current = false;
    let recognizedText = "";
    let failed = false;
    const startedAt = Date.now();
    recognition.onresult = (event) => {
      if (generation !== generationRef.current || cancelledRef.current) return;
      const text = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join("")
        .trim();
      if (text) recognizedText = text;
    };
    recognition.onerror = (event) => {
      if (generation !== generationRef.current || cancelledRef.current) return;
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
      if (generation !== generationRef.current) return;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      recognitionRef.current = null;
      setState("idle");
      if (recognizedText && !failed && !cancelledRef.current) {
        onTextRef.current(recognizedText);
      } else if (!failed && !cancelledRef.current) {
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

  const deliverHeld = (body: string) => {
    if (deliveredRef.current) return;
    deliveredRef.current = true;
    stoppedRef.current = true;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try {
      recognition?.stop();
    } catch {
      recognition?.abort();
    }
    setState("idle");
    onTextRef.current(body);
  };

  const beginUntilEnd = (session: number, deferMic = false) => {
    const Recognition = getDeviceRecognition();
    if (!Recognition) {
      void begin();
      return;
    }
    setError("");
    cancelledRef.current = false;
    stoppedRef.current = false;
    deliveredRef.current = false;
    heardRef.current = "";
    const generation = ++generationRef.current;
    const recognition = new Recognition();
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognitionRef.current = recognition;
    const startedAt = Date.now();
    let carried = "";
    let utterance = "";
    let captureErrors = 0;
    let ready = false;
    let rearming = false;
    const readResults = (
      results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }>,
    ) => {
      let finals = "";
      let interim = "";
      for (let index = 0; index < results.length; index += 1) {
        const piece = results[index]?.[0]?.transcript ?? "";
        if (results[index]?.isFinal) finals += piece;
        else interim += piece;
      }
      return { finals: finals.trim(), interim: interim.trim() };
    };
    recognition.onresult = (event) => {
      if (!ready || generation !== generationRef.current || cancelledRef.current || deliveredRef.current) return;
      const spoken = readResults(event.results);
      utterance = `${spoken.finals}${spoken.interim}`.trim();
      const combined = `${carried}${utterance}`.trim();
      if (!combined) return;
      heardRef.current = combined;
      const finished = finishedReply(combined);
      if (finished.done) deliverHeld(finished.body);
    };
    recognition.onerror = (event) => {
      if (cancelledRef.current || deliveredRef.current) return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        deliveredRef.current = true;
        setState("idle");
        setError("マイクが許可されていません。端末またはブラウザの設定で、マイクを許可してください。");
        return;
      }
      if (event.error === "audio-capture") captureErrors += 1;
      if (captureErrors >= 3) {
        deliveredRef.current = true;
        setState("idle");
        setError("声が聞き取れませんでした。もう一度、緑のボタンを押して話してください。");
      }
    };
    const restart = () => {
      if (Date.now() - startedAt >= maxSeconds * 1000) {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        recognitionRef.current = null;
        const finished = finishedReply(heardRef.current);
        if (heardRef.current.trim()) deliverHeld(finished.body);
        else {
          deliveredRef.current = true;
          setState("idle");
          setError("声が聞き取れませんでした。もう一度、緑のボタンを押して話してください。");
        }
        return;
      }
      if (utterance) {
        carried = `${carried}${utterance}`.trim();
        heardRef.current = carried;
        utterance = "";
      }
      window.setTimeout(() => {
        if (
          generation !== generationRef.current ||
          cancelledRef.current ||
          deliveredRef.current ||
          !holdForEndRef.current ||
          recognitionRef.current !== recognition
        ) {
          return;
        }
        try {
          recognition.start();
        } catch {
          recognitionRef.current = null;
          setState("idle");
          if (!heardRef.current) {
            setError("声が聞き取れませんでした。もう一度、緑のボタンを押して話してください。");
          }
        }
      }, 250);
    };
    recognition.onend = () => {
      if (generation !== generationRef.current || rearming) return;
      if (!ready) return;
      if (deliveredRef.current || cancelledRef.current || !holdForEndRef.current) {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        if (!deliveredRef.current) setState("idle");
        return;
      }
      restart();
    };
    const arm = () => {
      if (
        session !== sessionRef.current ||
        generation !== generationRef.current ||
        cancelledRef.current
      ) {
        return;
      }
      ready = true;
      carried = "";
      utterance = "";
      heardRef.current = "";
      rearming = true;
      try {
        recognition.abort();
      } catch {
        rearming = false;
      }
      window.setTimeout(() => {
        rearming = false;
        if (
          session !== sessionRef.current ||
          generation !== generationRef.current ||
          cancelledRef.current ||
          deliveredRef.current ||
          !holdForEndRef.current
        ) {
          return;
        }
        try {
          recognition.start();
          setState("listening");
        } catch {
          recognitionRef.current = null;
          setState("idle");
          setError("声が聞き取れませんでした。もう一度、緑のボタンを押して話してください。");
        }
      }, 300);
    };
    try {
      if (!deferMic) recognition.start();
    } catch {
      // 「どうぞ」のあとで開始する
    }
    setSeconds(0);
    setState(deferMic ? "starting" : "listening");
    if (onCueRef.current) onCueRef.current(arm);
    else arm();
    timerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setSeconds(Math.floor(elapsed / 1000));
      if (elapsed < maxSeconds * 1000 || deliveredRef.current) return;
      const finished = finishedReply(heardRef.current);
      if (heardRef.current.trim()) deliverHeld(finished.body);
      else {
        deliveredRef.current = true;
        recognition.stop();
        setState("idle");
        setError("声が聞き取れませんでした。もう一度、緑のボタンを押して話してください。");
      }
    }, 250);
  };

  const sessionRef = useRef(0);
  const startAssisted = (force = false, deferMic = false) => {
    if (disabled) return;
    if (
      !force &&
      (state === "listening" || state === "starting" || state === "sending")
    ) {
      return;
    }
    if (localStorage.getItem(consentKey) !== "agreed") {
      setNeedsConsent(true);
      return;
    }
    const session = ++sessionRef.current;
    generationRef.current += 1;
    cancelledRef.current = true;
    deliveredRef.current = false;
    heardRef.current = "";
    const previous = recognitionRef.current;
    recognitionRef.current = null;
    try {
      previous?.abort();
    } catch {
      // already stopped
    }
    cleanup();
    cancelledRef.current = false;
    onListeningStartRef.current?.();
    setError("");
    setState("starting");
    beginUntilEnd(session, deferMic);
  };

  const finishHeld = () => {
    if (recognitionRef.current) {
      const finished = finishedReply(heardRef.current);
      if (!heardRef.current.trim()) {
        deliveredRef.current = true;
        sessionRef.current += 1;
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        recognitionRef.current.abort();
        recognitionRef.current = null;
        setState("idle");
        setError("声が聞き取れませんでした。もう一度、緑のボタンを押して話してください。");
        return;
      }
      deliverHeld(finished.body);
      return;
    }
    finishRef.current?.();
  };

  const startListening = () => {
    onListeningStartRef.current?.();
    if (Date.now() < deviceModeUntil || !canRecord) beginDevice();
    else void begin();
  };

  useEffect(() => {
    if (!autoStart || holdForEnd) {
      autoStartConsumedRef.current = false;
      return;
    }
    if (disabled || state !== "idle" || autoStartConsumedRef.current) return;
    autoStartConsumedRef.current = true;
    if (localStorage.getItem(consentKey) !== "agreed") {
      setNeedsConsent(true);
      return;
    }
    startListening();
  }, [autoStart, disabled, state, holdForEnd]);

  const press = () => {
    if (disabled) return;
    if (state === "listening") {
      if (holdForEndRef.current) finishHeld();
      else stop();
      return;
    }
    if (state === "sending") return;
    if (
      holdForEndRef.current &&
      heardRef.current.trim() &&
      !deliveredRef.current
    ) {
      deliverHeld(finishedReply(heardRef.current).body);
      return;
    }
    if (localStorage.getItem(consentKey) !== "agreed") {
      setNeedsConsent(true);
      return;
    }
    if (holdForEndRef.current) startAssisted();
    else startListening();
  };
  if (startRef) {
    startRef.current = () => {
      if (holdForEndRef.current) startAssisted(true);
    };
  }

  useEffect(() => {
    if (!holdForEnd || restartSignal === 0) return;
    if (lastRestartRef.current === restartSignal) return;
    lastRestartRef.current = restartSignal;
    startAssisted(true, true);
  }, [restartSignal, holdForEnd]);

  useEffect(() => {
    return () => {
      if (startRef) startRef.current = null;
    };
  }, [startRef]);

  const cancel = () => {
    cancelledRef.current = true;
    sessionRef.current += 1;
    if (abortRef.current) abortRef.current.abort();
    if (recognitionRef.current) recognitionRef.current.abort();
    else finishRef.current?.();
  };

  useEffect(() => {
    if (lastCancelSignalRef.current === cancelSignal) return;
    lastCancelSignalRef.current = cancelSignal;
    cancel();
  }, [cancelSignal]);

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
    if (disabled && state !== "idle") cancel();
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
        aria-label={
          state === "listening"
            ? holdForEnd
              ? "終わりと言うか、もう一度押してください"
              : "話し終わったら押してください"
            : "話して入力する"
        }
        className={`voice-input__button ${state === "listening" ? "is-listening" : ""}`}
        disabled={disabled || state === "sending" || state === "starting"}
        onClick={press}
        type="button"
      >
        {state === "listening"
          ? holdForEnd
            ? `終わり、と言う（${seconds}秒）`
            : `⏹ 話し終わったら押す（${seconds}秒）`
          : state === "starting"
            ? "🎤 マイクを準備しています…"
          : state === "sending"
            ? "✍ 文字にしています…"
            : "🎤 話して入力"}
      </button>
      {(state === "starting" || state === "listening") && (
        <p className="voice-input__status" role="status">
          {state === "starting"
            ? "マイクの準備をしています。"
            : holdForEnd
              ? isAndroidDevice()
                ? "聞いています。ピーッと鳴ってから、終わり、と言ってください。"
                : "聞いています。終わったら、終わり、と言ってください。"
              : "🔴 聞いています。ゆっくり話してください。"}
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
            onClick={cancel}
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
                  if (holdForEnd) startAssisted(true);
                  else startListening();
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
