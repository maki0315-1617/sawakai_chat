import { useCallback, useEffect, useRef, useState } from "react";

type TurnState = {
  id: string;
  status: "playing" | "finished";
  mode: "shiritori" | "association";
  theme: string;
  order: string[];
  turn: number;
  maxTurns: number;
  turnStartedAt: number;
  seconds: number;
  serverNow: number;
  ok: Record<string, number>;
  miss: Record<string, number>;
};

type VoiceTurnGameProps = {
  apiRoot: string;
  headers: Record<string, string>;
  myName: string;
  names: string[];
};

export default function VoiceTurnGame({
  apiRoot,
  headers,
  myName,
  names,
}: VoiceTurnGameProps) {
  const [game, setGame] = useState<TurnState | null>(null);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const offsetRef = useRef(0);
  const sentTurnRef = useRef<string>("");

  const call = useCallback(
    async (path: string, method: "GET" | "POST", body?: unknown) => {
      try {
        const response = await fetch(`${apiRoot}/voice/turn${path}`, {
          method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          setError(result.error ?? "ゲームを更新できませんでした。");
          return;
        }
        setError("");
        const next = (result.game ?? null) as TurnState | null;
        if (next) offsetRef.current = next.serverNow - Date.now();
        setGame(next);
      } catch {
        setError("通信できませんでした。");
      }
    },
    [apiRoot, headers],
  );

  useEffect(() => {
    void call("", "GET");
    const timer = window.setInterval(() => void call("", "GET"), 1500);
    return () => window.clearInterval(timer);
  }, [call]);

  useEffect(() => {
    if (!game || game.status !== "playing") return;
    const tick = () => {
      const left = Math.max(
        0,
        Math.ceil(
          game.seconds -
            (Date.now() + offsetRef.current - game.turnStartedAt) / 1000,
        ),
      );
      setRemaining(left);
      const marker = `${game.id}:${game.turn}`;
      if (left === 0 && sentTurnRef.current !== marker) {
        sentTurnRef.current = marker;
        void call("/action", "POST", { turn: game.turn, action: "timeout" });
      }
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [game, call]);

  const start = (mode: "shiritori" | "association") =>
    void call("/start", "POST", { mode, names });
  const end = () => void call("/end", "POST", {});

  if (!game) {
    return (
      <div className="voice-game">
        <p className="voice-lead">
          順番に声で答えます。10秒以内に言えたら成功です。判定はみんなで声で決めましょう。
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="voice-actions">
          <button className="voice-button voice-button--join" onClick={() => start("shiritori")}>
            🔤 しりとりを始める
          </button>
          <button className="voice-button voice-button--join" onClick={() => start("association")}>
            💭 連想ゲームを始める
          </button>
        </div>
      </div>
    );
  }

  if (game.status === "finished") {
    const players = [...game.order].sort(
      (a, b) => (game.ok[b] ?? 0) - (game.ok[a] ?? 0),
    );
    return (
      <div className="voice-game">
        <h3 className="voice-game__title">結果発表</h3>
        <ol className="voice-members">
          {players.map((name) => (
            <li key={name}>
              {name}：成功 {game.ok[name] ?? 0} 回 / 時間切れ・ミス {game.miss[name] ?? 0} 回
            </li>
          ))}
        </ol>
        <div className="voice-actions">
          <button className="voice-button voice-button--join" onClick={() => start(game.mode)}>
            もう一度あそぶ
          </button>
          <button className="voice-button" onClick={end}>
            ゲームをおわる
          </button>
        </div>
      </div>
    );
  }

  const speaker = game.order[game.turn % game.order.length];
  const nextSpeaker = game.order[(game.turn + 1) % game.order.length];
  const isMe = speaker === myName;
  const absent = !names.includes(speaker);

  return (
    <div className="voice-game">
      <p className="voice-game__meta">
        {game.mode === "shiritori" ? "しりとり" : "連想ゲーム"}　
        {game.turn + 1} / {game.maxTurns} 番目
      </p>
      <p className="voice-lead">
        {game.mode === "shiritori"
          ? `最初の言葉：「${game.theme}」`
          : `テーマ：「${game.theme}」`}
      </p>
      <p className="voice-game__prompt voice-word">
        {isMe ? "あなたの番です！" : `${speaker}さんの番`}
      </p>
      <p className="voice-game__meta">
        <strong>のこり {remaining} 秒</strong>　次は {nextSpeaker}さん
      </p>
      <div className="voice-actions">
        <button
          className="voice-button voice-button--join"
          onClick={() => void call("/action", "POST", { turn: game.turn, action: "ok" })}
        >
          ⭕ {isMe ? "言えた" : `${speaker}さん、言えた`}
        </button>
        <button
          className="voice-button"
          onClick={() => void call("/action", "POST", { turn: game.turn, action: "miss" })}
        >
          ❌ ミス（次の人へ）
        </button>
      </div>
      {absent && <p className="voice-lead">{speaker}さんは通話にいません。ミスで次へ進めてください。</p>}
      <ul className="voice-members">
        {game.order.map((name) => (
          <li className={name === speaker ? "is-speaking" : ""} key={name}>
            {name}：成功 {game.ok[name] ?? 0}
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
      <button className="voice-button" onClick={end}>
        ゲームをおわる
      </button>
    </div>
  );
}
