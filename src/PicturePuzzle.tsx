import { useEffect, useRef, useState } from "react"
import flowerPhoto from "./assets/picture-puzzle/flower.jpg"
import treePhoto from "./assets/picture-puzzle/tree.jpg"
import festivalPhoto from "./assets/picture-puzzle/festival.jpg"
import portraitPhoto from "./assets/picture-puzzle/portrait.jpg"
import iconPhoto from "./assets/picture-puzzle/icon.jpg"

const GRID_SIZE = 4

const EMPTY_TILE = -1

const photos = [
  { name: "花", src: flowerPhoto },

  { name: "木", src: treePhoto },

  { name: "お祭り", src: festivalPhoto },

  { name: "人物", src: portraitPhoto },

  { name: "イラスト", src: iconPhoto },
]

type PicturePuzzleActivity = {
  id: string

  participants: string[]

  status: "active" | "finished"

  photoIndex?: number

  board?: number[]

  scores?: Record<string, number>

  hints?: Record<string, number>
}

type PicturePuzzleProps = {
  activity?: PicturePuzzleActivity

  currentName: string

  error: string

  isAdmin: boolean

  isSubmitting: boolean

  onBack: () => void

  onFinish?: () => void

  onJoin?: () => void
  onNext?: () => void

  onSubmit?: (seconds: number, hintCount: number) => void
}

function createPracticeRound() {
  const board = [...Array.from({ length: 15 }, (_, index) => index), EMPTY_TILE]
  let emptyIndex = 15
  let previousEmptyIndex = -1

  for (let move = 0; move < 120; move += 1) {
    const neighbors = board
      .map((_, index) => index)
      .filter(
        (index) =>
          board[index] !== EMPTY_TILE &&
          isAdjacent(index, emptyIndex) &&
          index !== previousEmptyIndex,
      )
    const nextIndex = neighbors[Math.floor(Math.random() * neighbors.length)]
    board[emptyIndex] = board[nextIndex]
    board[nextIndex] = EMPTY_TILE
    previousEmptyIndex = emptyIndex
    emptyIndex = nextIndex
  }

  if (isPuzzleComplete(board)) {
    board[15] = board[14]
    board[14] = EMPTY_TILE
  }

  return {
    photoIndex: Math.floor(Math.random() * photos.length),
    board,
  }
}

const HINT_PENALTY_SECONDS = 10

function manhattanDistance(board: number[]) {
  let total = 0

  board.forEach((tile, index) => {
    if (tile === EMPTY_TILE) return

    total +=
      Math.abs(Math.floor(tile / GRID_SIZE) - Math.floor(index / GRID_SIZE)) +
      Math.abs((tile % GRID_SIZE) - (index % GRID_SIZE))
  })

  return total
}

type HintPlan = { keys: string[]; moves: number[] }

// 重み付きA*で完成までの手順を最後まで求める。毎回探し直すと角で往復するため、
// 手順を保存して、その通りに進んでいる間は同じ手順を使う。
function solveBoard(board: number[]): HintPlan | null {
  const goalKey = boardKey(createSolvedBoard())

  const startKey = boardKey(board)

  if (startKey === goalKey) return { keys: [startKey], moves: [] }

  for (const [weight, limit] of [
    [3, 150000],
    [10, 300000],
  ]) {
    const nodes = new Map<
      string,
      { board: number[]; g: number; parent: string | null; move: number }
    >()

    const open: { key: string; f: number }[] = []

    const push = (key: string, f: number) => {
      open.push({ key, f })

      let child = open.length - 1

      while (child > 0) {
        const parent = (child - 1) >> 1

        if (open[parent].f <= open[child].f) break
        ;[open[parent], open[child]] = [open[child], open[parent]]

        child = parent
      }
    }

    const pop = () => {
      const top = open[0]

      const last = open.pop()

      if (open.length > 0 && last) {
        open[0] = last

        let parent = 0

        for (;;) {
          const left = parent * 2 + 1

          const right = left + 1

          let smallest = parent

          if (left < open.length && open[left].f < open[smallest].f) {
            smallest = left
          }

          if (right < open.length && open[right].f < open[smallest].f) {
            smallest = right
          }

          if (smallest === parent) break
          ;[open[parent], open[smallest]] = [open[smallest], open[parent]]

          parent = smallest
        }
      }

      return top
    }

    nodes.set(startKey, { board, g: 0, parent: null, move: -1 })
    push(startKey, weight * manhattanDistance(board))

    const closed = new Set<string>()

    let expanded = 0

    while (open.length > 0 && expanded < limit) {
      const { key } = pop()

      if (closed.has(key)) continue

      closed.add(key)

      expanded += 1

      const node = nodes.get(key)

      if (!node) continue

      if (key === goalKey) {
        const keys: string[] = []

        const moves: number[] = []

        for (
          let current: string | null = key;
          current !== null;
          current = nodes.get(current)?.parent ?? null
        ) {
          keys.unshift(current)

          const move = nodes.get(current)?.move ?? -1

          if (move >= 0) moves.unshift(move)
        }

        return { keys, moves }
      }

      const empty = node.board.indexOf(EMPTY_TILE)

      for (let next = 0; next < node.board.length; next += 1) {
        if (!isAdjacent(next, empty)) continue

        const nextBoard = [...node.board]

        nextBoard[empty] = nextBoard[next]
        nextBoard[next] = EMPTY_TILE

        const nextKey = boardKey(nextBoard)

        const g = node.g + 1

        const known = nodes.get(nextKey)

        if (known && known.g <= g) continue

        nodes.set(nextKey, { board: nextBoard, g, parent: key, move: next })
        push(nextKey, g + weight * manhattanDistance(nextBoard))
      }
    }
  }

  return null
}

function boardKey(board: number[]) {
  return board.join(",")
}

function createSolvedBoard() {
  return [...Array.from({ length: 15 }, (_, index) => index), EMPTY_TILE]
}

function isAdjacent(first: number, second: number) {
  const rowDistance = Math.abs(
    Math.floor(first / GRID_SIZE) - Math.floor(second / GRID_SIZE),
  )

  const columnDistance = Math.abs((first % GRID_SIZE) - (second % GRID_SIZE))

  return rowDistance + columnDistance === 1
}

function isValidBoard(board: number[]) {
  return (
    board.length === GRID_SIZE * GRID_SIZE &&
    new Set(board).size === GRID_SIZE * GRID_SIZE &&
    board.includes(EMPTY_TILE) &&
    board.every(
      (tile) =>
        tile === EMPTY_TILE ||
        (Number.isInteger(tile) && tile >= 0 && tile < 15),
    )
  )
}

function isPuzzleComplete(board: number[]) {
  return (
    board.length === GRID_SIZE * GRID_SIZE &&
    board.every((tile, index) =>
      index === board.length - 1 ? tile === EMPTY_TILE : tile === index,
    )
  )
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60)

  const remainder = seconds % 60

  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}

export default function PicturePuzzle({
  activity,

  currentName,

  error,

  isAdmin,

  isSubmitting,

  onBack,

  onFinish,

  onJoin,
  onNext,

  onSubmit,
}: PicturePuzzleProps) {
  const [practiceRound, setPracticeRound] = useState(createPracticeRound)
  const game =
    activity ??
    {
      id: "practice",
      participants: [currentName],
      status: "active",
      photoIndex: practiceRound.photoIndex,
      board: practiceRound.board,
      scores: {},
    } satisfies PicturePuzzleActivity
  const isPractice = activity === undefined
  const initialBoard = game.board ?? []

  const [board, setBoard] = useState(() => initialBoard)

  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const [solvedSeconds, setSolvedSeconds] = useState<number | null>(null)

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

  const [hintActive, setHintActive] = useState(false)

  const [hintCount, setHintCount] = useState(0)

  const [guideVisible, setGuideVisible] = useState(true)

  const [guideLarge, setGuideLarge] = useState(false)

  const startedAt = useRef<number | null>(null)

  const draggedIndex = useRef<number | null>(null)

  const ignoreNextClick = useRef(false)

  const photo = photos[game.photoIndex ?? -1]

  const isParticipant = game.participants.includes(currentName)

  const submittedSeconds = game.scores?.[currentName]

  const hasSubmitted = submittedSeconds !== undefined

  const complete = solvedSeconds !== null || hasSubmitted

  const canPlay =
    isParticipant && game.status === "active" && !complete && !isSubmitting

  const rankedScores = game.participants

    .flatMap((name) => {
      const seconds =
        name === currentName && solvedSeconds !== null
          ? solvedSeconds
          : game.scores?.[name]

      return seconds === undefined ? [] : [{ name, seconds }]
    })

    .sort((first, second) => first.seconds - second.seconds)

  const waitingNames = game.participants.filter(
    (name) =>
      game.scores?.[name] === undefined &&
      !(name === currentName && solvedSeconds !== null),
  )

  const solvedCount = rankedScores.length

  const penaltySeconds = isPractice ? 0 : hintCount * HINT_PENALTY_SECONDS

  const hintPlan = useRef<HintPlan | null>(null)

  const boardSolved = isPuzzleComplete(board)

  const getHintMove = (current: number[]) => {
    const key = boardKey(current)

    let plan = hintPlan.current

    let step = plan ? plan.keys.indexOf(key) : -1

    if (!plan || step < 0 || step >= plan.moves.length) {
      plan = solveBoard(current)

      hintPlan.current = plan

      step = 0
    }

    return plan?.moves[step] ?? null
  }

  const hintMoveIndex =
    hintActive && canPlay && isValidBoard(board) ? getHintMove(board) : null

  const toggleHint = () => {
    if (hintActive) {
      setHintActive(false)

      return
    }

    setHintCount((count) => count + 1)
    setHintActive(true)
  }

  const restartPractice = () => {
    const nextRound = createPracticeRound()
    setPracticeRound(nextRound)
    setBoard(nextRound.board)
    setElapsedSeconds(0)
    setSolvedSeconds(null)
    setSelectedIndex(null)
    setHintActive(false)
    setHintCount(0)
    startedAt.current = null
    draggedIndex.current = null
  }

  useEffect(() => {
    if (startedAt.current === null || complete) return

    const timer = window.setInterval(() => {
      setElapsedSeconds(
        Math.floor((Date.now() - (startedAt.current ?? Date.now())) / 1000),
      )
    }, 250)

    return () => window.clearInterval(timer)
  }, [complete, board])

  const moveTile = (fromIndex: number, toIndex: number) => {
    if (
      !canPlay ||
      toIndex < 0 ||
      board[toIndex] !== EMPTY_TILE ||
      !isAdjacent(fromIndex, toIndex)
    ) {
      return false
    }

    startedAt.current ??= Date.now()

    const nextBoard = [...board]

    nextBoard[toIndex] = nextBoard[fromIndex]

    nextBoard[fromIndex] = EMPTY_TILE

    setBoard(nextBoard)

    setSelectedIndex(null)

    if (isPuzzleComplete(nextBoard)) {
      const seconds =
        Math.max(
          1,

          Math.floor((Date.now() - startedAt.current) / 1000),
        ) + penaltySeconds

      setSolvedSeconds(seconds)
      setHintActive(false)

      if (!isPractice) onSubmit?.(seconds, hintCount)
    }

    return true
  }

  const handleTileClick = (index: number) => {
    if (ignoreNextClick.current || !canPlay) {
      ignoreNextClick.current = false

      return
    }

    if (board[index] === EMPTY_TILE) {
      if (selectedIndex !== null) moveTile(selectedIndex, index)

      return
    }

    const emptyIndex = board.indexOf(EMPTY_TILE)

    if (isAdjacent(index, emptyIndex)) {
      moveTile(index, emptyIndex)
    } else {
      setSelectedIndex((current) => (current === index ? null : index))
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    draggedIndex.current = null

    if (!canPlay || !(event.target instanceof Element)) return

    const tile = event.target.closest<HTMLElement>("[data-tile-index]")

    if (!tile || Number(tile.dataset.tileValue) === EMPTY_TILE) return

    draggedIndex.current = Number(tile.dataset.tileIndex)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const fromIndex = draggedIndex.current

    draggedIndex.current = null

    if (fromIndex === null) return

    const target = document

      .elementFromPoint(event.clientX, event.clientY)

      ?.closest<HTMLElement>("[data-tile-index]")

    const toIndex = target ? Number(target.dataset.tileIndex) : -1

    if (toIndex !== fromIndex && moveTile(fromIndex, toIndex)) {
      ignoreNextClick.current = true

      window.setTimeout(() => {
        ignoreNextClick.current = false
      }, 0)
    }
  }

  if (!photo || !isValidBoard(initialBoard)) {
    return (
      <div className="group-play-active">
        <button className="group-play-back" onClick={onBack} type="button">
          脳活タイムへ戻る
        </button>
        <p className="group-play-error" role="alert">
          絵合わせの問題を読み込めませんでした。管理者にお知らせください。
        </p>
      </div>
    )
  }

  const result = (
    <div className="picture-puzzle-rankings">
      <h4>グループランキング</h4>
      {rankedScores.map((entry, index) => (
        <div key={entry.name}>
          <strong>{index + 1}位</strong>
          <span>
            {entry.name}さん
            {(game.hints?.[entry.name] ?? 0) > 0 &&
              `（ヒント${game.hints?.[entry.name]}回）`}
          </span>
        </div>
      ))}
      {waitingNames.map((name) => (
        <div className="is-waiting" key={name}>
          <strong>挑戦中</strong>
          <span>{name}さん</span>
          <b>--:--</b>
        </div>
      ))}
    </div>
  )

  if (game.status === "finished") {
    return (
      <div className="group-play-review picture-puzzle-review">
        <button className="group-play-back" onClick={onBack} type="button">
          脳活タイムへ戻る
        </button>
        <div className="group-play-review__hero">
          <span>タイムアタック終了</span>
          <h3>絵合わせ</h3>
          <strong>{solvedCount}人が完成しました</strong>
        </div>
        {result}
        {isAdmin ? (
          <button className="group-play-start" onClick={onNext} type="button">
            次の遊びを選ぶ
          </button>
        ) : (
          <p className="group-play-waiting">
            管理者が次の遊びを始めるまでお待ちください。
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="group-play-active picture-puzzle-screen">
      <button className="group-play-back" onClick={onBack} type="button">
        脳活タイムへ戻る
      </button>
      <div className="group-play-heading">
        <span>絵合わせ・タイム競争</span>
        <strong>
          {isPractice
            ? "ひとりで練習"
            : `${solvedCount}人 / ${game.participants.length}人 完成`}
        </strong>
      </div>
      <div className="picture-puzzle-status" aria-live="polite">
        <div>
          <span>あなたのタイム</span>
          <strong>
            {hasSubmitted
              ? formatTime(submittedSeconds)
              : complete
                ? formatTime(solvedSeconds ?? 0)
                : formatTime(elapsedSeconds + penaltySeconds)}
          </strong>
        </div>
        <div>
          <span>参加者</span>
          <strong>
            {isPractice
              ? "15ピース"
              : `${solvedCount} / ${game.participants.length}`}
          </strong>
        </div>
      </div>
      <div
        className={`picture-puzzle-guide ${guideLarge ? "is-large" : ""}`}
      >
        {guideVisible && (
          <button
            aria-label={guideLarge ? "見本を小さくする" : "見本を拡大する"}
            className="picture-puzzle-guide-image"
            onClick={() => setGuideLarge((value) => !value)}
            type="button"
          >
            <img alt={`${photo.name}の完成見本`} src={photo.src} />
          </button>
        )}
        <div className="picture-puzzle-guide-text">
          <p>
            {!isParticipant
              ? "今回は観戦です。参加者の完成タイムを見守りましょう。"
              : complete
                ? isPractice
                  ? "完成しました！すばらしい記録です。"
                  : "タイムを記録しました。みんなの完成を待ちましょう。"
                : startedAt.current === null
                  ? `${photo.name}の写真を見本に、空いている場所へ動かしましょう。最初の一手から計測します。`
                  : `${photo.name}の写真を見本に、空いている場所へピースを動かしましょう。`}
          </p>
          <div className="picture-puzzle-guide-actions">
            {!isParticipant && game.status === "active" && onJoin && (
              <button
                className="picture-puzzle-join"
                disabled={isSubmitting}
                onClick={onJoin}
                type="button"
              >
                {isSubmitting ? "参加しています…" : "この対戦に参加する"}
              </button>
            )}
            {guideVisible && (
              <button
                onClick={() => setGuideLarge((value) => !value)}
                type="button"
              >
                {guideLarge ? "小さくする" : "見本を拡大"}
              </button>
            )}
            <button
              onClick={() => {
                setGuideVisible((value) => !value)
                setGuideLarge(false)
              }}
              type="button"
            >
              {guideVisible ? "見本を消す" : "見本を表示"}
            </button>
          </div>
        </div>
      </div>
      <div
        aria-label={`${photo.name}の絵合わせパズル`}
        className="picture-puzzle-grid"
        onPointerCancel={() => {
          draggedIndex.current = null
        }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        role="group"
      >
        {board.map((tile, index) => {
          const filledGap = tile === EMPTY_TILE && boardSolved

          const empty = tile === EMPTY_TILE && !filledGap

          const shownTile = filledGap ? GRID_SIZE * GRID_SIZE - 1 : tile

          const tileRow = Math.floor(shownTile / GRID_SIZE)

          const tileColumn = shownTile % GRID_SIZE

          return (
            <button
              aria-label={empty ? "空きマス" : `${shownTile + 1}番のピース`}
              aria-pressed={selectedIndex === index}
              className={`picture-puzzle-tile ${empty ? "is-empty" : ""} ${
                selectedIndex === index ? "is-selected" : ""
              } ${hintMoveIndex === index ? "is-hint" : ""} ${
                empty && hintMoveIndex !== null ? "is-hint-target" : ""
              }`}
              data-tile-index={index}
              data-tile-value={tile}
              disabled={!canPlay}
              key={tile}
              onClick={() => handleTileClick(index)}
              style={
                empty
                  ? undefined
                  : {
                      backgroundImage: `url("${photo.src}")`,

                      backgroundPosition: `${(tileColumn / (GRID_SIZE - 1)) * 100}% ${
                        (tileRow / (GRID_SIZE - 1)) * 100
                      }%`,
                    }
              }
              type="button"
            >
              {empty ? (
                "空き"
              ) : (
                <img
                  alt=""
                  aria-hidden="true"
                  className="picture-puzzle-tile-image"
                  draggable={false}
                  src={photo.src}
                  style={{
                    left: `${tileColumn * -100}%`,
                    top: `${tileRow * -100}%`,
                  }}
                />
              )}
            </button>
          )
        })}
      </div>
      <div className="picture-puzzle-hint-controls">
        <button
          aria-pressed={hintActive}
          className={`picture-puzzle-hint-button ${hintActive ? "is-active" : ""}`}
          disabled={!canPlay}
          onClick={toggleHint}
          type="button"
        >
          {hintActive
            ? "ヒントの中止"
            : isPractice
              ? "ヒント"
              : `ヒント（+${HINT_PENALTY_SECONDS}秒）`}
        </button>
        {hintActive && (
          <p aria-live="polite">
            光っているピースを空きマスへ動かしましょう。
          </p>
        )}
        {!isPractice && hintCount > 0 && (
          <p>ヒントを{hintCount}回使用（+{penaltySeconds}秒）</p>
        )}
      </div>
      <p className="picture-puzzle-hint">
        ピースを空きマスへドラッグ。タップして選び、空きマスをタップしても動かせます。
      </p>
      {error && <p className="group-play-error">{error}</p>}
      {!isPractice && solvedSeconds !== null && !hasSubmitted && (
        <button
          className="group-play-start"
          disabled={isSubmitting}
          onClick={() => onSubmit?.(solvedSeconds, hintCount)}
          type="button"
        >
          {isSubmitting ? "タイムを記録しています…" : "タイムをもう一度送る"}
        </button>
      )}
      {!isPractice && result}
      {isPractice && complete && (
        <button
          className="nine-puzzle-restart"
          onClick={restartPractice}
          type="button"
        >
          もう一度練習する
        </button>
      )}
      {!isPractice && isAdmin && (
        <div className="group-play-admin">
          <button onClick={onFinish} type="button">
            タイム競争を終了
          </button>
        </div>
      )}
    </div>
  )
}
