import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Room, RoomEvent, Track } from "livekit-client";
import VoiceGame from "./VoiceGame";
import VoiceWordGame from "./VoiceWordGame";
import VoiceTurnGame from "./VoiceTurnGame";
import { SheetHandle, useSheetDrag } from "./sheetDrag";

type VoiceCallProps = {
  apiRoot: string;
  headers: Record<string, string>;
  myName: string;
  onClose: () => void;
  autoJoin?: boolean;
  announce?: (text: string) => void;
  /** 視覚サポートがオンのとき、大きな退出ボタンと案内を出します。 */
  assisted?: boolean;
  speak?: (text: string) => void;
  endGuidance?: () => boolean;
};

type Status = "idle" | "connecting" | "connected" | "error";
type Reaction = "hand" | "smile" | "puzzled";

const reactionMarks: Record<Reaction, string> = {
  hand: "✋",
  smile: "😊",
  puzzled: "😕",
};

const reactionChoices: Array<[Reaction, string]> = [
  ["hand", "手を挙げる"],
  ["smile", "笑顔"],
  ["puzzled", "困った顔"],
];

const reactionOf = (attributes: Record<string, string> | undefined): Reaction | "" => {
  const value = attributes?.reaction;
  if (value === "hand" || value === "smile" || value === "puzzled") return value;
  return "";
};

export default function VoiceCall({
  apiRoot,
  headers,
  myName,
  onClose,
  autoJoin = false,
  announce,
  assisted = false,
  speak,
  endGuidance,
}: VoiceCallProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [gameTab, setGameTab] = useState<"quiz" | "word" | "turn">("quiz");
  const [names, setNames] = useState<string[]>([]);
  const [speaking, setSpeaking] = useState<string[]>([]);
  const [reactions, setReactions] = useState<Record<string, Reaction>>({});
  const [reactionNotice, setReactionNotice] = useState("");
  const [leaveNotice, setLeaveNotice] = useState("");
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const announcedJoinRef = useRef(false);
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const speakRef = useRef(speak);
  speakRef.current = speak;
  const endGuidanceRef = useRef(endGuidance);
  endGuidanceRef.current = endGuidance;
  const assistedRef = useRef(assisted);
  assistedRef.current = assisted;

  const refreshParticipants = (room: Room) => {
    const people = [
      room.localParticipant,
      ...room.remoteParticipants.values(),
    ];
    const nextReactions: Record<string, Reaction> = {};
    setNames(
      people.map((participant) => {
        const name = participant.name || participant.identity;
        const reaction = reactionOf(participant.attributes);
        if (reaction) nextReactions[name] = reaction;
        return name;
      }),
    );
    setReactions(nextReactions);
  };

  const leave = () => {
    roomRef.current?.disconnect();
    roomRef.current = null;
    if (audioRef.current) audioRef.current.innerHTML = "";
    setStatus("idle");
    setNames([]);
    setSpeaking([]);
    setReactions({});
    setReactionNotice("");
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
        .on(RoomEvent.ParticipantAttributesChanged, () => refreshParticipants(room))
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
      if (!announcedJoinRef.current && (announceRef.current || assistedRef.current)) {
        announcedJoinRef.current = true;
        const others = [...room.remoteParticipants.values()]
          .map((participant) => participant.name || participant.identity)
          .filter((name) => name && name !== myName);
        const leaveNote = assistedRef.current
          ? "終わるときは、一番上の、通話から抜ける、を押してください。"
          : "";
        const message =
          others.length > 0
            ? `通話に入りました。${others.join("さん、")}さんがいらっしゃいます。${leaveNote}`
            : `通話に入りました。まだほかの人はいません。${leaveNote}`;
        const say = () => {
          if (announceRef.current) announceRef.current(message);
          else speakRef.current?.(message);
        };
        if (endGuidanceRef.current?.()) window.setTimeout(say, 100);
        else say();
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

  const toggleReaction = async (mark: Reaction) => {
    const room = roomRef.current;
    if (!room) return;
    const next = reactionOf(room.localParticipant.attributes) === mark ? "" : mark;
    setReactionNotice("");
    try {
      await room.localParticipant.setAttributes({ reaction: next });
      refreshParticipants(room);
    } catch (reason) {
      console.error("通話のマークを送れませんでした", reason);
      setReactionNotice("マークを伝えられませんでした。しばらくしてから、もう一度押してください。");
    }
  };

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
  const sheetDrag = useSheetDrag(close);

  const leaveFromTop = () => {
    leave();
    const message = "通話から抜けました。ほかの人の通話は続きます。";
    setLeaveNotice(message);
    speakRef.current?.(message);
    onClose();
  };

  const leaveBanner =
    assisted && (status === "connected" || status === "connecting")
      ? createPortal(
          <div className="voice-join-banner voice-leave-banner">
            <button
              className="voice-join-banner__button voice-leave-top"
              onClick={leaveFromTop}
              type="button"
            >
              通話から抜ける
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="dialog-backdrop">
      {leaveBanner}
      <section
        aria-labelledby="voice-title"
        aria-modal="true"
        className="group-panel voice-panel"
        role="dialog"
        style={sheetDrag.panelStyle}
      >
        <SheetHandle {...sheetDrag.handleProps} />
        <button
          aria-label="音声通話を閉じる"
          className="dialog-close"
          onClick={close}
        >
          ×
        </button>
        <p className="dialog-eyebrow">グループの音声通話</p>
        <h2 id="voice-title">みんなで通話</h2>

        {status === "connected" ? (
          <>
            <p className="voice-status">通話中（{names.length}人）</p>
            {announce && !assisted && (
              <p className="voice-leave-hint">
                抜けるときは、下の「通話から抜ける」を押してください。声では抜けられません。
              </p>
            )}
            <ul className="voice-members">
              {names.map((name, index) => (
                <li
                  className={speaking.includes(name) ? "is-speaking" : ""}
                  key={`${name}-${index}`}
                >
                  {name}
                  {name === myName ? "（あなた）" : ""}
                  {reactions[name] ? (
                    <span className="voice-reaction-mark">{reactionMarks[reactions[name]]}</span>
                  ) : null}
                  {speaking.includes(name) ? " 🔊" : ""}
                </li>
              ))}
            </ul>
            <div className="voice-reactions">
              <p>マークは、もう一度押すと消えます。</p>
              {reactionChoices.map(([mark, label]) => (
                <button
                  aria-pressed={reactions[myName] === mark}
                  className={`voice-reaction-button${
                    reactions[myName] === mark ? " is-selected" : ""
                  }`}
                  key={mark}
                  onClick={() => void toggleReaction(mark)}
                  type="button"
                >
                  <span aria-hidden="true">{reactionMarks[mark]}</span>
                  {label}
                </button>
              ))}
              {reactionNotice && (
                <p className="form-error" role="status">
                  {reactionNotice}
                </p>
              )}
            </div>
            <div className="voice-actions">
              <button
                className={`voice-button ${muted ? "is-muted" : ""}`}
                onClick={() => void toggleMute()}
              >
                {muted ? "マイクをオンにする" : "マイクをオフにする"}
              </button>
              {!assisted && (
                <button className="voice-button voice-button--leave" onClick={leave}>
                  通話から抜ける
                </button>
              )}
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
