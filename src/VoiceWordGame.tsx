import { useCallback, useEffect, useState } from "react";

type WordState = {
  id: string;
  status: "playing" | "finished";
  host: string;
  round: number;
  maxRounds: number;
  category: string;
  word?: string;
  scores: Record<string, number>;
};

type VoiceWordGameProps = {
  apiRoot: string;
  headers: Record<string, string>;
  myName: string;
  names: string[];
};

export default function VoiceWordGame({
  apiRoot,
  headers,
  myName,
  names,
}: VoiceWordGameProps) {
  const [game, setGame] = useState<WordState | null>(null);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);

  const call = useCallback(
    async (path: string, method: "GET" | "POST", body?: unknown) => {
      try {
        const response = await fetch(`${apiRoot}/voice/word${path}`, {
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
        setGame((result.game ?? null) as WordState | null);
      } catch {
        setError("通信できませんでした。");
      }
    },
    [apiRoot, headers],
  );

  useEffect(() => {
    void call("", "GET");
    const timer = window.setInterval(() => void call("", "GET"), 2000);
    return () => window.clearInterval(timer);
  }, [call]);

  const act = (payload: Record<string, unknown>) => {
    setPicking(false);
    void call("/action", "POST", { names, ...payload });
  };

  if (!game) {
    return (
      <div className="voice-game">
        <p className="voice-lead">
          出題者だけにお題が見えます。声でヒントを出して、みんなで当てましょう。
        </p>
        {error && <p className="form-error">{error}</p>}
        <button
          className="voice-button voice-button--join"
          onClick={() => void call("/start", "POST", {})}
        >
          🗣️ 言葉あてを始める
        </button>
      </div>
    );
  }

  const scoreList = names
    .map((name) => [name, game.scores[name] ?? 0] as const)
    .sort((a, b) => b[1] - a[1]);

  if (game.status === "finished") {
    return (
      <div className="voice-game">
        <h3 className="voice-game__title">結果発表</h3>
        <ol className="voice-members">
          {scoreList.map(([name, score]) => (
            <li key={name}>
              {name}：{score} 点
            </li>
          ))}
        </ol>
        <div className="voice-actions">
          <button
            className="voice-button voice-button--join"
            onClick={() =>
              void call("/end", "POST", {}).then(() => call("/start", "POST", {}))
            }
          >
            もう一度あそぶ
          </button>
          <button className="voice-button" onClick={() => void call("/end", "POST", {})}>
            ゲームをおわる
          </button>
        </div>
      </div>
    );
  }

  const isHost = game.host === myName;

  return (
    <div className="voice-game">
      <p className="voice-game__meta">
        第{game.round}回 / {game.maxRounds}回　出題者：<strong>{game.host}</strong>
      </p>
      <p className="voice-lead">ジャンル：{game.category}</p>
      {isHost ? (
        <>
          <p className="voice-lead">あなたが出題者です。お題を声でヒントにして伝えてください（お題そのものは言わないでね）。</p>
          <p className="voice-game__prompt voice-word">{game.word}</p>
          {picking ? (
            <>
              <p className="voice-lead">だれが当てましたか？</p>
              <div className="voice-actions">
                {names
                  .filter((name) => name !== myName)
                  .map((name) => (
                    <button
                      className="voice-button"
                      key={name}
                      onClick={() => act({ action: "correct", winner: name })}
                    >
                      {name}さん
                    </button>
                  ))}
                <button className="voice-button" onClick={() => setPicking(false)}>
                  もどる
                </button>
              </div>
            </>
          ) : (
            <div className="voice-actions">
              <button
                className="voice-button voice-button--join"
                disabled={names.length < 2}
                onClick={() => setPicking(true)}
              >
                ⭕ 正解が出た
              </button>
              <button className="voice-button" onClick={() => act({ action: "pass" })}>
                お題を変える
              </button>
              <button className="voice-button" onClick={() => act({ action: "skip" })}>
                次の人に交代する
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="voice-game__prompt">
          {game.host}さんのヒントを聞いて、声で答えを言いましょう。
        </p>
      )}
      <p className="voice-lead">
        得点：{scoreList.map(([name, score]) => `${name} ${score}`).join("、")}
      </p>
      {error && <p className="form-error">{error}</p>}
      <button className="voice-button" onClick={() => void call("/end", "POST", {})}>
        ゲームをおわる
      </button>
    </div>
  );
}
