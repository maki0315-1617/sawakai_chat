import {
  MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AudioPresets,
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from "livekit-client";
import { SheetHandle, useSheetDrag } from "./sheetDrag";
import { isAndroidDevice, isIphoneDevice, isSpokenAnswer, isSpokenCallYes, isSpokenPlaceCall, isSpokenStop, listenForAnswer, type VoiceSession } from "./voiceJoin";

type DmStatus = "ringing" | "active" | "ended" | "missed" | "rejected" | "busy";
type DmCallView = {
  id: string;
  peer: string;
  direction: "outgoing" | "incoming";
  status: DmStatus;
  createdAt: number;
  answeredAt?: number | null;
  durationSec: number;
};
type Phase = "calling" | "incoming" | "connecting" | "incall";

type DirectCallProps = {
  apiRoot: string;
  headers: Record<string, string>;
  myName: string;
  members: { name: string }[];
  showPanel: boolean;
  assistedPick?: boolean;
  onClosePanel: () => void;
  onReturnedHome?: () => void;
  onListeningChange: (listening: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onIncomingChange?: (incoming: boolean) => void;
  onCallsLeftChange?: (left: number) => void;
  onCallPeerChange?: (peer: string | null) => void;
  controlRef?: MutableRefObject<DirectCallControl | null>;
  notify: (title: string, body: string, tag: string) => void;
  visualSupportEnabled: boolean;
  announce: (text: string, onEnd?: () => void) => void;
  endGuidance?: () => boolean;
  onMissedCount?: (count: number) => void;
  onVisualGuideReady?: (ready: boolean) => void;
  iphoneSpeechReady?: boolean;
};
export type DirectCallControl = {
  startCall: (to: string) => void;
  hangUp: () => void;
  armCallYes: () => void;
  releaseCallYes: () => void;
  speakMissedGuide: () => boolean;
};

const pollIntervalMs = 2000;
const ringPollIntervalMs = 800;
const assistedReplyWaitMs = 7000;
const assistedFirstReplyWaitMs = 12000;
const spokenEchoGuardMs = 1200;
const defaultLimitSec = 180;
const warningSec = 30;
const timeUpMessage =
  "3分になったので、通話を終わりました。またお話ししましょう。";

function isSpokenQuit(text: string) {
  const value = text
    .normalize("NFKC")
    .replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(/[\s。、.,！!？?]/g, "");
  if (/やめない|やめません/.test(value)) return false;
  return /やめる|やめます|やめて/.test(value);
}
const listenNoticeKey = "sawakai-dm-listen-notice";
const volumeSteps = [0.4, 0.6, 0.8, 1];

let audioContext: AudioContext | null = null;

function getAudioContext() {
  if (!audioContext) {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (Context) audioContext = new Context();
  }
  return audioContext;
}

function unlockAudio() {
  const context = getAudioContext();
  if (context && context.state === "suspended") void context.resume();
}

let callingRingAudio: HTMLAudioElement | null = null;
let callingRingOn = false;
let callingRingUrl = "";
let ringFailCount = 0;
let ringFailSpokenAt = 0;
let onIphoneRingFailed: (() => void) | null = null;

function ringWavUrl() {
  if (callingRingUrl) return callingRingUrl;
  const sampleRate = 22050;
  const on = Math.floor(sampleRate * 0.5);
  const gap = Math.floor(sampleRate * 0.2);
  const tail = Math.floor(sampleRate * 1.4);
  const total = on * 2 + gap + tail;
  const data = new Int16Array(total);
  const writeBurst = (start: number) => {
    for (let i = 0; i < on; i += 1) {
      const t = i / sampleRate;
      const edge = Math.min(1, i / 160, (on - i) / 160);
      const sample =
        (Math.sin(2 * Math.PI * 425 * t) + Math.sin(2 * Math.PI * 480 * t)) *
        0.48 *
        edge;
      data[start + i] = Math.round(sample * 32767);
    }
  };
  writeBurst(0);
  writeBurst(on + gap);
  const bytes = data.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
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
  view.setUint32(40, bytes, true);
  let offset = 44;
  for (let i = 0; i < data.length; i += 1, offset += 2) view.setInt16(offset, data[i], true);
  callingRingUrl = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  return callingRingUrl;
}

function noteRingFailed() {
  ringFailCount += 1;
  if (ringFailCount < 3) return;
  const now = Date.now();
  if (now - ringFailSpokenAt < 5000) return;
  ringFailSpokenAt = now;
  onIphoneRingFailed?.();
}

function ensureCallingRing() {
  if (callingRingAudio) return callingRingAudio;
  const audio = document.createElement("audio");
  audio.src = ringWavUrl();
  audio.loop = true;
  audio.preload = "auto";
  audio.setAttribute("playsinline", "true");
  audio.setAttribute("webkit-playsinline", "true");
  audio.style.display = "none";
  document.body.appendChild(audio);
  audio.addEventListener("ended", () => {
    if (!callingRingOn) return;
    audio.currentTime = 0;
    void audio.play().catch(() => noteRingFailed());
  });
  audio.addEventListener("pause", () => {
    if (!callingRingOn) return;
    window.setTimeout(() => {
      if (!callingRingOn || !audio.paused) return;
      void audio.play().catch(() => noteRingFailed());
    }, 400);
  });
  callingRingAudio = audio;
  return audio;
}

function audioSession() {
  return (navigator as unknown as { audioSession?: { type: string } }).audioSession;
}

function playCallingRing() {
  if (!isIphoneDevice()) return;
  const starting = !callingRingOn;
  try {
    const session = audioSession();
    if (session && session.type !== "play-and-record") session.type = "playback";
  } catch {
    // older iPhone browsers have no audio session control
  }
  const audio = ensureCallingRing();
  callingRingOn = true;
  audio.muted = false;
  audio.volume = 1;
  if (starting) {
    const context = getAudioContext();
    if (context && context.state !== "running") {
      void context.resume().then(() => beep([425, 480], 0.6, 0.9)).catch(() => undefined);
    } else beep([425, 480], 0.6, 0.9);
  }
  if (!audio.paused) return;
  void audio
    .play()
    .then(() => {
      ringFailCount = 0;
    })
    .catch(() => noteRingFailed());
}

let iphonePlaybackRelease = 0;
let iphoneHoldPlayback = false;

function iphoneSpeechBusy() {
  const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
  return Boolean(synth && (synth.speaking || synth.pending));
}

function clearIphonePlayback() {
  if (!isIphoneDevice() || callingRingOn || iphoneHoldPlayback || iphoneSpeechBusy()) return false;
  try {
    const session = audioSession();
    if (session?.type === "playback") session.type = "auto";
  } catch {
    // 古いiPhoneには音声セッションの切り替えがない
  }
  const media = navigator.mediaSession;
  if (media) {
    try {
      media.playbackState = "none";
      media.metadata = null;
    } catch {
      // 待ち受けの再生表示を消せない端末では、音だけ止める
    }
  }
  return true;
}

function releaseIphonePlaybackSoon() {
  if (!isIphoneDevice()) return;
  window.clearInterval(iphonePlaybackRelease);
  // この直後に「出ませんでした」の案内が始まるので、同じ瞬間には消さない
  iphonePlaybackRelease = window.setInterval(() => {
    if (!clearIphonePlayback()) return;
    window.clearInterval(iphonePlaybackRelease);
  }, 300);
  window.setTimeout(() => window.clearInterval(iphonePlaybackRelease), 20000);
}

function stopCallingRing(forceRelease = false) {
  callingRingOn = false;
  ringFailCount = 0;
  const audio = callingRingAudio;
  callingRingAudio = null;
  if (audio) {
    audio.loop = false;
    audio.pause();
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      // まだ読み込んでいない
    }
    audio.remove();
  }
  if (forceRelease) {
    window.clearInterval(iphonePlaybackRelease);
    if (clearIphonePlayback() || !isIphoneDevice()) return;
  }
  releaseIphonePlaybackSoon();
}

function beep(frequencies: number[], seconds: number, volume: number, delay = 0) {
  const context = getAudioContext();
  if (!context || context.state !== "running") return;
  const start = context.currentTime + delay;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.03);
  gain.gain.setValueAtTime(volume, start + seconds - 0.05);
  gain.gain.linearRampToValueAtTime(0, start + seconds);
  gain.connect(context.destination);
  frequencies.forEach((frequency) => {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(start);
    oscillator.stop(start + seconds);
  });
}

function startRinging(kind: "incoming" | "calling") {
  if (kind === "calling" && isIphoneDevice()) {
    playCallingRing();
    const timer = window.setInterval(playCallingRing, 1200);
    const spoken = window.setInterval(() => onIphoneRingFailed?.(), 5000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(spoken);
      stopCallingRing();
    };
  }
  const play =
    kind === "incoming"
      ? () => {
          beep([880], 0.25, 0.3);
          beep([660], 0.25, 0.3, 0.3);
          beep([880], 0.25, 0.3, 0.7);
          beep([660], 0.25, 0.3, 1);
          if ("vibrate" in navigator) navigator.vibrate([400, 200, 400]);
        }
      : () => beep([400, 450], 1, 0.15);
  play();
  const timer = window.setInterval(play, kind === "incoming" ? 2500 : 3000);
  return () => {
    window.clearInterval(timer);
    if ("vibrate" in navigator) navigator.vibrate(0);
  };
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}分${rest}秒` : `${rest}秒`;
}

function formatClock(value: number) {
  return new Date(value).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(value: number) {
  const date = new Date(value);
  const weekday = "日月火水木金土"[date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日（${weekday}） ${formatClock(value)}`;
}

type MissedGuideKind = "only" | "first" | "next" | "last";

function missedGuideKind(
  currentId: string,
  missed: { id: string }[],
  sequenceOn: boolean,
): MissedGuideKind {
  const others = missed.filter((item) => item.id !== currentId).length;
  if (!sequenceOn && others === 0) return "only";
  if (!sequenceOn) return "first";
  if (others === 0) return "last";
  return "next";
}

function missedGuideSpeech(
  peer: string,
  myName: string,
  iphone: boolean,
  kind: MissedGuideKind,
  count: number,
) {
  if (iphone) {
    if (kind === "only") {
      return `${peer}さんから電話がありました。右を押すとかけなおします。左を押すと茶話会の最初の画面に戻ります。`;
    }
    if (kind === "first") {
      return `電話が${count}件ありました。最初は${peer}さんからです。右を押すとかけなおします。左を押すと次の人です。`;
    }
    if (kind === "next") {
      return `次は${peer}さんからです。右を押すとかけなおします。左を押すと次の人です。`;
    }
    return `最後は${peer}さんからです。右を押すとかけなおします。左を押すと茶話会の最初の画面に戻ります。`;
  }
  if (kind === "only") {
    return `${myName}さん、${peer}さんから電話がありました。かけ直しますか。`;
  }
  if (kind === "first") {
    return `${myName}さん、電話が${count}件ありました。最初は${peer}さんからです。かけ直しますか。`;
  }
  if (kind === "next") return `次は${peer}さんからです。かけ直しますか。`;
  return `最後は${peer}さんからです。かけ直しますか。`;
}

function missedGuideHint(
  peer: string,
  myName: string,
  iphone: boolean,
  kind: MissedGuideKind,
  count: number,
) {
  const spoken = missedGuideSpeech(peer, myName, iphone, kind, count);
  if (iphone) return spoken;
  const side =
    kind === "only" || kind === "last"
      ? "左の戻るを押すか、いいえ、と言うと最初の画面に戻ります。"
      : "左の次の人を押すか、いいえ、または、次へ、と言うと次の人です。";
  return `${spoken}右のかけなおすを押すか、はい、または、かける、と言うとかけなおします。${side}`;
}

function historyLabel(call: DmCallView) {
  const outgoing = call.direction === "outgoing";
  if (call.status === "ended") {
    return `${outgoing ? "発信" : "着信"}・通話しました（${formatDuration(call.durationSec)}）`;
  }
  if (call.status === "busy") return "発信・相手が通話中でした";
  if (call.status === "rejected") {
    return outgoing ? "発信・出てもらえませんでした" : "着信・出ませんでした";
  }
  if (call.status === "missed") {
    return outgoing ? "発信・応答がありませんでした" : "不在着信";
  }
  return outgoing ? "発信・通話中" : "着信・通話中";
}

export default function DirectCall({
  apiRoot,
  headers,
  myName,
  members,
  showPanel,
  assistedPick = false,
  onClosePanel,
  onReturnedHome,
  onListeningChange,
  onBusyChange,
  onIncomingChange,
  onCallsLeftChange,
  onCallPeerChange,
  controlRef,
  notify,
  visualSupportEnabled,
  announce,
  endGuidance,
  onMissedCount,
  onVisualGuideReady,
  iphoneSpeechReady = true,
}: DirectCallProps) {
  const [call, setCall] = useState<DmCallView | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [notice, setNotice] = useState("");
  const [muted, setMuted] = useState(false);
  const [volumeIndex, setVolumeIndex] = useState(2);
  const [peerSpeaking, setPeerSpeaking] = useState(false);
  const [remaining, setRemaining] = useState(defaultLimitSec);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [localVideo, setLocalVideo] = useState<LocalVideoTrack | null>(null);
  const [remoteVideo, setRemoteVideo] = useState<RemoteVideoTrack | null>(null);
  const [remoteCamOn, setRemoteCamOn] = useState(false);
  const [callsLeft, setCallsLeft] = useState<number | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const [assistedWaitSec, setAssistedWaitSec] = useState(
    assistedFirstReplyWaitMs / 1000,
  );
  const [tab, setTab] = useState<"pick" | "history">("pick");
  const [history, setHistory] = useState<DmCallView[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [missed, setMissed] = useState<DmCallView[]>([]);
  const [missedPrompt, setMissedPrompt] = useState<DmCallView | null>(null);
  const [missedSequenceOn, setMissedSequenceOn] = useState(false);
  const [showListenNotice, setShowListenNotice] = useState(
    () => localStorage.getItem(listenNoticeKey) !== "seen",
  );
  const [voiceRingHeld, setVoiceRingHeld] = useState(false);

  const headersRef = useRef(headers);
  headersRef.current = headers;
  const visualSupportRef = useRef(visualSupportEnabled);
  visualSupportRef.current = visualSupportEnabled;
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const onReturnedHomeRef = useRef(onReturnedHome);
  onReturnedHomeRef.current = onReturnedHome;
  const showPanelRef = useRef(showPanel);
  showPanelRef.current = showPanel;
  const tellHome = () => {
    if (visualSupportRef.current) onReturnedHomeRef.current?.();
  };
  onIphoneRingFailed = () => {
    if (phaseRef.current !== "calling" || !visualSupportRef.current) return;
    announceRef.current("呼び出し中です。");
  };
  const endGuidanceRef = useRef(endGuidance);
  endGuidanceRef.current = endGuidance;
  const assistedSpokenRef = useRef("");
  const callRef = useRef<DmCallView | null>(null);
  const phaseRef = useRef<Phase | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const endsAtRef = useRef(0);
  const limitSecRef = useRef(defaultLimitSec);
  const remoteTracksRef = useRef<RemoteAudioTrack[]>([]);
  const volumeRef = useRef(volumeSteps[2]);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const pollingRef = useRef(false);
  const listeningRef = useRef<boolean | null>(null);
  const notifiedRef = useRef(new Set<string>());
  const announcedIncomingRef = useRef(new Set<string>());
  const incomingChoiceRef = useRef(false);
  const answerRef = useRef<() => void>(() => undefined);
  const hangUpRef = useRef<(message?: string) => void>(() => undefined);
  const assistedCallRef = useRef<() => void>(() => undefined);
  const assistedSkipRef = useRef<() => void>(() => undefined);
  const assistedTimeoutRef = useRef<() => void>(() => undefined);
  const assistedStopRef = useRef<() => void>(() => undefined);
  const assistedReplyTimerRef = useRef(0);
  const assistedListenTimerRef = useRef(0);
  const callYesRef = useRef<VoiceSession | null>(null);
  const callYesReadyRef = useRef(false);
  const callYesTokenRef = useRef(0);
  const answerYesRef = useRef<VoiceSession | null>(null);
  const answerYesReadyRef = useRef(false);
  const beginCallYesRef = useRef<() => void>(() => undefined);
  const dismissedRef = useRef(new Set<string>());
  const askedMissedRef = useRef(new Set<string>());
  const missedSequenceRef = useRef(false);
  const missedRef = useRef<DmCallView[]>([]);
  const missedSpokenFromTapRef = useRef("");
  const guideCheckedRef = useRef(false);
  const guideAfterCallRef = useRef(false);
  const guideSawCallRef = useRef(false);
  const onVisualGuideReadyRef = useRef(onVisualGuideReady);
  const onMissedCountRef = useRef(onMissedCount);
  const missedChoiceRef = useRef<{ yes: () => void; no: () => void }>({
    yes: () => undefined,
    no: () => undefined,
  });
  onVisualGuideReadyRef.current = onVisualGuideReady;
  onMissedCountRef.current = onMissedCount;
  missedRef.current = missed;
  const hangingUpRef = useRef(false);
  const ringStopRef = useRef<(() => void) | null>(null);

  const changeCall = (next: DmCallView | null, nextPhase: Phase | null) => {
    callRef.current = next;
    phaseRef.current = nextPhase;
    setCall(next);
    setPhase(nextPhase);
    if (
      nextPhase === "incoming" &&
      visualSupportRef.current &&
      !document.hidden
    ) {
      setVoiceRingHeld(true);
    }
  };

  const request = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(`${apiRoot}${path}`, {
        ...init,
        headers: headersRef.current,
      }),
    [apiRoot],
  );

  const releaseWakeLock = () => {
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  };

  const leaveRoom = () => {
    roomRef.current?.disconnect();
    roomRef.current = null;
    remoteTracksRef.current = [];
    if (audioRef.current) audioRef.current.innerHTML = "";
    releaseWakeLock();
    endsAtRef.current = 0;
    setMuted(false);
    setCameraOn(false);
    setCameraBusy(false);
    setLocalVideo(null);
    setRemoteVideo(null);
    setRemoteCamOn(false);
    setRemaining(limitSecRef.current);
    setPeerSpeaking(false);
  };

  const showNotice = (message: string) => {
    if (!message) return;
    if (visualSupportRef.current) {
      announceRef.current(message);
      return;
    }
    setNotice(message);
  };

  const finishCall = (message: string) => {
    leaveRoom();
    const panelOpen = showPanelRef.current;
    changeCall(null, null);
    if (message) showNotice(message);
    if (!panelOpen) tellHome();
  };

  const hangUp = async (message = "通話を終了しました。") => {
    const current = callRef.current;
    if (!current || hangingUpRef.current) return;
    hangingUpRef.current = true;
    const wasTalking = phaseRef.current === "incall";
    const action = phaseRef.current === "calling" ? "cancel" : phaseRef.current === "incoming" ? "reject" : "end";
    if (!wasTalking) {
      endGuidanceRef.current?.();
      ringStopRef.current?.();
      ringStopRef.current = null;
      stopCallingRing(true);
    }
    finishCall(wasTalking ? message : "");
    try {
      await request(`/dm/${current.id}/${action}`, { method: "POST" });
    } finally {
      hangingUpRef.current = false;
    }
  };

  const connectRoom = async (callId: string) => {
    if (isIphoneDevice()) {
      try {
        const session = audioSession();
        if (session?.type === "playback") session.type = "play-and-record";
      } catch {
        // ignore
      }
    }
    phaseRef.current = "connecting";
    setPhase("connecting");
    try {
      const response = await request(`/dm/${callId}/token`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.token || !result.url) {
        throw new Error(result.error ?? "通話をつなげませんでした。");
      }
      const room = new Room({
        adaptiveStream: false,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        publishDefaults: {
          audioPreset: AudioPresets.speech,
          dtx: true,
          red: true,
          simulcast: false,
          videoEncoding: { maxBitrate: 300_000, maxFramerate: 15 },
        },
        videoCaptureDefaults: {
          resolution: VideoPresets.h360.resolution,
          facingMode: "user",
        },
      });
      roomRef.current = room;
      room
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Video) {
            setRemoteVideo(track as RemoteVideoTrack);
            setRemoteCamOn(!track.isMuted);
            return;
          }
          if (track.kind !== Track.Kind.Audio) return;
          const audioTrack = track as RemoteAudioTrack;
          audioTrack.setVolume(volumeRef.current);
          remoteTracksRef.current.push(audioTrack);
          audioRef.current?.appendChild(track.attach());
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          if (track.kind === Track.Kind.Video) {
            setRemoteVideo(null);
            setRemoteCamOn(false);
            return;
          }
          track.detach().forEach((element) => element.remove());
        })
        .on(RoomEvent.TrackMuted, (publication, participant) => {
          if (
            participant !== room.localParticipant &&
            publication.kind === Track.Kind.Video
          ) {
            setRemoteCamOn(false);
          }
        })
        .on(RoomEvent.TrackUnmuted, (publication, participant) => {
          if (
            participant !== room.localParticipant &&
            publication.kind === Track.Kind.Video
          ) {
            setRemoteCamOn(true);
          }
        })
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) =>
          setPeerSpeaking(
            speakers.some((speaker) => speaker !== room.localParticipant),
          ),
        )
        .on(RoomEvent.ParticipantDisconnected, () => {
          if (roomRef.current === room) void hangUp();
        })
        .on(RoomEvent.Disconnected, () => {
          if (roomRef.current === room) void hangUp();
        });
      await room.connect(result.url, result.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (roomRef.current !== room) return;
      if (endsAtRef.current === 0) {
        endsAtRef.current = Date.now() + limitSecRef.current * 1000;
      }
      phaseRef.current = "incall";
      setPhase("incall");
      try {
        wakeLockRef.current =
          (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {
        wakeLockRef.current = null;
      }
    } catch (reason) {
      const current = callRef.current;
      leaveRoom();
      changeCall(null, null);
      if (current) void request(`/dm/${current.id}/end`, { method: "POST" });
      showNotice(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "マイクが許可されていません。ブラウザの設定でマイクを許可してください。"
          : reason instanceof Error
            ? reason.message
            : "通話をつなげませんでした。",
      );
      if (!showPanelRef.current) tellHome();
    }
  };

  const startCall = async (to: string) => {
    if (isIphoneDevice()) playCallingRing();
    unlockAudio();
    if (callRef.current) {
      stopCallingRing();
      return;
    }
    try {
      const response = await request("/dm/call", {
        method: "POST",
        body: JSON.stringify({ to }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        stopCallingRing();
        if (typeof result.callsLeft === "number") setCallsLeft(result.callsLeft);
        const message = result.error ?? "電話をかけられませんでした。";
        showNotice(message);
        if (guideAfterCallRef.current) {
          guideAfterCallRef.current = false;
          const more = missedRef.current.some(
            (item) => !askedMissedRef.current.has(item.id),
          );
          if (!more) onVisualGuideReadyRef.current?.(true);
        }
        return;
      }
      onClosePanel();
      changeCall(result.call as DmCallView, "calling");
    } catch {
      stopCallingRing();
      const message = "電話をかけられませんでした。通信状態を確認してください。";
      showNotice(message);
      if (guideAfterCallRef.current) {
        guideAfterCallRef.current = false;
        const more = missedRef.current.some(
          (item) => !askedMissedRef.current.has(item.id),
        );
        if (!more) onVisualGuideReadyRef.current?.(true);
      }
    }
  };

  const answer = async () => {
    unlockAudio();
    const current = callRef.current;
    if (!current) return;
    try {
      const response = await request(`/dm/${current.id}/accept`, {
        method: "POST",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        finishCall(result.error ?? "この電話はもう終了しています。");
        return;
      }
      await connectRoom(current.id);
    } catch {
      finishCall("電話に出られませんでした。通信状態を確認してください。");
    }
  };
  answerRef.current = () => {
    void answer();
  };
  hangUpRef.current = (message) => {
    void hangUp(message);
  };

  const cameraErrorMessage = (reason: unknown) => {
    const name = reason instanceof DOMException ? reason.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "カメラが許可されていません。アドレスバーのカメラの印から許可するか、Windowsの「設定」→「プライバシーとセキュリティ」→「カメラ」で、ブラウザのカメラ使用をオンにしてください。";
    }
    if (name === "NotReadableError" || name === "AbortError") {
      return "カメラを使えませんでした。Zoomなど、ほかのアプリやタブがカメラを使っている可能性があります。閉じてからもう一度お試しください。";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "カメラが見つかりませんでした。カメラが有効か確認してください。";
    }
    return "カメラをつけられませんでした。声だけで通話を続けられます。";
  };

  // スマホ連携などの「仮想カメラ」は黒い映像になることがあるため、内蔵カメラを優先する
  const pickCameraId = async () => {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "videoinput",
      );
      console.info(
        "camera devices",
        devices.map((device) => device.label || "(名前なし)"),
      );
      const virtual =
        /仮想|virtual|\bobs\b|phone link|link to windows|droidcam|\bndi\b|snap camera|manycam|pixel|iphone|スマートフォン/i;
      const real = devices.filter((device) => !virtual.test(device.label));
      return real.length > 0 && real.length < devices.length
        ? real[0].deviceId
        : undefined;
    } catch {
      return undefined;
    }
  };

  const toggleCamera = async () => {
    const room = roomRef.current;
    if (!room || cameraBusy) return;
    setCameraBusy(true);
    const next = !cameraOn;
    try {
      if (!next) {
        await room.localParticipant.setCameraEnabled(false);
        setCameraOn(false);
        setLocalVideo(null);
        return;
      }
      let publication;
      try {
        let deviceId = await pickCameraId();
        const open = (id?: string) =>
          room.localParticipant.setCameraEnabled(
            true,
            id ? { deviceId: { exact: id } } : undefined,
          );
        try {
          publication = await open(deviceId);
        } catch (reason) {
          if (!deviceId) throw reason;
          // 指定したカメラを開けなかったときだけ、指定なしに戻す
          console.warn("preferred camera failed", reason);
          publication = await open();
        }
        if (deviceId === undefined) {
          // 初回は許可前でカメラ名が取れないため、許可後にもう一度選び直す
          deviceId = await pickCameraId();
          if (deviceId) {
            await room.localParticipant.setCameraEnabled(false);
            publication = await open(deviceId);
          }
        }
      } catch (reason) {
        const name = reason instanceof DOMException ? reason.name : "";
        if (name === "NotAllowedError" || name === "NotReadableError") {
          throw reason;
        }
        // 解像度などの指定に合わないカメラは、指定なしで再試行する
        publication = await room.localParticipant.setCameraEnabled(true, {
          resolution: undefined,
          facingMode: undefined,
        });
      }
      const track = (publication?.videoTrack ??
        room.localParticipant.getTrackPublication(Track.Source.Camera)
          ?.videoTrack) as LocalVideoTrack | undefined;
      if (!track) throw new Error("camera track missing");
      setLocalVideo(track);
      setCameraOn(true);
    } catch (reason) {
      console.error("camera start failed", reason);
      await room.localParticipant.setCameraEnabled(false).catch(() => undefined);
      setCameraOn(false);
      setLocalVideo(null);
      showNotice(cameraErrorMessage(reason));
    } finally {
      setCameraBusy(false);
    }
  };

  const toggleMute = async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  };

  const changeVolume = (delta: number) => {
    const next = Math.min(volumeSteps.length - 1, Math.max(0, volumeIndex + delta));
    setVolumeIndex(next);
    volumeRef.current = volumeSteps[next];
    remoteTracksRef.current.forEach((track) => track.setVolume(volumeSteps[next]));
  };

  const dismissMissed = (calls: DmCallView[]) => {
    calls.forEach((item) => dismissedRef.current.add(item.id));
    setMissed((current) => current.filter((item) => !dismissedRef.current.has(item.id)));
    void request("/dm/seen", {
      method: "POST",
      body: JSON.stringify({ ids: calls.map((item) => item.id) }),
    }).catch(() => undefined);
  };

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    const poll = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const watch = callRef.current?.id;
        const response = await request(
          `/dm/poll${watch ? `?watch=${watch}` : ""}`,
        );
        if (!response.ok) throw new Error("poll failed");
        const result = await response.json();
        if (listeningRef.current !== true) {
          listeningRef.current = true;
          onListeningChange(true);
        }

        const current = callRef.current;
        const watched = result.watched as DmCallView | null;
        if (typeof result.limitSec === "number") {
          limitSecRef.current = result.limitSec;
        }
        if (typeof result.callsLeft === "number") setCallsLeft(result.callsLeft);
        if (watched?.status === "active" && watched.answeredAt) {
          // 端末の時計ではなくサーバーの時刻を基準に、残り時間を合わせる
          endsAtRef.current =
            Date.now() +
            limitSecRef.current * 1000 -
            (result.serverNow - watched.answeredAt);
        }
        if (current && watched) {
          if (watched.status === "active") {
            if (phaseRef.current === "calling") void connectRoom(current.id);
          } else if (watched.status !== "ringing") {
            const wasPhase = phaseRef.current;
            if (wasPhase === "calling" || wasPhase === "incoming") {
              incomingChoiceRef.current = true;
              answerYesRef.current?.cancel();
              answerYesRef.current = null;
              ringStopRef.current?.();
              ringStopRef.current = null;
              if (visualSupportRef.current) endGuidanceRef.current?.();
            }
            if (wasPhase === "calling") {
              finishCall(
                watched.status === "rejected"
                  ? `${current.peer}さんは電話に出られませんでした。`
                  : `${current.peer}さんは電話に出ませんでした。`,
              );
            } else if (wasPhase === "incoming") {
              finishCall(
                visualSupportRef.current && watched.status === "missed"
                  ? ""
                  : `${current.peer}さんからの電話は切れました。`,
              );
            } else if (wasPhase === "incall" || wasPhase === "connecting") {
              const timeUp =
                endsAtRef.current > 0 && Date.now() >= endsAtRef.current - 4000;
              finishCall(
                timeUp
                  ? timeUpMessage
                  : `通話が終わりました。${
                      watched.durationSec
                        ? `（${formatDuration(watched.durationSec)}）`
                        : ""
                    }`,
              );
            }
          }
        } else if (!current && result.incoming) {
          const incoming = result.incoming as DmCallView;
          changeCall(incoming, "incoming");
          if (!notifiedRef.current.has(`ring-${incoming.id}`)) {
            notifiedRef.current.add(`ring-${incoming.id}`);
            notify(
              `${incoming.peer}さんから電話です`,
              "茶話会を開いて電話に出てください。",
              `dm-${incoming.id}`,
            );
          }
        }

        const missedCalls = (result.missed as DmCallView[]).filter(
          (item) => !dismissedRef.current.has(item.id),
        );
        setMissed(missedCalls);
        if (!guideCheckedRef.current) {
          guideCheckedRef.current = true;
          const waiting =
            visualSupportRef.current &&
            missedCalls.length > 0 &&
            !callRef.current;
          if (!waiting) onVisualGuideReadyRef.current?.(true);
        }
        missedCalls.forEach((item) => {
          if (notifiedRef.current.has(`missed-${item.id}`)) return;
          notifiedRef.current.add(`missed-${item.id}`);
          const countNote =
            missedCalls.length > 1
              ? ` 着信は${missedCalls.length}件です。`
              : "";
          const voiceInstead =
            isIphoneDevice() && visualSupportRef.current && !document.hidden;
          if (voiceInstead) return;
            notify(
              `${item.peer}さんから電話がありました`,
            `${formatDateTime(item.createdAt)}${countNote}`,
            `dm-missed-${item.id}`,
            );
        });
      } catch {
        if (!guideCheckedRef.current) {
          guideCheckedRef.current = true;
          onVisualGuideReadyRef.current?.(true);
        }
        if (listeningRef.current !== false) {
          listeningRef.current = false;
          onListeningChange(false);
        }
      } finally {
        pollingRef.current = false;
      }
    };
    let stopped = false;
    let timer = 0;
    const loop = () => {
      void poll().finally(() => {
        if (stopped) return;
        const ringing =
          phaseRef.current === "incoming" || phaseRef.current === "calling";
        timer = window.setTimeout(
          loop,
          ringing ? ringPollIntervalMs : pollIntervalMs,
        );
      });
    };
    loop();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (phase !== "incoming" && phase !== "calling") return;
    if (voiceRingHeld) return;
    const stop = startRinging(phase);
    ringStopRef.current = stop;
    return () => {
      stop();
      if (ringStopRef.current === stop) ringStopRef.current = null;
    };
  }, [phase, voiceRingHeld]);

  useEffect(() => {
    if (phase === "incoming") return;
    setVoiceRingHeld(false);
  }, [phase]);

  useEffect(() => {
    if (phase !== "incoming" || !visualSupportEnabled) return;
    const current = callRef.current;
    if (!current) return;
    const callId = current.id;
    let stopped = false;
    let releaseTimer = 0;
    let listenTimer = 0;
    incomingChoiceRef.current = false;
    answerYesReadyRef.current = false;
    answerYesRef.current?.cancel();
    answerYesRef.current = null;
    const beginListen = () => {
      if (stopped || isIphoneDevice() || incomingChoiceRef.current) return;
      if (phaseRef.current !== "incoming" || answerYesRef.current) return;
      answerYesReadyRef.current = true;
      const session = listenForAnswer({
        accept: isSpokenAnswer,
        gate: () => answerYesReadyRef.current,
        onYes: () => {
          if (stopped || incomingChoiceRef.current || phaseRef.current !== "incoming") return;
          incomingChoiceRef.current = true;
          answerYesReadyRef.current = false;
          announceRef.current("出ます。この通話は3分です。");
          answerRef.current();
        },
      });
      answerYesRef.current = session;
    };
    const scheduleListen = () => {
      if (stopped || isIphoneDevice() || phaseRef.current !== "incoming") return;
      window.clearTimeout(listenTimer);
      listenTimer = window.setTimeout(beginListen, spokenEchoGuardMs);
    };
    let retryTimer = 0;
    const resumeRing = () => {
      if (!stopped && phaseRef.current === "incoming" && !incomingChoiceRef.current) {
        setVoiceRingHeld(false);
      }
    };
    const speakIncoming = () => {
      if (stopped || phaseRef.current !== "incoming" || incomingChoiceRef.current) return;
      if (document.hidden) return;
      if (announcedIncomingRef.current.has(callId)) {
        scheduleListen();
        return;
      }
      announcedIncomingRef.current.add(callId);
      const peer = callRef.current?.peer ?? current.peer;
      const iphone = isIphoneDevice();
      if (iphone) {
        try {
          const session = audioSession();
          if (session && session.type !== "playback") session.type = "playback";
        } catch {
          // 古いiPhoneには音声セッションの切り替えがない
        }
      } else {
        beep([880], 0.25, 0.3);
        beep([660], 0.25, 0.3, 0.3);
      }
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(resumeRing, 9000);
      const lead = iphone
        ? "出るときは、下の緑を押します。出ないときは、一番上の、出ない、を押してください。"
        : "出ます、または、はい、と言うと出ます。出ないときは、一番上の、出ない、を押してください。";
      const line = `${peer}さんから電話です。${lead}`;
      const onSpoken = () => {
        window.clearTimeout(releaseTimer);
        window.clearTimeout(retryTimer);
        resumeRing();
        scheduleListen();
      };
      announceRef.current(line, onSpoken);
      if (!iphone) return;
      // iPhoneは最初の読み上げだけ消えることがある
      retryTimer = window.setTimeout(() => {
        if (stopped || phaseRef.current !== "incoming" || incomingChoiceRef.current) return;
        const synth = window.speechSynthesis;
        if (!synth || synth.speaking || synth.pending) return;
        synth.cancel();
        window.setTimeout(() => {
          if (stopped || phaseRef.current !== "incoming" || incomingChoiceRef.current) return;
          announceRef.current(line, onSpoken);
        }, 250);
      }, 1500);
    };
    const onVisible = () => {
      if (!document.hidden) speakIncoming();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setTimeout(speakIncoming, 700);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(timer);
      window.clearTimeout(listenTimer);
      window.clearTimeout(releaseTimer);
      window.clearTimeout(retryTimer);
      answerYesRef.current?.cancel();
      answerYesRef.current = null;
    };
  }, [phase, visualSupportEnabled, call?.id]);

  useEffect(() => {
    if (!visualSupportEnabled || call || missedPrompt) return;
    const next = [...missed]
      .sort((a, b) => a.createdAt - b.createdAt)
      .find((item) => !askedMissedRef.current.has(item.id));
    if (!next) return;
    askedMissedRef.current.add(next.id);
    setMissedPrompt(next);
  }, [visualSupportEnabled, call, missed, missedPrompt]);

  useEffect(() => {
    onMissedCountRef.current?.(missed.length);
  }, [missed.length]);

  useEffect(() => {
    if (missed.length > 0 || !missedSequenceRef.current) return;
    missedSequenceRef.current = false;
    setMissedSequenceOn(false);
  }, [missed.length]);

  useEffect(() => {
    if (!missedPrompt || call) return;
    const item = missedPrompt;
    let stopped = false;
    let session: VoiceSession | null = null;
    onVisualGuideReadyRef.current?.(false);
    const stopListening = () => {
      try {
        session?.cancel();
      } catch {
        // already stopped
      }
      session = null;
    };
    const iphone = isIphoneDevice();
    const pending = missedRef.current.filter((entry) => entry.id !== item.id);
    const kind = missedGuideKind(item.id, missedRef.current, missedSequenceRef.current);
    const rememberSequence = () => {
      if (kind !== "first") return;
      missedSequenceRef.current = true;
      setMissedSequenceOn(true);
    };
    const returnHome = () => {
      onClosePanel();
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      tellHome();
      onVisualGuideReadyRef.current?.(true);
    };
    const finishNo = () => {
      if (stopped) return;
      stopped = true;
      stopListening();
      rememberSequence();
      dismissMissed([item]);
      setMissedPrompt(null);
      if (pending.length === 0) returnHome();
    };
    const finishAll = () => {
      if (stopped) return;
      stopped = true;
      stopListening();
      const current = missedRef.current;
      current.forEach((entry) => askedMissedRef.current.add(entry.id));
      dismissMissed(current.length > 0 ? current : [item]);
      setMissedPrompt(null);
      returnHome();
    };
    const finishYes = () => {
      if (stopped) return;
      stopped = true;
      stopListening();
      rememberSequence();
      guideAfterCallRef.current = true;
      guideSawCallRef.current = false;
      dismissMissed([item]);
      setMissedPrompt(null);
      if (iphone) playCallingRing();
      const say = () =>
        announceRef.current(`${item.peer}さんにかけ直します。`, () => {
          if (iphone) playCallingRing();
        });
      if (iphone) window.setTimeout(say, 700);
      else if (endGuidanceRef.current?.()) window.setTimeout(say, 100);
      else say();
      void startCall(item.peer);
    };
    missedChoiceRef.current = { yes: finishYes, no: finishNo };
    let echoTimer = 0;
    let speakTimer = 0;
    const startListen = () => {
      if (stopped || session || iphone) return;
      beep([880], 0.12, 0.2);
      session = listenForAnswer({
        accept: isSpokenCallYes,
        onYes: () => finishYes(),
        onNext: () => finishNo(),
        onOther: () => finishNo(),
      });
    };
    const missedLine = missedGuideSpeech(
      item.peer,
      myName,
      iphone,
      kind,
      missedRef.current.length,
    );
    let retryTimer = 0;
    let backupTimer = 0;
    let heardMissed = false;
    let missedAttempt = 0;
    const prepareIphoneAudio = () => {
      try {
        const session = audioSession();
        if (session && session.type !== "playback") session.type = "playback";
      } catch {
        // 古いiPhoneには音声セッションの切り替えがない
      }
    };
    const speakMissed = () => {
      if (stopped) return;
      announceRef.current(missedLine, () => {
        echoTimer = window.setTimeout(startListen, spokenEchoGuardMs);
      });
    };
    const speakIphoneMissed = () => {
      if (stopped || heardMissed || missedAttempt >= 3 || document.hidden) return;
      missedAttempt += 1;
      window.clearTimeout(speakTimer);
      window.clearTimeout(retryTimer);
      window.clearTimeout(backupTimer);
      iphoneHoldPlayback = true;
      prepareIphoneAudio();
      // 着信案内の直後は、cancelした次の読み上げがiPhoneでは消える
      endGuidanceRef.current?.();
      speakTimer = window.setTimeout(() => {
        if (stopped || heardMissed) return;
        prepareIphoneAudio();
        const started = Date.now();
        announceRef.current(missedLine, () => {
          if (stopped || heardMissed) return;
          if (Date.now() - started < 900) {
            window.clearTimeout(backupTimer);
            retryTimer = window.setTimeout(speakIphoneMissed, 400);
            return;
          }
          heardMissed = true;
          iphoneHoldPlayback = false;
          releaseIphonePlaybackSoon();
        });
        backupTimer = window.setTimeout(() => {
          if (stopped || heardMissed) return;
          const synth = window.speechSynthesis;
          if (synth && (synth.speaking || synth.pending)) return;
          speakIphoneMissed();
        }, 1800);
      }, 600);
    };
    if (iphone) {
      if (!iphoneSpeechReady) return;
      if (missedSpokenFromTapRef.current === item.id) {
        return () => {
          iphoneHoldPlayback = false;
          releaseIphonePlaybackSoon();
        };
      }
      const onVisible = () => {
        if (!document.hidden) speakIphoneMissed();
      };
      document.addEventListener("visibilitychange", onVisible);
      speakIphoneMissed();
      return () => {
        stopped = true;
        iphoneHoldPlayback = false;
        document.removeEventListener("visibilitychange", onVisible);
        window.clearTimeout(echoTimer);
        window.clearTimeout(speakTimer);
        window.clearTimeout(retryTimer);
        window.clearTimeout(backupTimer);
        stopListening();
        releaseIphonePlaybackSoon();
        if (callRef.current && visualSupportRef.current) endGuidanceRef.current?.();
      };
    }
    speakMissed();
    const lateListen = window.setTimeout(startListen, 18000);
    const giveUp = window.setTimeout(finishAll, 25000);
    return () => {
      stopped = true;
      window.clearTimeout(echoTimer);
      window.clearTimeout(speakTimer);
      window.clearTimeout(retryTimer);
      window.clearTimeout(lateListen);
      window.clearTimeout(giveUp);
      stopListening();
      if (callRef.current && visualSupportRef.current) endGuidanceRef.current?.();
    };
    // dismissMissed と startCall は、この着信のあいだだけ使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missedPrompt, call, iphoneSpeechReady]);

  useEffect(() => {
    if (phase !== "calling" || !visualSupportEnabled) return;
    const message =
      "呼び出し中です。やめるときは、一番上の、やめる、を押してください。";
    let timer = 0;
    const say = () => announceRef.current(message);
    if (endGuidanceRef.current?.()) timer = window.setTimeout(say, 100);
    else say();
    return () => window.clearTimeout(timer);
  }, [phase, visualSupportEnabled]);

  useEffect(() => {
    if (phase !== "incall" || !visualSupportEnabled) return;
    const message =
      "通話がつながりました。終わるときは、一番上の、電話を切る、を押してください。";
    let timer = 0;
    const say = () => announceRef.current(message);
    if (endGuidanceRef.current?.()) timer = window.setTimeout(say, 100);
    else say();
    return () => window.clearTimeout(timer);
  }, [phase, visualSupportEnabled]);

  useEffect(() => {
    if (!guideAfterCallRef.current) return;
    if (phase) {
      guideSawCallRef.current = true;
      return;
    }
    if (!guideSawCallRef.current) return;
    guideAfterCallRef.current = false;
    guideSawCallRef.current = false;
    const more = missedRef.current.some(
      (item) => !askedMissedRef.current.has(item.id),
    );
    if (!more) onVisualGuideReadyRef.current?.(true);
  }, [phase]);

  useEffect(() => {
    if (phase !== "incall") return;
    const tick = () => {
      const left = Math.max(
        0,
        Math.ceil((endsAtRef.current - Date.now()) / 1000),
      );
      setRemaining(left);
      if (left === 0) void hangUp(timeUpMessage);
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    const element = remoteVideoRef.current;
    if (!element || !remoteVideo) return;
    remoteVideo.attach(element);
    void element.play().catch(() => undefined);
    return () => {
      remoteVideo.detach(element);
    };
  }, [remoteVideo, phase, remoteCamOn]);

  useEffect(() => {
    const element = localVideoRef.current;
    if (!element || !localVideo) return;
    element.muted = true;
    localVideo.attach(element);
    // 非表示から表示に切り替わった直後は再生が止まることがあるため、明示的に再生する
    void element.play().catch(() => undefined);
    const track = localVideo.mediaStreamTrack;
    console.info("camera track", {
      label: track.label,
      readyState: track.readyState,
      muted: track.muted,
      settings: track.getSettings(),
    });
    // 2秒たっても映像が届かない場合は、画面で原因の見当を伝える
    const check = window.setTimeout(() => {
      if (element.videoWidth > 0 && !track.muted) return;
      showNotice(
        track.readyState !== "live"
          ? "カメラが止まっています。Zoomなど、ほかのアプリやタブを閉じてから、もう一度カメラをつけてください。"
          : "カメラの映像が届いていません。Windowsの「設定」→「プライバシーとセキュリティ」→「カメラ」で、ブラウザのカメラ使用がオンか確認してください。ノートPCのカメラのシャッターやカメラ用のキーがオフになっていないかもご確認ください。",
      );
    }, 2500);
    return () => {
      window.clearTimeout(check);
      localVideo.detach(element);
    };
  }, [localVideo, phase]);

  useEffect(
    () => () => {
      const current = callRef.current;
      roomRef.current?.disconnect();
      roomRef.current = null;
      releaseWakeLock();
      if (current) {
        const action =
          phaseRef.current === "calling"
            ? "cancel"
            : phaseRef.current === "incoming"
              ? "reject"
              : "end";
        void fetch(`${apiRoot}/dm/${current.id}/${action}`, {
          method: "POST",
          headers: headersRef.current,
          keepalive: true,
        }).catch(() => undefined);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!showPanel || tab !== "history") return;
    let cancelled = false;
    setHistoryError("");
    void request("/dm/history")
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? "");
        if (!cancelled) setHistory(result.calls as DmCallView[]);
      })
      .catch(() => {
        if (!cancelled) setHistoryError("通話履歴を読み込めませんでした。");
      });
    return () => {
      cancelled = true;
    };
  }, [showPanel, tab, request]);

  const others = members.filter((member) => member.name !== myName);
  const missedKindNow = missedPrompt
    ? missedGuideKind(missedPrompt.id, missed, missedSequenceOn)
    : "only";
  const assistedChooser = assistedPick && visualSupportEnabled;
  const assistedNames = others.map((member) => member.name).join("\n");
  const busy = call !== null;
  const videoMode = phase === "incall" && (cameraOn || remoteCamOn);

  useEffect(() => {
    if (callsLeft !== null) onCallsLeftChange?.(callsLeft);
  }, [callsLeft, onCallsLeftChange]);

  useEffect(() => {
    onBusyChange?.(phase === "connecting" || phase === "incall");
    onIncomingChange?.(phase === "incoming");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const peerName = call?.peer ?? null;
  useEffect(() => {
    onCallPeerChange?.(peerName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerName]);

  useEffect(() => {
    if (!assistedChooser || !showPanel) {
      assistedSpokenRef.current = "";
      setPickIndex(0);
      setAssistedWaitSec(assistedFirstReplyWaitMs / 1000);
      return;
    }
    if (callsLeft === 0) {
      if (assistedSpokenRef.current !== "none-left") {
        assistedSpokenRef.current = "none-left";
        announceRef.current(
          "今日の1対1の電話は、3回まで使いました。また明日おかけください。",
        );
        onClosePanel();
        tellHome();
      }
      return;
    }
    const names = assistedNames ? assistedNames.split("\n") : [];
    if (names.length === 0) {
      if (assistedSpokenRef.current !== "empty") {
        assistedSpokenRef.current = "empty";
        announceRef.current("電話できる相手はいません。");
        onClosePanel();
        tellHome();
      }
      return;
    }
    const index = Math.min(pickIndex, names.length - 1);
    const name = names[index];
    const key = `${index}:${names.length}:${name}`;
    if (assistedSpokenRef.current === key) return;
    if (assistedSpokenRef.current === "" && index === 0) {
      assistedSpokenRef.current = key;
      return;
    }
    assistedSpokenRef.current = key;
    const lastPerson = index >= names.length - 1;
    callYesReadyRef.current = false;
    const token = ++callYesTokenRef.current;
    setAssistedWaitSec(assistedReplyWaitMs / 1000);
    announceRef.current(
      lastPerson && isAndroidDevice()
        ? `最後の${name}さんです。やめる、と言うと最初の画面に戻ります。`
        : lastPerson
          ? `最後の${name}さんです。`
          : `${name}さんです。`,
      () => {
        if (callYesTokenRef.current !== token) return;
        callYesReadyRef.current = true;
        window.clearTimeout(assistedReplyTimerRef.current);
        assistedReplyTimerRef.current = window.setTimeout(() => {
          if (callYesTokenRef.current === token) assistedTimeoutRef.current();
        }, assistedReplyWaitMs);
      },
    );
  }, [assistedChooser, showPanel, callsLeft, assistedNames, pickIndex, onClosePanel]);

  const assistedIndex =
    others.length === 0 ? 0 : Math.min(pickIndex, others.length - 1);
  const assistedPerson = others[assistedIndex];
  const assistedLast = others.length === 0 || assistedIndex >= others.length - 1;
  const assistedLastRef = useRef(false);
  assistedLastRef.current = assistedLast;
  const leaveLastPerson = () => {
    window.clearTimeout(assistedReplyTimerRef.current);
    callYesReadyRef.current = false;
    callYesTokenRef.current += 1;
    callYesRef.current?.cancel();
    callYesRef.current = null;
    announce("やめるが選択されました。");
    onClosePanel();
    tellHome();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  };
  const startAssistedReplyWait = (
    token: number,
    waitMs = assistedReplyWaitMs,
  ) => {
    window.clearTimeout(assistedReplyTimerRef.current);
    if (callYesTokenRef.current !== token) return;
    callYesReadyRef.current = true;
    setAssistedWaitSec(waitMs / 1000);
    assistedReplyTimerRef.current = window.setTimeout(() => {
      if (callYesTokenRef.current === token) assistedTimeoutRef.current();
    }, waitMs);
  };
  const assistedStop = () => {
    window.clearTimeout(assistedReplyTimerRef.current);
    window.clearTimeout(assistedListenTimerRef.current);
    callYesReadyRef.current = false;
    callYesTokenRef.current += 1;
    callYesRef.current?.cancel();
    callYesRef.current = null;
    announce("呼び出しを終わります。");
    onClosePanel();
    tellHome();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  };
  const assistedSkip = () => {
    window.clearTimeout(assistedReplyTimerRef.current);
    callYesReadyRef.current = false;
    callYesTokenRef.current += 1;
    if (!assistedPerson || others.length === 0) return;
    if ((isIphoneDevice() || isAndroidDevice()) && assistedLast) {
      leaveLastPerson();
      return;
    }
    const nextIndex = assistedLast ? 0 : assistedIndex + 1;
    const next = others[nextIndex];
    if (!next) return;
    setAssistedWaitSec(assistedReplyWaitMs / 1000);
    const last = others.length === 1 || nextIndex >= others.length - 1;
    assistedSpokenRef.current = `${nextIndex}:${others.length}:${next.name}`;
    const token = callYesTokenRef.current;
    announce(
      last && isAndroidDevice()
        ? `最後の${next.name}さんです。やめる、と言うと最初の画面に戻ります。`
        : last
          ? `最後の${next.name}さんです。`
          : `${next.name}さんです。`,
      () => startAssistedReplyWait(token),
    );
    setPickIndex(nextIndex);
  };
  const assistedTimeout = () => {
    if (!assistedPerson || others.length === 0) return;
    if (isAndroidDevice() && assistedLast) {
      window.clearTimeout(assistedReplyTimerRef.current);
      callYesReadyRef.current = false;
      callYesTokenRef.current += 1;
      callYesRef.current?.cancel();
      callYesRef.current = null;
      onClosePanel();
      tellHome();
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      return;
    }
    const nextIndex = assistedLast ? 0 : assistedIndex + 1;
    const next = others[nextIndex];
    if (!next) return;
    const last = others.length === 1 || nextIndex >= others.length - 1;
    setAssistedWaitSec(assistedReplyWaitMs / 1000);
    window.clearTimeout(assistedReplyTimerRef.current);
    callYesReadyRef.current = false;
    const token = ++callYesTokenRef.current;
    assistedSpokenRef.current = `${nextIndex}:${others.length}:${next.name}`;
    const nameLine = last ? `最後の${next.name}さんです。` : `${next.name}さんです。`;
    announce(`次の呼び出しをします。${nameLine}`, () => startAssistedReplyWait(token));
    setPickIndex(nextIndex);
  };
  const assistedCall = () => {
    if (!assistedPerson) return;
    window.clearTimeout(assistedReplyTimerRef.current);
    callYesReadyRef.current = false;
    callYesTokenRef.current += 1;
    callYesRef.current?.cancel();
    callYesRef.current = null;
    const iphone = isIphoneDevice();
    if (iphone) playCallingRing();
    const say = () =>
      announce(
        `${assistedPerson.name}さんを呼び出します。相手が出るまで、このままお待ちください。`,
        () => {
          if (iphone) playCallingRing();
        },
      );
    if (iphone) window.setTimeout(say, 700);
    else if (endGuidanceRef.current?.()) window.setTimeout(say, 100);
    else say();
    void startCall(assistedPerson.name);
  };
  assistedCallRef.current = assistedCall;
  assistedSkipRef.current = assistedSkip;
  assistedTimeoutRef.current = assistedTimeout;
  assistedStopRef.current = assistedStop;
  beginCallYesRef.current = () => {
    if (isIphoneDevice() || callYesRef.current) return;
    callYesRef.current = listenForAnswer({
      accept: isSpokenPlaceCall,
      isStop: (text) =>
        isSpokenStop(text) ||
        (isAndroidDevice() && assistedLastRef.current && isSpokenQuit(text)),
      gate: () => callYesReadyRef.current,
      onYes: () => {
        callYesRef.current = null;
        assistedCallRef.current();
      },
      onNext: () => {
        assistedSkipRef.current();
      },
      onStop: () => {
        callYesRef.current = null;
        assistedStopRef.current();
      },
    });
  };

  useEffect(() => {
    const open = assistedChooser && showPanel && !call && callsLeft !== 0;
    if (!open) {
      callYesRef.current?.cancel();
      callYesRef.current = null;
      window.clearTimeout(assistedReplyTimerRef.current);
      window.clearTimeout(assistedListenTimerRef.current);
    }
  }, [assistedChooser, showPanel, call, callsLeft]);

  useEffect(
    () => () => {
      callYesRef.current?.cancel();
      window.clearTimeout(assistedReplyTimerRef.current);
      window.clearTimeout(assistedListenTimerRef.current);
    },
    [],
  );

  const closePicker = () => {
    onClosePanel();
    tellHome();
  };
  const sheetDrag = useSheetDrag(closePicker);

  if (controlRef) {
    controlRef.current = {
      startCall: (to) => void startCall(to),
      hangUp: () => void hangUp(),
      armCallYes: () => {
        callYesReadyRef.current = false;
        callYesTokenRef.current += 1;
        callYesRef.current?.cancel();
        callYesRef.current = null;
        window.clearTimeout(assistedListenTimerRef.current);
      },
      releaseCallYes: () => {
        const token = callYesTokenRef.current;
        window.clearTimeout(assistedListenTimerRef.current);
        assistedListenTimerRef.current = window.setTimeout(() => {
          if (callYesTokenRef.current !== token) return;
          startAssistedReplyWait(token, assistedFirstReplyWaitMs);
          beginCallYesRef.current();
        }, spokenEchoGuardMs);
      },
      speakMissedGuide: () => {
        if (!isIphoneDevice() || !visualSupportRef.current || callRef.current) {
          return false;
        }
        const pending = [...missedRef.current]
          .filter((item) => !dismissedRef.current.has(item.id))
          .sort((a, b) => a.createdAt - b.createdAt);
        // タップ前に先頭の相手だけ案内済みになっているので、表示中の相手を先に話す
        const showing = pending.find((item) => item.id === missedPrompt?.id);
        const next =
          showing ??
          pending.find((item) => !askedMissedRef.current.has(item.id)) ??
          pending[0];
        if (!next) return false;
        askedMissedRef.current.add(next.id);
        const kind = missedGuideKind(
          next.id,
          pending,
          missedSequenceRef.current,
        );
        const line = missedGuideSpeech(
          next.peer,
          myName,
          true,
          kind,
          pending.length,
        );
        iphoneHoldPlayback = true;
        try {
          const session = audioSession();
          if (session && session.type !== "playback") session.type = "playback";
        } catch {
          // 古いiPhoneには音声セッションの切り替えがない
        }
        missedSpokenFromTapRef.current = next.id;
        setMissedPrompt(next);
        announceRef.current(line, () => {
          iphoneHoldPlayback = false;
          releaseIphonePlaybackSoon();
        });
        return true;
      },
    };
  }

  const topEndVisible =
    visualSupportEnabled &&
    !!call &&
    (phase === "calling" ||
      phase === "incoming" ||
      phase === "connecting" ||
      phase === "incall");
  const topEndLabel =
    phase === "calling" ? "やめる" : phase === "incoming" ? "出ない" : "電話を切る";
  const pressTopEnd = () => {
    if (phase === "incoming") {
      answerYesRef.current?.cancel();
      answerYesRef.current = null;
      incomingChoiceRef.current = true;
      announceRef.current("出ません。");
    }
    void hangUp();
  };
  const leaveFromTop = topEndVisible
    ? createPortal(
        <div className="voice-join-banner voice-leave-banner">
          <button
            className="voice-join-banner__button voice-leave-top"
            onClick={pressTopEnd}
            type="button"
          >
            {topEndLabel}
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {leaveFromTop}
      {assistedChooser &&
        showPanel &&
        !call &&
        callsLeft !== 0 &&
        assistedPerson && (
          <div
            aria-label="1対1の相手"
            className="dm-screen dm-screen--sides"
            role="alertdialog"
          >
            <p className="dm-screen__label">1対1の電話</p>
            <h2 className="dm-screen__name">{assistedPerson.name}さん</h2>
            <p className="dm-screen__hint">
              {isIphoneDevice()
                ? assistedLast
                  ? "右を押すと電話がかかります。左を押すとやめます。"
                  : "右を押すと電話がかかります。左を押すと次の人です。"
                : isAndroidDevice() && assistedLast
                  ? `やめる、と言うと最初の画面に戻ります。はい、または、かけるで呼び出します。${assistedWaitSec}秒返事がないと最初の画面に戻ります。`
                  : `次へで次の人です。はい、または、かけるで呼び出します。「終わる」で終わります。${assistedWaitSec}秒返事がないと次の人です。`}
            </p>
            <div className="dm-screen__sides">
              <button
                className="dm-side dm-side--decline"
                onClick={assistedSkip}
                type="button"
              >
                <small>左</small>
                {(isIphoneDevice() || isAndroidDevice()) && assistedLast ? "やめる" : "次の人"}
              </button>
              <button
                className="dm-side dm-side--answer"
                onClick={assistedCall}
                type="button"
              >
                <small>右</small>
                かける
              </button>
            </div>
          </div>
        )}

      {showPanel && !assistedChooser && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="dm-panel-title"
            aria-modal="true"
            className="group-panel voice-panel"
            role="dialog"
            style={sheetDrag.panelStyle}
          >
            <SheetHandle {...sheetDrag.handleProps} />
            <button
              aria-label="1対1通話を閉じる"
              className="dialog-close"
              onClick={closePicker}
            >
              ×
            </button>
            <p className="dialog-eyebrow">1対1の通話</p>
            <h2 id="dm-panel-title">電話をかける</h2>
            <div className="dm-tabs" role="tablist">
              <button
                aria-selected={tab === "pick"}
                className={`voice-button ${tab === "pick" ? "voice-button--join" : ""}`}
                onClick={() => setTab("pick")}
                role="tab"
              >
                相手を選ぶ
              </button>
              <button
                aria-selected={tab === "history"}
                className={`voice-button ${tab === "history" ? "voice-button--join" : ""}`}
                onClick={() => setTab("history")}
                role="tab"
              >
                通話履歴
              </button>
            </div>
            {tab === "pick" ? (
              <>
                <p className="voice-lead">
                  同じグループの人に、1対1で電話できます。相手がアプリを開いていると着信音が鳴ります。
                </p>
                <p className="dm-limit-note">
                  <strong>1回の通話は3分まで、1日3回までです。</strong>
                  {callsLeft !== null && (
                    <span className={callsLeft === 0 ? "is-empty" : ""}>
                      {callsLeft === 0
                        ? "今日はもうかけられません。また明日おかけください。"
                        : `今日はあと${callsLeft}回かけられます。`}
                    </span>
                  )}
                </p>
                {others.length === 0 ? (
                  <p className="voice-lead">電話できる相手がいません。</p>
                ) : (
                  <ul className="dm-list">
                    {others.map((member) => (
                      <li key={member.name}>
                        <button
                          className="dm-person"
                          disabled={busy || callsLeft === 0}
                          onClick={() => void startCall(member.name)}
                        >
                          <span className="dm-person__name">{member.name}さん</span>
                          <span className="dm-person__action">📞 電話をかける</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : historyError ? (
              <p className="form-error" role="alert">
                {historyError}
              </p>
            ) : history.length === 0 ? (
              <p className="voice-lead">通話履歴はまだありません。</p>
            ) : (
              <ul className="dm-list">
                {history.map((item) => (
                  <li
                    className={`dm-history ${item.status === "missed" && item.direction === "incoming" ? "is-missed" : ""}`}
                    key={item.id}
                  >
                    <div>
                      <strong>{item.peer}さん</strong>
                      <time className="dm-history__time">
                        🕒 {formatDateTime(item.createdAt)}
                      </time>
                      <span>{historyLabel(item)}</span>
                    </div>
                    <button
                      className="voice-button"
                      disabled={busy}
                      onClick={() => void startCall(item.peer)}
                    >
                      かけ直す
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {missedPrompt && !call && (
        <div
          aria-label="かけ直すかの確認"
          className="dm-screen dm-screen--sides"
          role="alertdialog"
        >
          <p className="dm-screen__label">着信がありました</p>
          <h2 className="dm-screen__name">{missedPrompt.peer}さん</h2>
          <p className="dm-screen__hint">
            {missedGuideHint(
              missedPrompt.peer,
              myName,
              isIphoneDevice(),
              missedKindNow,
              missed.length,
            )}
          </p>
          <div className="dm-screen__sides">
            <button
              className="dm-side dm-side--decline"
              onClick={() => missedChoiceRef.current.no()}
              type="button"
            >
              <small>左</small>
              {missedKindNow === "first" || missedKindNow === "next" ? "次の人" : "戻る"}
            </button>
            <button
              className="dm-side dm-side--answer"
              onClick={() => missedChoiceRef.current.yes()}
              type="button"
            >
              <small>右</small>
              かけなおす
            </button>
          </div>
        </div>
      )}

      {missed.length > 0 && !call && !visualSupportEnabled && (
        <div className="dm-missed" role="alert">
          {missed.map((item) => (
            <div className="dm-missed__item" key={item.id}>
              <p>
                📞 {item.peer}さんから電話がありました
                <small>（{formatClock(item.createdAt)}）</small>
              </p>
              <div className="dm-missed__actions">
                <button
                  className="voice-button voice-button--join"
                  disabled={busy}
                  onClick={() => {
                    dismissMissed([item]);
                    void startCall(item.peer);
                  }}
                >
                  かけ直す
                </button>
                <button className="voice-button" onClick={() => dismissMissed([item])}>
                  閉じる
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {call && phase && (
        <div
          className={`dm-screen ${videoMode ? "dm-screen--video" : ""} ${phase === "incoming" && visualSupportEnabled ? "dm-screen--sides" : ""} ${topEndVisible ? "dm-screen--leave" : ""}`}
          role="alertdialog"
          aria-label="1対1通話"
        >
          <p className="dm-screen__label">
            {phase === "incoming"
              ? "電話がかかってきました"
              : phase === "calling"
                ? "呼び出し中です"
                : phase === "connecting"
                  ? "つないでいます…"
                  : "通話中"}
          </p>
          <h2 className="dm-screen__name">{call.peer}さん</h2>
          {phase === "incall" && (
            <>
              <p
                className={`dm-screen__time ${remaining <= warningSec ? "is-warning" : ""}`}
              >
                のこり {Math.floor(remaining / 60)}:
                {String(remaining % 60).padStart(2, "0")}
              </p>
              <p className="dm-screen__limit">
                {remaining <= warningSec
                  ? `もうすぐ終わります（あと${remaining}秒）`
                  : "1回の通話は3分までです"}
              </p>
              <p className={`dm-screen__speaking ${peerSpeaking ? "is-on" : ""}`}>
                {peerSpeaking ? "🔊 話しています" : "　"}
              </p>
            </>
          )}
          {phase === "incall" && (
            <div
              className={`dm-video ${cameraOn || remoteCamOn ? "" : "is-hidden"}`}
            >
              <video
                autoPlay
                className={`dm-video__remote ${remoteCamOn ? "is-on" : ""}`}
                playsInline
                ref={remoteVideoRef}
              />
              {!remoteCamOn && (
                <p className="dm-video__off">
                  📷 {call.peer}さんのカメラはオフです
                </p>
              )}
              <video
                autoPlay
                className={`dm-video__local ${cameraOn ? "is-on" : ""} ${remoteCamOn ? "" : "is-main"}`}
                muted
                playsInline
                ref={localVideoRef}
              />
            </div>
          )}
          {phase === "calling" && (
            <p className="dm-screen__hint">相手が出るまでお待ちください</p>
          )}
          {phase === "incoming" && (
            <p className="dm-screen__hint">
              {visualSupportEnabled
                ? isIphoneDevice()
                  ? "出るときは、下の緑を押します。出ないときは、一番上の、出ない、を押してください。1回の通話は3分です。"
                  : "出ます、または、はいと言うと出ます。出ないときは、一番上の、出ない、を押してください。1回の通話は3分です。"
                : "1回の通話は3分までです"}
            </p>
          )}
          {phase === "incoming" && visualSupportEnabled ? (
            <div className="dm-screen__sides">
              <button
                className="dm-side dm-side--answer dm-side--full"
                onClick={() => {
                  answerYesRef.current?.cancel();
                  answerYesRef.current = null;
                  incomingChoiceRef.current = true;
                  announceRef.current("出ます。この通話は3分です。");
                  void answer();
                }}
                type="button"
              >
                出る
              </button>
            </div>
          ) : phase === "incoming" ? (
            <div className="dm-screen__actions dm-screen__actions--two">
              <button
                className="dm-big-button dm-big-button--end"
                onClick={() => void hangUp()}
                type="button"
              >
                出ない
              </button>
              <button
                className="dm-big-button dm-big-button--answer"
                onClick={() => void answer()}
                type="button"
              >
                出る
              </button>
            </div>
          ) : (
            <div className="dm-screen__actions">
              {phase === "incall" && (
                <>
                  <button
                    className={`dm-big-button dm-big-button--sub dm-big-button--camera ${cameraOn ? "is-on" : ""}`}
                    disabled={cameraBusy}
                    onClick={() => void toggleCamera()}
                  >
                    {videoMode
                      ? cameraOn
                        ? "📷 カメラを消す"
                        : "📷 カメラをつける"
                      : cameraOn
                        ? "📷 カメラはオンです（押すと消します）"
                        : "📷 カメラをつける"}
                  </button>
                  {cameraOn && (
                    <p className="dm-screen__hint">
                      あなたの顔が相手に見えています
                    </p>
                  )}
                  <button
                    className={`dm-big-button dm-big-button--sub ${muted ? "is-muted" : ""}`}
                    onClick={() => void toggleMute()}
                  >
                    {videoMode
                      ? muted
                        ? "🔇 マイクオフ"
                        : "🎤 マイクオン"
                      : muted
                        ? "🔇 マイクがオフです（押すとオン）"
                        : "🎤 マイクはオンです"}
                  </button>
                  <div className="dm-volume">
                    <button
                      aria-label="相手の声を小さくする"
                      disabled={volumeIndex === 0}
                      onClick={() => changeVolume(-1)}
                    >
                      −
                    </button>
                    <span>相手の声の大きさ {volumeIndex + 1} / {volumeSteps.length}</span>
                    <button
                      aria-label="相手の声を大きくする"
                      disabled={volumeIndex === volumeSteps.length - 1}
                      onClick={() => changeVolume(1)}
                    >
                      ＋
                    </button>
                  </div>
                  <p className="dm-screen__hint">
                    声が響くときは、イヤホンを使うと聞き取りやすくなります。
                  </p>
                </>
              )}
              {!topEndVisible && (
              <button
                className="dm-big-button dm-big-button--end"
                onClick={() => void hangUp()}
                  type="button"
              >
                {phase === "calling" ? "やめる" : "電話を切る"}
              </button>
              )}
            </div>
          )}
        </div>
      )}

      {notice && !visualSupportEnabled && (
        <div className="dm-notice-backdrop">
          <section
            aria-labelledby="dm-notice-title"
            aria-modal="true"
            className="confirm-dialog"
            role="alertdialog"
          >
            <h2 id="dm-notice-title" className="dm-notice__text">
              {notice}
            </h2>
            <button
              className="dialog-button dialog-button--send retention-notice__close"
              onClick={() => setNotice("")}
            >
              閉じる
            </button>
          </section>
        </div>
      )}

      {showListenNotice && (
        <div className="dm-notice-backdrop">
          <section
            aria-labelledby="dm-listen-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <p className="dialog-eyebrow">電話の着信について</p>
            <h2 id="dm-listen-title">電話の通知について</h2>
            <p className="dialog-note">
              アプリを開いている間は、着信音が鳴ります。アプリを閉じているときは、通知をオンにしていると「〇〇さんから電話です」とお知らせが届きます（音は端末の通知音です）。通知をオンにしていないと、電話に気づけません。
            </p>
            <button
              className="dialog-button dialog-button--send retention-notice__close"
              onClick={() => {
                localStorage.setItem(listenNoticeKey, "seen");
                setShowListenNotice(false);
                unlockAudio();
              }}
            >
              確認しました
            </button>
          </section>
        </div>
      )}
      <div aria-hidden="true" hidden ref={audioRef} />
    </>
  );
}
