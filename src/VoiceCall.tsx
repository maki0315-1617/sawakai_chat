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
};

type Status = "idle" | "connecting" | "connected" | "error";

export default function VoiceCall({
  apiRoot,
  headers,
  myName,
  onClose,
}: VoiceCallProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [gameTab, setGameTab] = useState<"quiz" | "word" | "turn">("quiz");
  const [names, setNames] = useState<string[]>([]);
  const [speaking, setSpeaking] = useState<string[]>([]);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);

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
  };

  const join = async () => {
    setStatus("connecting");
    setError("");
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
    } catch (reason) {
      roomRef.current?.disconnect();
      roomRef.current = null;
      setStatus("error");
      setError(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "マイクが許可されていません。ブラウザの設定で許可してください。"
          : reason instanceof Error
            ? reason.message
            : "通話を開始できませんでした。",
      );
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
        <p className="dialog-eyebrow">グループの音声通話</p>
        <h2 id="voice-title">みんなで通話</h2>

        {status === "connected" ? (
          <>
            <p className="voice-status">通話中（{names.length}人）</p>
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
              <button className="voice-button voice-button--leave" onClick={leave}>
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
              同じグループの参加者と、声で話せます。参加するとマイクを使います。
            </p>
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
