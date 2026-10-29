import { useCallback, useEffect, useRef, useState } from "react";

type GameQuestion = {
  id: string;
  category: string;
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
};

type GameState = {
  id: string;
  status: "playing" | "finished";
  phase: "question" | "reveal";
  startedBy: string;
  index: number;
  questionStartedAt: number;
  questions: GameQuestion[];
  answers: Record<string, number>;
  scores: Record<string, number>;
  seconds: number;
  serverNow: number;
};

type VoiceGameProps = {
  apiRoot: string;
  headers: Record<string, string>;
  myName: string;
  names: string[];
};

export default function VoiceGame({
  apiRoot,
  headers,
  myName,
  names,
}: VoiceGameProps) {
  const [game, setGame] = useState<GameState | null>(null);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const offsetRef = useRef(0);
  const busyRef = useRef(false);

  const call = useCallback(
    async (path: string, method: "GET" | "POST", body?: unknown) => {
      try {
        const response = await fetch(`${apiRoot}/voice/game${path}`, {
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
        const next = (result.game ?? null) as GameState | null;
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
    const timer = window.setInterval(() => void call("", "GET"), 2000);
    return () => window.clearInterval(timer);
  }, [call]);

  const playing = game?.status === "playing";
  const question = game ? game.questions[game.index] : null;

  useEffect(() => {
    if (!game || game.phase !== "question") return;
    const tick = () => {
      const left = Math.max(
        0,
        Math.ceil(
          game.seconds -
            (Date.now() + offsetRef.current - game.questionStartedAt) / 1000,
        ),
      );
      setRemaining(left);
      if (left === 0 && !busyRef.current) {
        busyRef.current = true;
        void call("/reveal", "POST", { index: game.index }).finally(() => {
          busyRef.current = false;
        });
      }
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [game, call]);

  // 通話中の全員が答えたら答え合わせへ進める
  useEffect(() => {
    if (!game || game.phase !== "question" || busyRef.current) return;
    const answered = Object.keys(game.answers);
    if (names.length > 0 && names.every((name) => answered.includes(name))) {
      busyRef.current = true;
      void call("/reveal", "POST", { index: game.index }).finally(() => {
        busyRef.current = false;
      });
    }
  }, [game, names, call]);

  if (!game || (!playing && game.status !== "finished")) {
    return (
      <div className="voice-game">
        <p className="voice-lead">
          通話しながら、みんなで同じ問題に挑戦できます（5問）。
        </p>
        {error && <p className="form-error">{error}</p>}
        <button
          className="voice-button voice-button--join"
          onClick={() => void call("/start", "POST", {})}
        >
          🧠 みんなで脳活を始める
        </button>
      </div>
    );
  }

  const ranking = Object.entries(game.scores).sort((a, b) => b[1] - a[1]);

  if (game.status === "finished") {
    return (
      <div className="voice-game">
        <h3 className="voice-game__title">結果発表</h3>
        <ol className="voice-members">
          {names.map((name) => [name, game.scores[name] ?? 0] as const)
            .sort((a, b) => b[1] - a[1])
            .map(([name, score]) => (
              <li key={name}>
                {name}：{score} / {game.questions.length} 問正解
              </li>
            ))}
        </ol>
        <div className="voice-actions">
          <button
            className="voice-button voice-button--join"
            onClick={() => void call("/end", "POST", {}).then(() => call("/start", "POST", {}))}
          >
            もう一度あそぶ
          </button>
          <button
            className="voice-button"
            onClick={() => void call("/end", "POST", {})}
          >
            ゲームをおわる
          </button>
        </div>
      </div>
    );
  }

  const myAnswer = game.answers[myName];
  const revealed = game.phase === "reveal";
  const answeredCount = names.filter((name) => game.answers[name] !== undefined).length;

  return (
    <div className="voice-game">
      <p className="voice-game__meta">
        第{game.index + 1}問 / {game.questions.length}問　
        {!revealed && <strong>のこり {remaining} 秒</strong>}
      </p>
      <p className="voice-game__prompt">{question?.prompt}</p>
      <div className="voice-actions">
        {question?.choices.map((choice, index) => {
          const classes = ["voice-button", "voice-choice"];
          if (myAnswer === index) classes.push("is-selected");
          if (revealed && index === question.correctIndex) classes.push("is-correct");
          return (
            <button
              className={classes.join(" ")}
              disabled={revealed || myAnswer !== undefined}
              key={`${game.index}-${index}`}
              onClick={() => void call("/answer", "POST", { index: game.index, choice: index })}
            >
              {index + 1}. {choice}
            </button>
          );
        })}
      </div>
      {!revealed && (
        <p className="voice-lead">
          {myAnswer === undefined
            ? "相談して、答えを選んでください。"
            : "回答しました。みんなを待っています。"}
          （{answeredCount} / {names.length}人）
        </p>
      )}
      {revealed && question && (
        <>
          <p className="voice-status">
            正解は {question.correctIndex + 1}番：{question.choices[question.correctIndex]}
          </p>
          <p className="voice-lead">{question.explanation}</p>
          <ul className="voice-members">
            {names.map((name) => {
              const choice = game.answers[name];
              return (
                <li key={name}>
                  {name}：
                  {choice === undefined
                    ? "未回答"
                    : `${choice + 1}番 ${choice === question.correctIndex ? "⭕" : "❌"}`}
                </li>
              );
            })}
          </ul>
          <button
            className="voice-button voice-button--join"
            onClick={() => void call("/next", "POST", { index: game.index })}
          >
            {game.index + 1 >= game.questions.length ? "結果を見る" : "次の問題へ"}
          </button>
        </>
      )}
      {ranking.length > 0 && !revealed && (
        <p className="voice-lead">
          いまの得点：{ranking.map(([name, score]) => `${name} ${score}`).join("、")}
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
