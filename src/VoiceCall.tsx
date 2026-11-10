import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import VoiceGame from "./VoiceGame";
import VoiceWordGame from "./VoiceWordGame";
import VoiceTurnGame from "./VoiceTurnGame";

type VoiceCallProps = {
  apiRoot: string;
  headers: Record<string, string>;
  myName: string;
  onClose: () => void;
  autoJoin?: boolean;
  announce?: (text: string) => void;
  /** 視覚サポートがオンの端末だけ、この秒数で自分だけ抜けます。 */
  leaveAfterSec?: number;
  speak?: (text: string) => void;
};

type Status = "idle" | "connecting" | "connected" | "error";

export default function VoiceCall({
  apiRoot,
  headers,
  myName,
  onClose,
  autoJoin = false,
  announce,
  leaveAfterSec,
  speak,
}: VoiceCallProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [gameTab, setGameTab] = useState<"quiz" | "word" | "turn">("quiz");
  const [names, setNames] = useState<string[]>([]);
  const [speaking, setSpeaking] = useState<string[]>([]);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [leaveNotice, setLeaveNotice] = useState("");
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const announcedJoinRef = useRef(false);
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const speakRef = useRef(speak);
  speakRef.current = speak;
  const leaveAfterSecRef = useRef(leaveAfterSec);
  leaveAfterSecRef.current = leaveAfterSec;

  const refreshParticipants = (room: Room) => {
    setNames([
      room.localParticipant.name || myName,
      ...[...room.remoteParticipants.values()].map(
        (participant) => participant.name || participant.identity,
      ),
    ]);
  };

  const leave = () => {
    roomRef.current?.disconnect();
    roomRef.current = null;
    if (audioRef.current) audioRef.current.innerHTML = "";
    setStatus("idle");
    setNames([]);
    setSpeaking([]);
    setMuted(false);
    announcedJoinRef.current = false;
  };

  const join = async () => {
    setStatus("connecting");
    setError("");
    setLeaveNotice("");
    try {
      const response = await fetch(`${apiRoot}/voice/token`, {
        method: "POST",
        headers,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.token || !result.url) {
        throw new Error(
          result.error ??
            (response.status === 404
              ? "音声通話のサーバーが更新されていません。"
              : "通話を開始できませんでした。"),
        );
      }
      const room = new Room({ adaptiveStream: false, dynacast: true });
      roomRef.current = room;
      room
        .on(RoomEvent.ParticipantConnected, () => refreshParticipants(room))
        .on(RoomEvent.ParticipantDisconnected, () => refreshParticipants(room))
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) =>
          setSpeaking(speakers.map((speaker) => speaker.name || speaker.identity)),
        )
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) {
            const element = track.attach();
            audioRef.current?.appendChild(element);
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((element) => element.remove());
        })
        .on(RoomEvent.Disconnected, () => {
          if (roomRef.current === room) leave();
        });
      await room.connect(result.url, result.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      refreshParticipants(room);
      setStatus("connected");
      if (announceRef.current && !announcedJoinRef.current) {
        announcedJoinRef.current = true;
        const others = [...room.remoteParticipants.values()]
          .map((participant) => participant.name || participant.identity)
          .filter((name) => name && name !== myName);
        const limitNote = leaveAfterSecRef.current
          ? "3分で、あなただけ終わります。早く終わるときは、一番上の、通話から抜ける、を押してください。"
          : "";
        announceRef.current(
          others.length > 0
            ? `通話に入りました。${others.join("さん、")}さんがいらっしゃいます。${limitNote}`
            : `通話に入りました。まだほかの人はいません。${limitNote}`,
        );
      }
    } catch (reason) {
      roomRef.current?.disconnect();
      roomRef.current = null;
      setStatus("error");
      const message =
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "マイクが許可されていません。ブラウザの設定で許可してください。"
          : reason instanceof Error
            ? reason.message
            : "通話を開始できませんでした。";
      setError(message);
      announceRef.current?.(message);
    }
  };

  useEffect(() => {
    if (!autoJoin) return;
    const timer = window.setTimeout(() => {
      void join();
    }, 0);
    return () => window.clearTimeout(timer);
    // 声で参加を選んだときだけ、開いた直後に一度つなぐ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== "connected" || !leaveAfterSec) {
      setSecondsLeft(null);
      return;
    }
    let cancelled = false;
    const started = Date.now();
    const limitMs = leaveAfterSec * 1000;
    const warnMs = Math.max(0, limitMs - 30_000);
    setSecondsLeft(leaveAfterSec);
    if (!announcedJoinRef.current) {
      speakRef.current?.(
        "3分間の通話となります。3分で、あなただけ終わります。早く終わるときは、一番上の、通話から抜ける、を押してください。",
      );
    }
    const tick = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((limitMs - (Date.now() - started)) / 1000));
      setSecondsLeft(left);
    }, 1000);
    const warning = window.setTimeout(() => {
      if (!cancelled) speakRef.current?.("まもなく通話が終わります。");
    }, warnMs);
    const end = window.setTimeout(() => {
      if (cancelled) return;
      leave();
      const message =
        "3分になったので、通話から抜けました。ほかの人の通話は続きます。";
      setLeaveNotice(message);
      speakRef.current?.(message);
    }, limitMs);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
      window.clearTimeout(warning);
      window.clearTimeout(end);
    };
    // leave はその時点の通話だけを切る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, leaveAfterSec]);

  const toggleMute = async () => {
    const room = roomRef.current;
    if (!room) return;
    const nextMuted = !muted;
    await room.localParticipant.setMicrophoneEnabled(!nextMuted);
    setMuted(nextMuted);
  };

  useEffect(
    () => () => {
      void roomRef.current?.disconnect();
    },
    [],
  );

  const close = () => {
    leave();
    onClose();
  };

  const leaveFromTop = () => {
    leave();
    const message = "通話から抜けました。ほかの人の通話は続きます。";
    setLeaveNotice(message);
    speakRef.current?.(message);
    onClose();
  };

  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby="voice-title"
        aria-modal="true"
        className="group-panel voice-panel"
        role="dialog"
      >
        <button
          aria-label="音声通話を閉じる"
          className="dialog-close"
          onClick={close}
        >
          ×
        </button>
        {leaveAfterSec && (status === "connected" || status === "connecting") && (
          <button
            className="voice-leave-top"
            onClick={leaveFromTop}
            type="button"
          >
            通話から抜ける
          </button>
        )}
        <p className="dialog-eyebrow">グループの音声通話</p>
        <h2 id="voice-title">みんなで通話</h2>

        {status === "connected" ? (
          <>
            <p className="voice-status">通話中（{names.length}人）</p>
            {leaveAfterSec ? (
              <p className="voice-leave-hint">
                {secondsLeft === null
                  ? "3分で、あなただけ通話から抜けます。"
                  : secondsLeft >= 60
                    ? `残り${Math.floor(secondsLeft / 60)}分${secondsLeft % 60}秒で、あなただけ通話から抜けます。`
                    : `残り${secondsLeft}秒で、あなただけ通話から抜けます。`}
                ほかの人の通話は続きます。早く抜けるときは、一番上の「通話から抜ける」を押してください。
              </p>
            ) : (
              announce && (
                <p className="voice-leave-hint">
                  抜けるときは、下の「通話から抜ける」を押してください。声では抜けられません。
                </p>
              )
            )}
            <ul className="voice-members">
              {names.map((name, index) => (
                <li
                  className={speaking.includes(name) ? "is-speaking" : ""}
                  key={`${name}-${index}`}
                >
                  {name}
                  {name === myName ? "（あなた）" : ""}
                  {speaking.includes(name) ? " 🔊" : ""}
                </li>
              ))}
            </ul>
            <div className="voice-actions">
              <button
                className={`voice-button ${muted ? "is-muted" : ""}`}
                onClick={() => void toggleMute()}
              >
                {muted ? "マイクをオンにする" : "マイクをオフにする"}
              </button>
              <button
                className="voice-button voice-button--leave"
                onClick={leaveAfterSec ? leaveFromTop : leave}
              >
                通話から抜ける
              </button>
            </div>
            <div className="voice-tabs" role="tablist">
              <button
                className={`voice-button ${gameTab === "quiz" ? "voice-button--join" : ""}`}
                onClick={() => setGameTab("quiz")}
              >
                🧠 脳活クイズ
              </button>
              <button
                className={`voice-button ${gameTab === "word" ? "voice-button--join" : ""}`}
                onClick={() => setGameTab("word")}
              >
                🗣️ 言葉あて
              </button>
              <button
                className={`voice-button ${gameTab === "turn" ? "voice-button--join" : ""}`}
                onClick={() => setGameTab("turn")}
              >
                🔤 しりとり・連想
              </button>
            </div>
            {gameTab === "quiz" ? (
              <VoiceGame
                apiRoot={apiRoot}
                headers={headers}
                myName={myName}
                names={names}
              />
            ) : gameTab === "turn" ? (
              <VoiceTurnGame
                apiRoot={apiRoot}
                headers={headers}
                myName={myName}
                names={names}
              />
            ) : (
              <VoiceWordGame
                apiRoot={apiRoot}
                headers={headers}
                myName={myName}
                names={names}
              />
            )}
          </>
        ) : (
          <>
            <p className="voice-lead">
              {autoJoin && status === "connecting"
                ? "グループ通話につないでいます。しばらくお待ちください。"
                : "同じグループの参加者と、声で話せます。参加するとマイクを使います。"}
            </p>
            {leaveNotice && (
              <p className="voice-leave-hint" role="status">
                {leaveNotice}
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="voice-button voice-button--join"
              disabled={status === "connecting"}
              onClick={() => void join()}
            >
              {status === "connecting" ? "接続しています…" : "通話に参加する"}
            </button>
          </>
        )}
        <div aria-hidden="true" hidden ref={audioRef} />
      </section>
    </div>
  );
}
