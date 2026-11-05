type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type VoiceFailure = "unsupported" | "denied" | "no-speech" | "failed";

export class VoiceError extends Error {
  reason: VoiceFailure;
  constructor(reason: VoiceFailure) {
    super(reason);
    this.reason = reason;
  }
}

function getRecognitionClass(): (new () => Recognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceSupported() {
  return getRecognitionClass() !== null;
}

function speak(text: string) {
  return new Promise<void>((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = 0.9;
    const timer = window.setTimeout(resolve, 8000);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    utterance.onend = done;
    utterance.onerror = done;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

function beep() {
  return new Promise<void>((resolve) => {
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return resolve();
      const context = new Ctx();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.15;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      window.setTimeout(() => {
        oscillator.stop();
        void context.close();
        resolve();
      }, 250);
    } catch {
      resolve();
    }
  });
}

export type VoiceSession = { cancel: () => void };

/** 案内を読み上げ → 「ピッ」→ 聞き取り。読み上げ終了後に聞き取るので案内音声は拾いません。 */
export function listenOnce(
  prompt: string,
  handlers: {
    onListening: () => void;
    onResult: (text: string) => void;
    onError: (reason: VoiceFailure) => void;
  },
): VoiceSession {
  let cancelled = false;
  let recognition: Recognition | null = null;

  const run = async () => {
    const Recognition = getRecognitionClass();
    if (!Recognition) return handlers.onError("unsupported");
    await speak(prompt);
    if (cancelled) return;
    await beep();
    if (cancelled) return;

    recognition = new Recognition();
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = false;
    let got = false;
    let failure: VoiceFailure | null = null;
    const silenceTimer = window.setTimeout(() => recognition?.stop(), 10000);

    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript ?? "";
      if (text.trim()) {
        got = true;
        handlers.onResult(text);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        failure = "denied";
      } else if (event.error === "no-speech" || event.error === "aborted") {
        failure = "no-speech";
      } else {
        failure = "failed";
      }
    };
    recognition.onend = () => {
      window.clearTimeout(silenceTimer);
      if (cancelled || got) return;
      handlers.onError(failure ?? "no-speech");
    };
    try {
      recognition.start();
      handlers.onListening();
    } catch {
      window.clearTimeout(silenceTimer);
      handlers.onError("failed");
    }
  };
  void run();

  return {
    cancel() {
      cancelled = true;
      window.speechSynthesis?.cancel();
      try {
        recognition?.abort();
      } catch {
        // already stopped
      }
    },
  };
}

export function failureMessage(reason: VoiceFailure) {
  switch (reason) {
    case "unsupported":
      return "この端末では声の入力が使えません。キーボードで入力してください。";
    case "denied":
      return "マイクの使用が許可されていません。キーボードで入力するか、マイクを許可してください。";
    case "no-speech":
      return "声が聞き取れませんでした。もう一度お話しいただくか、キーボードで入力してください。";
    default:
      return "うまく聞き取れませんでした。もう一度お試しいただくか、キーボードで入力してください。";
  }
}

const letterReadings: [string, string][] = [
  ["ダブリュー", "W"], ["エックス", "X"], ["ゼット", "Z"], ["エイチ", "H"],
  ["ジェー", "J"], ["ジェイ", "J"], ["キュー", "Q"], ["アール", "R"],
  ["ディー", "D"], ["ティー", "T"], ["ビー", "B"], ["シー", "C"],
  ["イー", "E"], ["エフ", "F"], ["ジー", "G"], ["ケー", "K"], ["エル", "L"],
  ["エム", "M"], ["エヌ", "N"], ["ピー", "P"], ["エス", "S"], ["ユー", "U"],
  ["ブイ", "V"], ["ワイ", "Y"], ["エー", "A"], ["アイ", "I"], ["オー", "O"],
];
const digitReadings: [string, string][] = [
  ["ゼロ", "0"], ["ナナ", "7"], ["シチ", "7"], ["ロク", "6"], ["ハチ", "8"],
  ["キュウ", "9"], ["サン", "3"], ["ヨン", "4"], ["イチ", "1"], ["ニ", "2"],
  ["ゴ", "5"], ["ク", "9"],
];

function toKatakana(text: string) {
  return text.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60),
  );
}

/** 「123ABC」「いちにさんエービーシー」などを招待コードの形に整えます。 */
export function normalizeInviteCode(raw: string) {
  let text = toKatakana(raw.normalize("NFKC"));
  text = text.replace(/[一二三四五六七八九〇]/g, (ch) =>
    String("〇一二三四五六七八九".indexOf(ch)),
  );
  for (const [reading, value] of [...letterReadings, ...digitReadings]) {
    text = text.split(reading).join(value);
  }
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

/** 「ゆきです」「私はゆきと申します」から名前だけを取り出します。 */
export function normalizeName(raw: string) {
  return raw
    .normalize("NFKC")
    .trim()
    .replace(/^(わたし|私|僕|ぼく|俺|おれ)(の名前)?は/, "")
    .replace(/^名前は/, "")
    .replace(/(と申します|といいます|と言います|です|でございます|だよ|です。?)$/, "")
    .replace(/[。、.,!！?？\s]+$/g, "")
    .trim()
    .slice(0, 12);
}
