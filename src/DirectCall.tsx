import {
  MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AudioPresets,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";

type DmStatus = "ringing" | "active" | "ended" | "missed" | "rejected" | "busy";
type DmCallView = {
  id: string;
  peer: string;
  direction: "outgoing" | "incoming";
  status: DmStatus;
  createdAt: number;
  durationSec: number;
};
type Phase = "calling" | "incoming" | "connecting" | "incall";

type DirectCallProps = {
  apiRoot: string;
  headers: Record<string, string>;
  myName: string;
  members: { name: string }[];
  showPanel: boolean;
  onClosePanel: () => void;
  onListeningChange: (listening: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onCallPeerChange?: (peer: string | null) => void;
  controlRef?: MutableRefObject<DirectCallControl | null>;
  notify: (title: string, body: string, tag: string) => void;
};
export type DirectCallControl = {
  startCall: (to: string) => void;
  hangUp: () => void;
};

const pollIntervalMs = 2000;
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
  onClosePanel,
  onListeningChange,
  onBusyChange,
  onCallPeerChange,
  controlRef,
  notify,
}: DirectCallProps) {
  const [call, setCall] = useState<DmCallView | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [notice, setNotice] = useState("");
  const [muted, setMuted] = useState(false);
  const [volumeIndex, setVolumeIndex] = useState(2);
  const [peerSpeaking, setPeerSpeaking] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [tab, setTab] = useState<"pick" | "history">("pick");
  const [history, setHistory] = useState<DmCallView[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [missed, setMissed] = useState<DmCallView[]>([]);
  const [showListenNotice, setShowListenNotice] = useState(
    () => localStorage.getItem(listenNoticeKey) !== "seen",
  );

  const headersRef = useRef(headers);
  headersRef.current = headers;
  const callRef = useRef<DmCallView | null>(null);
  const phaseRef = useRef<Phase | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const remoteTracksRef = useRef<RemoteAudioTrack[]>([]);
  const volumeRef = useRef(volumeSteps[2]);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const pollingRef = useRef(false);
  const listeningRef = useRef<boolean | null>(null);
  const notifiedRef = useRef(new Set<string>());
  const dismissedRef = useRef(new Set<string>());
  const hangingUpRef = useRef(false);

  const changeCall = (next: DmCallView | null, nextPhase: Phase | null) => {
    callRef.current = next;
    phaseRef.current = nextPhase;
    setCall(next);
    setPhase(nextPhase);
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
    setMuted(false);
    setPeerSpeaking(false);
  };

  const finishCall = (message: string) => {
    leaveRoom();
    changeCall(null, null);
    setSeconds(0);
    if (message) setNotice(message);
  };

  const hangUp = async () => {
    const current = callRef.current;
    if (!current || hangingUpRef.current) return;
    hangingUpRef.current = true;
    const wasTalking = phaseRef.current === "incall";
    const action = phaseRef.current === "calling" ? "cancel" : phaseRef.current === "incoming" ? "reject" : "end";
    finishCall(wasTalking ? "通話を終了しました。" : "");
    try {
      await request(`/dm/${current.id}/${action}`, { method: "POST" });
    } finally {
      hangingUpRef.current = false;
    }
  };

  const connectRoom = async (callId: string) => {
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
        },
      });
      roomRef.current = room;
      room
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio) return;
          const audioTrack = track as RemoteAudioTrack;
          audioTrack.setVolume(volumeRef.current);
          remoteTracksRef.current.push(audioTrack);
          audioRef.current?.appendChild(track.attach());
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((element) => element.remove());
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
      phaseRef.current = "incall";
      setPhase("incall");
      setSeconds(0);
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
      setNotice(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "マイクが許可されていません。ブラウザの設定でマイクを許可してください。"
          : reason instanceof Error
            ? reason.message
            : "通話をつなげませんでした。",
      );
    }
  };

  const startCall = async (to: string) => {
    unlockAudio();
    if (callRef.current) return;
    try {
      const response = await request("/dm/call", {
        method: "POST",
        body: JSON.stringify({ to }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(result.error ?? "電話をかけられませんでした。");
        return;
      }
      onClosePanel();
      changeCall(result.call as DmCallView, "calling");
    } catch {
      setNotice("電話をかけられませんでした。通信状態を確認してください。");
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
        if (current && watched) {
          if (watched.status === "active") {
            if (phaseRef.current === "calling") void connectRoom(current.id);
          } else if (watched.status !== "ringing") {
            const wasPhase = phaseRef.current;
            if (wasPhase === "calling") {
              finishCall(
                watched.status === "rejected"
                  ? `${current.peer}さんは電話に出られませんでした。`
                  : `${current.peer}さんは電話に出ませんでした。`,
              );
            } else if (wasPhase === "incoming") {
              finishCall(`${current.peer}さんからの電話は切れました。`);
            } else if (wasPhase === "incall" || wasPhase === "connecting") {
              finishCall(
                `通話が終わりました。${
                  watched.durationSec ? `（${formatDuration(watched.durationSec)}）` : ""
                }`,
              );
            }
          }
        } else if (!current && result.incoming) {
          const incoming = result.incoming as DmCallView;
          changeCall(incoming, "incoming");
          if (document.hidden && !notifiedRef.current.has(incoming.id)) {
            notifiedRef.current.add(incoming.id);
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
        missedCalls.forEach((item) => {
          if (document.hidden && !notifiedRef.current.has(item.id)) {
            notifiedRef.current.add(item.id);
            notify(
              `${item.peer}さんから電話がありました`,
              formatDateTime(item.createdAt),
              `dm-${item.id}`,
            );
          }
        });
      } catch {
        if (listeningRef.current !== false) {
          listeningRef.current = false;
          onListeningChange(false);
        }
      } finally {
        pollingRef.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), pollIntervalMs);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (phase !== "incoming" && phase !== "calling") return;
    return startRinging(phase);
  }, [phase]);

  useEffect(() => {
    if (phase !== "incall") return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

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
  const busy = call !== null;

  useEffect(() => {
    onBusyChange?.(phase === "connecting" || phase === "incall");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const peerName = call?.peer ?? null;
  useEffect(() => {
    onCallPeerChange?.(peerName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerName]);

  if (controlRef) {
    controlRef.current = {
      startCall: (to) => void startCall(to),
      hangUp: () => void hangUp(),
    };
  }

  return (
    <>
      {showPanel && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="dm-panel-title"
            aria-modal="true"
            className="group-panel voice-panel"
            role="dialog"
          >
            <button
              aria-label="1対1通話を閉じる"
              className="dialog-close"
              onClick={onClosePanel}
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
                {others.length === 0 ? (
                  <p className="voice-lead">電話できる相手がいません。</p>
                ) : (
                  <ul className="dm-list">
                    {others.map((member) => (
                      <li key={member.name}>
                        <button
                          className="dm-person"
                          disabled={busy}
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

      {missed.length > 0 && !call && (
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
        <div className="dm-screen" role="alertdialog" aria-label="1対1通話">
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
              <p className="dm-screen__time">
                {String(Math.floor(seconds / 60)).padStart(2, "0")}:
                {String(seconds % 60).padStart(2, "0")}
              </p>
              <p className={`dm-screen__speaking ${peerSpeaking ? "is-on" : ""}`}>
                {peerSpeaking ? "🔊 話しています" : "　"}
              </p>
            </>
          )}
          {phase === "calling" && (
            <p className="dm-screen__hint">相手が出るまでお待ちください</p>
          )}
          {phase === "incoming" ? (
            <div className="dm-screen__actions dm-screen__actions--two">
              <button
                className="dm-big-button dm-big-button--end"
                onClick={() => void hangUp()}
              >
                出ない
              </button>
              <button
                className="dm-big-button dm-big-button--answer"
                onClick={() => void answer()}
              >
                出る
              </button>
            </div>
          ) : (
            <div className="dm-screen__actions">
              {phase === "incall" && (
                <>
                  <button
                    className={`dm-big-button dm-big-button--sub ${muted ? "is-muted" : ""}`}
                    onClick={() => void toggleMute()}
                  >
                    {muted ? "🔇 マイクがオフです（押すとオン）" : "🎤 マイクはオンです"}
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
              <button
                className="dm-big-button dm-big-button--end"
                onClick={() => void hangUp()}
              >
                {phase === "calling" ? "やめる" : "電話を切る"}
              </button>
            </div>
          )}
        </div>
      )}

      {notice && (
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
