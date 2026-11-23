type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onstart: (() => void) | null;
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

let desktopMicPrimed = false;
let desktopMicPriming = false;

function releaseDesktopMic(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

// Windows の Chrome は、ボタンを押した直後以外で音声認識を始めると
// 許可もマイク表示も出さない。押した瞬間に一度だけ開いて閉じておく。
export function primeDesktopMicrophone() {
  if (desktopMicPrimed || desktopMicPriming || !isDesktopDevice()) return;
  const RecognitionClass = getRecognitionClass();
  if (!RecognitionClass) {
    desktopMicPriming = true;
    void navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        desktopMicPrimed = true;
        releaseDesktopMic(stream);
      })
      .catch(() => undefined)
      .finally(() => {
        desktopMicPriming = false;
      });
    return;
  }
  desktopMicPriming = true;
  try {
    const recognition = new RecognitionClass();
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = () => undefined;
    recognition.onstart = () => {
      desktopMicPrimed = true;
      try {
        recognition.abort();
      } catch {
        // 許可の確認が終わったので、案内を聞く前に止める
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        desktopMicPrimed = false;
      }
    };
    recognition.onend = () => {
      desktopMicPriming = false;
    };
    recognition.start();
    window.setTimeout(() => {
      if (!desktopMicPrimed) desktopMicPriming = false;
    }, 5000);
  } catch {
    desktopMicPriming = false;
    void navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        desktopMicPrimed = true;
        releaseDesktopMic(stream);
      })
      .catch(() => undefined);
  }
}

export function isIphoneDevice() {
  return /iPhone|iPod/i.test(navigator.userAgent);
}

export function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent);
}

export function isDesktopDevice() {
  if (typeof navigator === "undefined") return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return false;
  const touch = navigator as Navigator & { maxTouchPoints?: number };
  if (navigator.platform === "MacIntel" && (touch.maxTouchPoints ?? 0) > 1) return false;
  return true;
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
  listenMs = 10000,
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
    const silenceTimer = window.setTimeout(() => recognition?.stop(), listenMs);

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

/** 読み上げなしで短時間だけ聞きます。グループ通話の合い言葉用です。 */
export function listenQuiet(
  handlers: {
    onResult: (text: string) => void;
    onError: (reason: VoiceFailure) => void;
  },
  listenMs = 8000,
): VoiceSession {
  const Recognition = getRecognitionClass();
  if (!Recognition) {
    handlers.onError("unsupported");
    return { cancel() {} };
  }
  let cancelled = false;
  const recognition = new Recognition();
  recognition.lang = "ja-JP";
  recognition.continuous = false;
  recognition.interimResults = false;
  let got = false;
  let failure: VoiceFailure | null = null;
  const silenceTimer = window.setTimeout(() => {
    try {
      recognition.stop();
    } catch {
      // already stopped
    }
  }, listenMs);
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
  } catch {
    window.clearTimeout(silenceTimer);
    handlers.onError("failed");
  }
  return {
    cancel() {
      cancelled = true;
      window.clearTimeout(silenceTimer);
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
    },
  };
}

function normalizeSpeech(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(/[\s。、.,！!？?]/g, "")
    .toLowerCase();
}

/** 「はい」「ハイ」などを、電話に出る・かける返事として扱います。 */
export function isSpokenYes(text: string) {
  const value = normalizeSpeech(text);
  if (/いいえ|いえ|やめる|やめ|出ない|出ません|かけない|かけません/.test(value)) return false;
  return /はい|ええ|うん|yes|hai/.test(value);
}

/** 着信は「出ます」または「はい」だけで出ます。案内文や「出ない」では出ません。 */
export function isSpokenAnswer(text: string) {
  const value = normalizeSpeech(text);
  if (/出ない|出ません|出ねえ|いいえ/.test(value)) return false;
  if (/または|と言う|というと|押す|右|左|電話/.test(value)) return false;
  if (value.length > 12) return false;
  return /はい|出ます|でます|出る|でる/.test(value);
}

/** 1対1で相手を選ぶとき、左のボタンと同じ「次へ」です。案内文そのものは除きます。 */
export function isSpokenNext(text: string) {
  const value = normalizeSpeech(text);
  if (/と言う|というと|または/.test(value)) return false;
  if (value.length > 10) return false;
  return /次へ|つぎへ|次の人|つぎの人/.test(value);
}

/** 相手を順に呼んでいるとき、「終わる」「終わり」「終了」で呼び出しを閉じます。 */
export function isSpokenStop(text: string) {
  const value = normalizeSpeech(text);
  if (/終わらない|終わりません|おわらない|おわりません|終了しない|終了しません|しゅうりょうしない/.test(value)) {
    return false;
  }
  if (/と言う|というと|または/.test(value)) return false;
  return /終わる|終わって|終わり|おわる|おわって|おわり|終了|しゅうりょう/.test(value);
}

/** 相手を選んでいるとき、「はい」または「かける」で呼び出します。案内文そのものは除きます。 */
export function isSpokenPlaceCall(text: string) {
  const value = normalizeSpeech(text);
  if (/かけない|かけません|かけねえ|いいえ|やめる|やめ/.test(value)) return false;
  if (/と言う|というと|または|呼び出|次へ|つぎ|終わる|終わり|おわる|おわり|押す/.test(value)) return false;
  if (value.length > 10) return false;
  return /はい|かける|かけます/.test(value);
}

export type StartupChoice = "group" | "phone" | "chat" | "close";

/** 起動案内のあとだけ。「グループ」「電話」「チャット」「閉じる」「終わる」の短い発話です。 */
export function startupChoice(text: string): StartupChoice | null {
  const value = normalizeSpeech(text).replace(/(です|だよ|だね|だ)$/, "");
  if (!value || value.length > 12) return null;
  if (
    /ボタン|押す|言って|または|初期|起動|画面|一番|緑|青|右|左|来たら|終了する|ください|下さい|どうぞ/.test(
      value,
    )
  ) {
    return null;
  }
  if (/^(閉じる|とじる|終わる|おわる)$/.test(value)) return "close";
  if (/^(グループ|ぐるーぷ)$/.test(value)) return "group";
  if (/^(電話|でんわ)$/.test(value)) return "phone";
  if (/^(チャット|ちゃっと)$/.test(value)) return "chat";
  return null;
}

/** 起動直後の音声チャット開始。「話す」または「チャット」だけを受けます。 */
export function isSpokenChatStart(text: string) {
  const value = normalizeSpeech(text);
  if (
    /話さない|はなさない|チャットしない|ちゃっとしない|言って|または|ボタン|押す|電話がありました/.test(
      value,
    )
  ) {
    return false;
  }
  if (value.length > 20) return false;
  return /話す|はなす|チャット|ちゃっと/.test(value);
}

/** タップの直後に一度だけ開いて閉じ、案内のあとでもマイクを使えるようにします。 */
export function unlockSpeechRecognition() {
  const RecognitionClass = getRecognitionClass();
  if (!RecognitionClass) return;
  try {
    const recognition = new RecognitionClass();
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = () => undefined;
    recognition.onerror = () => undefined;
    recognition.onend = () => undefined;
    recognition.onstart = () => {
      try {
        recognition.abort();
      } catch {
        // 許可だけ確認して、案内のあいだはマイクを止める
      }
    };
    recognition.start();
  } catch {
    // この端末では、案内のあとの画面タップでチャットを開く
  }
}

export function listenForChatStart(handlers: {
  gate: () => boolean;
  onMatch: () => void;
}): { stop: () => void } {
  const RecognitionClass = getRecognitionClass();
  if (!RecognitionClass) return { stop() {} };
  let stopped = false;
  let current: Recognition | null = null;
  const start = () => {
    if (stopped) return;
    const recognition = new RecognitionClass();
    current = recognition;
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (stopped || !handlers.gate()) return;
      const rich = event as unknown as {
        resultIndex?: number;
        results: ArrayLike<
          ArrayLike<{ transcript: string }> & { isFinal?: boolean }
        >;
      };
      const from = rich.resultIndex ?? 0;
      for (let index = from; index < rich.results.length; index += 1) {
        const row = rich.results[index];
        if (!row?.isFinal) continue;
        const text = row[0]?.transcript ?? "";
        if (!isSpokenChatStart(text)) continue;
        stopped = true;
        try {
          recognition.abort();
        } catch {
          // already stopped
        }
        handlers.onMatch();
        return;
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        stopped = true;
      }
    };
    recognition.onend = () => {
      if (stopped) return;
      window.setTimeout(start, 400);
    };
    try {
      recognition.start();
    } catch {
      // 案内のあとの開始ができない端末は、画面タップで開く
    }
  };
  start();
  return {
    stop() {
      stopped = true;
      try {
        current?.abort();
      } catch {
        // already stopped
      }
    },
  };
}

/**
 * Androidは、同じ認識を止めて開き直すとマイクが戻らない。
 * 案内のあとは新しい認識を、区切らずに聞き続ける。
 */
function listenAndroidStartup(handlers: {
  onMatch: (text?: string) => void;
  onFailed: () => void;
  onUnrecognized?: () => void;
  accept?: (text: string) => boolean;
}): { stop: () => void; prime: () => void; arm: () => void; listenNow: () => void } {
  const RecognitionClass = getRecognitionClass();
  const noop = { stop() {}, prime() {}, arm() {}, listenNow() {} };
  if (!RecognitionClass) {
    return {
      ...noop,
      arm() {
        handlers.onFailed();
      },
      listenNow() {
        handlers.onFailed();
      },
    };
  }
  const acceptText = (text: string) =>
    handlers.accept ? handlers.accept(text) : isSpokenChatStart(text);
  let stopped = false;
  let matched = false;
  let ready = false;
  let generation = 0;
  let current: Recognition | null = null;
  const start = () => {
    if (stopped || matched || !ready) return;
    const token = ++generation;
    const recognition = new RecognitionClass();
    current = recognition;
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (token !== generation || !ready || stopped || matched) return;
      const results = event.results as ArrayLike<
        ArrayLike<{ transcript: string }> & { isFinal?: boolean }
      >;
      const latest = results[results.length - 1];
      const text = latest?.[0]?.transcript ?? "";
      if (!text.trim()) return;
      if (acceptText(text)) {
        matched = true;
        ready = false;
        generation += 1;
        try {
          recognition.abort();
        } catch {
          // already stopped
        }
        handlers.onMatch(text);
        return;
      }
      if (!handlers.onUnrecognized || !latest?.isFinal) return;
      ready = false;
      generation += 1;
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
      handlers.onUnrecognized();
    };
    recognition.onerror = (event) => {
      if (token !== generation || stopped || matched) return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        stopped = true;
        ready = false;
        handlers.onFailed();
      }
    };
    recognition.onend = () => {
      if (token !== generation || stopped || matched || !ready) return;
      window.setTimeout(() => {
        if (token !== generation || stopped || matched || !ready) return;
        start();
      }, 300);
    };
    try {
      recognition.start();
    } catch {
      window.setTimeout(() => {
        if (token !== generation || stopped || matched || !ready) return;
        start();
      }, 400);
    }
  };
  const primeOnce = () => {
    if (stopped || matched) return;
    try {
      const recognition = new RecognitionClass();
      current = recognition;
      recognition.lang = "ja-JP";
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onresult = () => undefined;
      recognition.onerror = () => undefined;
      recognition.onend = () => undefined;
      recognition.onstart = () => {
        try {
          recognition.abort();
        } catch {
          // 許可だけ確認して、案内のあいだは結果を使わない
        }
      };
      recognition.start();
    } catch {
      // 案内のあと、arm でもう一度開く
    }
  };
  return {
    stop() {
      stopped = true;
      ready = false;
      generation += 1;
      try {
        current?.abort();
      } catch {
        // already stopped
      }
    },
    prime() {
      primeOnce();
    },
    arm() {
      if (stopped || matched) return;
      ready = true;
      generation += 1;
      try {
        current?.abort();
      } catch {
        // already stopped
      }
      window.setTimeout(start, 300);
    },
    listenNow() {
      if (stopped || matched) return;
      ready = true;
      generation += 1;
      try {
        current?.abort();
      } catch {
        // already stopped
      }
      start();
    },
  };
}

/**
 * iPhoneの初期画面です。タップの中で開いたマイクは、案内のあとで止めません。
 * 止まっていたときだけ開き直し、開けなければもう一度タップしてもらいます。
 * 「グループ」などの短い言葉は、確定前でも受けます。
 */
function listenIphoneStartup(handlers: {
  onMatch: (text?: string) => void;
  onFailed: () => void;
  onUnrecognized?: () => void;
  accept?: (text: string) => boolean;
}): { stop: () => void; prime: () => void; arm: () => void; listenNow: () => void } {
  const RecognitionClass = getRecognitionClass();
  const noop = { stop() {}, prime() {}, arm() {}, listenNow() {} };
  if (!RecognitionClass) {
    return {
      ...noop,
      arm() {
        handlers.onFailed();
      },
      listenNow() {
        handlers.onFailed();
      },
    };
  }
  const acceptText = (text: string) =>
    handlers.accept ? handlers.accept(text) : isSpokenChatStart(text);
  let stopped = false;
  let matched = false;
  let ready = false;
  let live = false;
  let failed = false;
  let current: Recognition | null = null;
  let watch = 0;
  let readyAt = 0;
  const fail = () => {
    if (stopped || matched || failed) return;
    failed = true;
    ready = false;
    window.clearTimeout(watch);
    try {
      current?.abort();
    } catch {
      // already stopped
    }
    handlers.onFailed();
  };
  const start = () => {
    if (stopped || matched || live) return;
    const recognition = new RecognitionClass();
    current = recognition;
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (current !== recognition) return;
      live = true;
      window.clearTimeout(watch);
    };
    recognition.onresult = (event) => {
      if (!ready || stopped || matched || current !== recognition) return;
      if (Date.now() - readyAt < 300) return;
      const results = event.results as ArrayLike<
        ArrayLike<{ transcript: string }> & { isFinal?: boolean }
      >;
      const latest = results[results.length - 1];
      const text = latest?.[0]?.transcript ?? "";
      if (!text.trim()) return;
      if (acceptText(text)) {
        matched = true;
        ready = false;
        live = false;
        try {
          recognition.abort();
        } catch {
          // already stopped
        }
        handlers.onMatch(text);
        return;
      }
      if (!handlers.onUnrecognized || !latest?.isFinal) return;
      ready = false;
      live = false;
      current = null;
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
      handlers.onUnrecognized();
    };
    recognition.onerror = (event) => {
      if (current !== recognition || stopped || matched) return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        fail();
      }
    };
    recognition.onend = () => {
      if (current !== recognition) return;
      live = false;
      if (stopped || matched || !ready || failed) return;
      window.setTimeout(() => {
        if (stopped || matched || !ready || failed || live) return;
        try {
          start();
        } catch {
          fail();
        }
      }, 300);
    };
    try {
      recognition.start();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "InvalidStateError") return;
      if (ready) fail();
    }
  };
  const holdMic = () => {
    try {
      const session = (
        navigator as unknown as { audioSession?: { type: string } }
      ).audioSession;
      if (session) session.type = "play-and-record";
    } catch {
      // 古いiPhoneには音声セッションの切り替えがない
    }
  };
  const expectStart = () => {
    window.clearTimeout(watch);
    watch = window.setTimeout(() => {
      if (!live && ready && !stopped && !matched && !failed) fail();
    }, 1000);
  };
  const arm = () => {
    if (stopped || matched) return;
    failed = false;
    ready = true;
    readyAt = Date.now();
    holdMic();
    if (live) return;
    start();
    expectStart();
  };
  return {
    stop() {
      stopped = true;
      ready = false;
      window.clearTimeout(watch);
      try {
        current?.abort();
      } catch {
        // already stopped
      }
    },
    prime() {
      if (stopped || matched || live) return;
      start();
    },
    arm,
    listenNow: arm,
  };
}

/**
 * 話してチャットの入力と同じ聞き方です。
 * まずマイクを開き、案内が終わってから止めて、300ミリ秒後にもう一度開きます。
 * 電話では区切って聞き、途中の文字も見ます。案内のあいだの結果は使いません。
 */
export function listenLikeChatInput(handlers: {
  onMatch: (text?: string) => void;
  onFailed: () => void;
  onUnrecognized?: () => void;
  accept?: (text: string) => boolean;
}): { stop: () => void; prime: () => void; arm: () => void; listenNow: () => void } {
  const RecognitionClass = getRecognitionClass();
  const noop = { stop() {}, prime() {}, arm() {}, listenNow() {} };
  if (!RecognitionClass) {
    return {
      ...noop,
      arm() {
        handlers.onFailed();
      },
      listenNow() {
        handlers.onFailed();
      },
    };
  }
  if (isAndroidDevice()) return listenAndroidStartup(handlers);
  if (isIphoneDevice()) return listenIphoneStartup(handlers);
  const desktop = isDesktopDevice();
  const recognition = new RecognitionClass();
  let stopped = false;
  let matched = false;
  let ready = false;
  let rearming = false;
  let failed = false;
  const fail = () => {
    if (stopped || matched || failed) return;
    failed = true;
    ready = false;
    handlers.onFailed();
  };
  const acceptText = (text: string) =>
    handlers.accept ? handlers.accept(text) : isSpokenChatStart(text);
  const hear = (text: string) => {
    if (!ready || stopped || matched || failed) return false;
    if (!acceptText(text)) return false;
    matched = true;
    stopped = true;
    ready = false;
    try {
      recognition.abort();
    } catch {
      // already stopped
    }
    handlers.onMatch(text);
    return true;
  };
  recognition.lang = "ja-JP";
  recognition.continuous = desktop;
  recognition.interimResults = true;
  if (desktop) recognition.maxAlternatives = 5;
  recognition.onresult = (event) => {
    if (!ready || stopped || matched || failed) return;
    const results = event.results as ArrayLike<
      ArrayLike<{ transcript: string }> & { isFinal?: boolean; length?: number }
    >;
    const lastResult = results[results.length - 1];
    if (handlers.accept && !lastResult?.isFinal) return;
    let combined = "";
    for (let index = 0; index < results.length; index += 1) {
      combined += results[index]?.[0]?.transcript ?? "";
    }
    if (hear(combined)) return;
    if (desktop) {
      const last = results[results.length - 1];
      const count = Math.min(last?.length ?? 1, 5);
      for (let index = 1; index < count; index += 1) {
        const alt = last[index]?.transcript ?? "";
        if (alt && hear(alt)) return;
      }
    }
    if (!handlers.onUnrecognized) return;
    let finalText = "";
    for (let index = 0; index < results.length; index += 1) {
      if (!results[index]?.isFinal) continue;
      finalText += results[index]?.[0]?.transcript ?? "";
    }
    if (!finalText.trim() || acceptText(finalText)) return;
    ready = false;
    try {
      recognition.abort();
    } catch {
      // already stopped
    }
    handlers.onUnrecognized();
  };
  recognition.onerror = (event) => {
    if (stopped || matched || rearming || !ready) return;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      fail();
    }
  };
  recognition.onend = () => {
    if (stopped || matched || rearming || !ready || failed) return;
    window.setTimeout(() => {
      if (stopped || matched || !ready || failed) return;
      try {
        recognition.start();
      } catch {
        fail();
      }
    }, desktop ? 40 : 250);
  };
  const startMic = () => {
    if (isIphoneDevice()) {
      try {
        const session = (
          navigator as unknown as { audioSession?: { type: string } }
        ).audioSession;
        if (session?.type === "playback") session.type = "auto";
      } catch {
        // 古いiPhoneには音声セッションの切り替えがない
      }
    }
    recognition.start();
  };
  return {
    stop() {
      stopped = true;
      ready = false;
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
    },
    prime() {
      if (stopped || matched) return;
      try {
        startMic();
      } catch {
        // 案内のあと、arm でもう一度開く
      }
    },
    arm() {
      if (stopped || matched) return;
      failed = false;
      ready = true;
      rearming = true;
      try {
        recognition.abort();
      } catch {
        rearming = false;
      }
      window.setTimeout(() => {
        rearming = false;
        if (stopped || matched) return;
        try {
          startMic();
        } catch {
          fail();
        }
      }, 300);
    },
    listenNow() {
      if (stopped || matched) return;
      failed = false;
      ready = true;
      try {
        startMic();
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        if (name === "InvalidStateError") return;
        fail();
      }
    },
  };
}

/** 不在着信の「かけ直しますか」で、はい・かける、を受けます。案内文そのものは除きます。 */
export function isSpokenCallYes(text: string) {
  const value = normalizeSpeech(text);
  if (/いいえ|いえ|やめる|やめ|かけない|かけません/.test(value)) return false;
  if (/電話がありました|かけ直しますか|かけなおしますか|着信がありました/.test(value)) return false;
  if (value.length > 20) return false;
  if (isSpokenYes(text)) return true;
  return /かける|かけます|かけ直|かけなお/.test(value);
}

/**
 * 「はい」を聞き続けます。一度止まっても、キャンセルするまで聞き直します。
 * ボタン操作はそのまま使えます。
 */
export function listenForAnswer(handlers: {
  onYes: () => void;
  onNext?: () => void;
  onStop?: () => void;
  onOther?: () => void;
  accept?: (text: string) => boolean;
  gate?: () => boolean;
}): VoiceSession {
  const accept = handlers.accept ?? isSpokenYes;
  let cancelled = false;
  let decided = false;
  let current: Recognition | null = null;
  let failedStarts = 0;
  let speechWaits = 0;

  const finish = (kind: "yes" | "other" | "stop") => {
    if (cancelled || decided) return;
    decided = true;
    cancelled = true;
    try {
      current?.abort();
    } catch {
      // already stopped
    }
    if (kind === "yes") handlers.onYes();
    else if (kind === "stop") handlers.onStop?.();
    else handlers.onOther?.();
  };

  const start = () => {
    if (cancelled || decided) return;
    if (
      isDesktopDevice() &&
      speechWaits < 40 &&
      "speechSynthesis" in window &&
      (window.speechSynthesis.speaking || window.speechSynthesis.pending)
    ) {
      speechWaits += 1;
      window.setTimeout(start, 300);
      return;
    }
    speechWaits = 0;
    const RecognitionClass = getRecognitionClass();
    if (!RecognitionClass) return;
    const recognition = new RecognitionClass();
    current = recognition;
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      const rich = event as unknown as {
        resultIndex?: number;
        results: ArrayLike<
          ArrayLike<{ transcript: string }> & { isFinal?: boolean }
        >;
      };
      const from = rich.resultIndex ?? 0;
      for (let index = from; index < rich.results.length; index += 1) {
        const row = rich.results[index];
        const text = row?.[0]?.transcript ?? "";
        if (!text.trim()) continue;
        if (handlers.gate && !handlers.gate()) continue;
        if (handlers.onStop && isSpokenStop(text)) {
          finish("stop");
          return;
        }
        if (handlers.onNext && isSpokenNext(text)) {
          handlers.onNext();
          return;
        }
        if (accept(text)) {
          finish("yes");
          return;
        }
        if (handlers.onOther && row?.isFinal) finish("other");
      }
    };
    recognition.onerror = (event) => {
      if (
        event.error !== "not-allowed" &&
        event.error !== "service-not-allowed" &&
        event.error !== "audio-capture"
      ) {
        return;
      }
      failedStarts += 1;
      if (failedStarts === 1 && isDesktopDevice()) {
        primeDesktopMicrophone();
      }
      if (failedStarts >= 4) cancelled = true;
    };
    recognition.onend = () => {
      if (cancelled || decided) return;
      window.setTimeout(start, 400);
    };
    try {
      recognition.start();
      failedStarts = 0;
    } catch {
      failedStarts += 1;
      if (!cancelled && failedStarts < 8) window.setTimeout(start, 700);
    }
  };

  start();
  return {
    cancel() {
      cancelled = true;
      try {
        current?.abort();
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
