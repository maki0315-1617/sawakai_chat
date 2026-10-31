import {
  FormEvent,
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { projectId, publicAnonKey } from "../utils/supabase/info";
import VoiceCall from "./VoiceCall";
import DirectCall from "./DirectCall";

type AvatarColor = "mint" | "peach" | "sand";

type ChatMessage = {
  id: string;
  sender: string;
  text: string;
  createdAt: string;
  avatar: AvatarColor;
  kind?: "message" | "system";
  groupName?: string;
  pending?: boolean;
  attachment?: {
    path: string;
    kind: "image" | "video";
    mimeType: string;
    size: number;
    fileName: string;
    signedUrl?: string;
  };
};

type Profile = {
  name: string;
  imageUrl?: string;
};

type Member = {
  name: string;
  joinedAt: string;
  lastSeenAt: string;
  avatar: AvatarColor;
  imageUrl?: string;
  isAdmin?: boolean;
};

type ThemeColor = "green" | "pink" | "blue" | "black";

type GroupSummary = {
  id: string;
  name: string;
  inviteCode: string;
  imageUrl?: string;
  unreadCount?: number;
  latestMessage?: {
    sender: string;
    text: string;
    createdAt: string;
    hasAttachment: boolean;
    kind?: "message" | "system";
  };
};

type BrainQuestion = {
  id: string
  category:
    | "ことば"
    | "計算"
    | "注意"
    | "暮らし"
    | "図形"
    | "歴史"
    | "間違い探し"
    | "一般常識"
    | "防災"
    | "健康"
    | "防犯"
    | "交通"
  prompt: string
  choices: string[]
  correctIndex?: number
  explanation?: string
}

function mergeUniqueMessages(...pages: ChatMessage[][]): ChatMessage[] {
  const messages = new Map<string, ChatMessage>()
  pages.flat().forEach((message) => messages.set(message.id, message))
  return [...messages.values()]
}

type BrainDifficulty = "easy" | "normal" | "challenge"

type BrainRound = {
  id: string
  schemaVersion?: number
  mode: "group" | "practice"
  difficulty?: BrainDifficulty
  createdAt: string
  createdBy: string
  answered: boolean
  questions: BrainQuestion[]
}

type BrainResult = {
  score: number
  answers: number[]
  questions: Required<BrainQuestion>[]
}

type BrainSummary = {
  round: BrainRound | null
  result: BrainResult | null
  leaderboard: { rank: number; name: string; score: number }[]
  todayBest: { name: string; score: number }[]
  myTodayBest: number
  myTodayPlays: number
}

type GroupActivityKind =
  | "shiritori"
  | "association"
  | "memory"
  | "nine-puzzle"
  | "proverb-puzzle"
  | "memory-match"
type ProverbQuestion = {
  id: string
  pieces: string[]
  hint: string
}
type MemoryCard = { id: string; label: string }
type GroupActivity = {
  id: string
  kind: GroupActivityKind
  participants: string[]
  turnIndex: number
  status: "active" | "finished"
  createdAt: string
  createdBy: string
  prompt: string
  entries: { name: string; text: string; createdAt: string }[]
  board?: number[]
  moves?: number
  questions?: ProverbQuestion[]
  questionIndex?: number
  wordBoard?: string[]
  solvedCount?: number
  nextQuestionAt?: string
  pendingQuestionIndex?: number
  cards?: MemoryCard[]
  revealedIds?: string[]
  matchedIds?: string[]
  lastMismatchIds?: string[]
  lastMismatchAt?: string
  nextTurnAt?: string
  pendingTurnIndex?: number
  matchesByName?: Record<string, number>
  attempts?: number
}

function createNinePuzzleBoard(): number[] {
  const target = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  let board = [...target]
  while (board.every((value, index) => value === target[index])) {
    board = [...target]
    for (let index = board.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1))
      ;[board[index], board[swapIndex]] = [board[swapIndex], board[index]]
    }
  }
  return board
}

function isNinePuzzleComplete(board: number[]) {
  return board.length === 9 && board.every((value, index) => value === index + 1)
}

const proverbQuestionBank: ProverbQuestion[] = [
  { id: "monkey", pieces: ["猿も", "木から", "落ちる"], hint: "得意な人でも失敗することがあります" },
  { id: "stone", pieces: ["石の上にも", "三年"], hint: "辛抱強く続けることが大切です" },
  { id: "hurry", pieces: ["急がば", "回れ"], hint: "急ぐときほど確実な方法を選びます" },
  { id: "seven", pieces: ["七転び", "八起き"], hint: "何度失敗しても立ち上がります" },
  { id: "dust", pieces: ["塵も", "積もれば", "山となる"], hint: "小さなものも積み重なると大きくなります" },
  { id: "smile", pieces: ["笑う門には", "福来る"], hint: "明るいところには幸せが訪れます" },
  { id: "dumpling", pieces: ["花より", "団子"], hint: "見た目より実際の役立ちを選びます" },
  { id: "good", pieces: ["善は", "急げ"], hint: "良いことはすぐに始めます" },
  { id: "seeing", pieces: ["百聞は", "一見に", "如かず"], hint: "聞くより実際に見る方がよく分かります" },
  { id: "rabbits", pieces: ["二兎を追う者は", "一兎をも", "得ず"], hint: "欲張ると何も得られないことがあります" },
  { id: "cane", pieces: ["転ばぬ先の", "杖"], hint: "失敗する前に準備します" },
  { id: "prepare", pieces: ["備えあれば", "憂いなし"], hint: "準備があれば心配が減ります" },
  { id: "failure", pieces: ["失敗は", "成功の", "もと"], hint: "失敗から学ぶと成功につながります" },
  { id: "worry", pieces: ["案ずるより", "産むが", "易し"], hint: "やってみると意外に簡単なことがあります" },
  { id: "frog", pieces: ["井の中の蛙", "大海を", "知らず"], hint: "狭い世界だけでは広さに気づけません" },
  { id: "hawk", pieces: ["能ある鷹は", "爪を", "隠す"], hint: "実力のある人はむやみに自慢しません" },
  { id: "time", pieces: ["時は", "金なり"], hint: "時間は大切なものです" },
  { id: "mouth", pieces: ["口は", "災いの", "元"], hint: "不用意な発言には気をつけます" },
  { id: "rain", pieces: ["雨降って", "地固まる"], hint: "もめ事の後に関係が強くなることがあります" },
  { id: "early", pieces: ["早起きは", "三文の", "徳"], hint: "早起きには良いことがあります" },
  { id: "kindness", pieces: ["情けは", "人のためならず"], hint: "親切は巡って自分にも返ってきます" },
  { id: "friends", pieces: ["類は", "友を", "呼ぶ"], hint: "似た者同士は集まりやすいものです" },
  { id: "fortune", pieces: ["果報は", "寝て", "待て"], hint: "焦らず良い知らせを待ちます" },
  { id: "practice", pieces: ["習うより", "慣れよ"], hint: "説明だけでなく実際に経験します" },
]

function shuffledList<T>(items: T[]) {
  const next = [...items]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[next[index], next[swapIndex]] = [next[swapIndex], next[index]]
  }
  return next
}

function createProverbBoard(question: ProverbQuestion) {
  let board = shuffledList(question.pieces)
  while (
    board.length > 1 &&
    board.every((piece, index) => piece === question.pieces[index])
  ) {
    board = shuffledList(question.pieces)
  }
  return board
}

function isProverbComplete(board: string[], question?: ProverbQuestion) {
  return Boolean(
    question &&
      board.length === question.pieces.length &&
      board.every((piece, index) => piece === question.pieces[index]),
  )
}

const memoryCardLabels = [
  "桜",
  "富士山",
  "お茶",
  "団子",
  "金魚",
  "扇子",
  "紅葉",
  "雪だるま",
  "招き猫",
]

function createMemoryCards(): MemoryCard[] {
  return shuffledList(
    memoryCardLabels.flatMap((label, pairIndex) => [
      { id: `${pairIndex}-a-${crypto.randomUUID()}`, label },
      { id: `${pairIndex}-b-${crypto.randomUUID()}`, label },
    ]),
  )
}

const shiritoriSuggestions: Record<string, string[]> = {
  あ: ["あさがお", "あめ", "あり"],
  い: ["いぬ", "いちご", "いす"],
  う: ["うさぎ", "うみ", "うちわ"],
  え: ["えんぴつ", "えび", "えがお"],
  お: ["おにぎり", "おちゃ", "おうち"],
  か: ["かめ", "かさ", "かぼちゃ"],
  き: ["きつね", "きのこ", "きつつき"],
  く: ["くるま", "くじら", "くつ"],
  け: ["けむし", "けいと", "けしごむ"],
  こ: ["こあら", "こま", "こいぬ"],
  さ: ["さくら", "さかな", "さつまいも"],
  し: ["しか", "しお", "しずく"],
  す: ["すいか", "すずめ", "すし"],
  せ: ["せみ", "せかい", "せなか"],
  そ: ["そら", "そり", "そば"],
  た: ["たいこ", "たぬき", "たまご"],
  ち: ["ちず", "ちょう", "ちくわ"],
  つ: ["つみき", "つくえ", "つばめ"],
  て: ["てがみ", "てぶくろ", "てまり"],
  と: ["とけい", "とまと", "とり"],
  な: ["なす", "なわ", "なみ"],
  に: ["にわとり", "にじ", "にく"],
  ぬ: ["ぬの", "ぬりえ", "ぬま"],
  ね: ["ねこ", "ねぎ", "ねずみ"],
  の: ["のり", "のはら", "のこぎり"],
  は: ["はさみ", "はな", "はち"],
  ひ: ["ひこうき", "ひつじ", "ひまわり"],
  ふ: ["ふね", "ふく", "ふろしき"],
  へ: ["へび", "へちま", "へいわ"],
  ほ: ["ほし", "ほたる", "ほうき"],
  ま: ["まり", "まくら", "まめ"],
  み: ["みず", "みかづき", "みみず"],
  む: ["むぎ", "むし", "むら"],
  め: ["めがね", "めだか", "めじろ"],
  も: ["もも", "もぐら", "もみじ"],
  や: ["やぎ", "やま", "やさい"],
  ゆ: ["ゆき", "ゆび", "ゆり"],
  よ: ["よる", "よっと", "ようふく"],
  ら: ["らっぱ", "らくだ", "らじお"],
  り: ["りす", "りんご", "りょうり"],
  る: ["るり", "ルビー", "ルーペ"],
  れ: ["れんげ", "れきし", "れたす"],
  ろ: ["ろうそく", "ろば", "ろてんぶろ"],
  わ: ["わに", "わた", "わかめ"],
  が: ["がっこう", "がらす", "がくせい"],
  ぎ: ["ぎんこう", "ぎゅうにゅう", "ぎたー"],
  ぐ: ["ぐんて", "ぐみ", "ぐらす"],
  げ: ["げた", "げんき", "げいじゅつ"],
  ご: ["ごま", "ごりら", "ごぼう"],
  ざ: ["ざる", "ざっし", "ざくろ"],
  じ: ["じてんしゃ", "じしょ", "じゃがいも"],
  ず: ["ずこう", "ずけい", "ずぼし"],
  ぜ: ["ぜりー", "ぜんざい", "ぜっけい"],
  ぞ: ["ぞう", "ぞうり", "ぞうすい"],
  だ: ["だるま", "だちょう", "だがし"],
  で: ["でんしゃ", "でぐち", "でんわ"],
  ど: ["どあ", "どんぐり", "どうぶつ"],
  ば: ["ばなな", "ばす", "ばら"],
  び: ["びわ", "びーだま", "びじゅつ"],
  ぶ: ["ぶどう", "ぶた", "ぶらんこ"],
  べ: ["べる", "べんとう", "べーぐる"],
  ぼ: ["ぼうし", "ぼーる", "ぼたもち"],
  ぱ: ["ぱんだ", "ぱせり", "ぱじゃま"],
  ぴ: ["ぴあの", "ぴんく", "ぴくにっく"],
  ぷ: ["ぷーる", "ぷらむ", "ぷちとまと"],
  ぺ: ["ぺっと", "ぺんき", "ぺがさす"],
  ぽ: ["ぽすと", "ぽけっと", "ぽんず"],
}

const associationSuggestions: Record<string, string[]> = {
  バナナ: ["黄色", "果物", "サル"],
  黄色: ["レモン", "ひまわり", "信号"],
  果物: ["りんご", "みかん", "ぶどう"],
  サル: ["動物", "山", "バナナ"],
  レモン: ["すっぱい", "紅茶", "黄色"],
  ひまわり: ["夏", "花", "黄色"],
  信号: ["道路", "車", "赤"],
  りんご: ["赤", "果物", "青森"],
  みかん: ["オレンジ色", "冬", "果物"],
  ぶどう: ["紫", "秋", "果物"],
  動物: ["ねこ", "いぬ", "動物園"],
  山: ["緑", "登山", "自然"],
  すっぱい: ["梅干し", "レモン", "酢"],
  紅茶: ["おやつ", "レモン", "カップ"],
  夏: ["海", "花火", "すいか"],
  花: ["春", "香り", "花束"],
  道路: ["車", "信号", "散歩"],
  車: ["道路", "旅行", "タイヤ"],
  赤: ["りんご", "消防車", "夕焼け"],
  青森: ["りんご", "ねぶた", "東北"],
  冬: ["雪", "こたつ", "みかん"],
  紫: ["ぶどう", "なす", "あじさい"],
  秋: ["紅葉", "栗", "ぶどう"],
  ねこ: ["動物", "ひげ", "こたつ"],
  いぬ: ["動物", "散歩", "公園"],
  動物園: ["ぞう", "きりん", "遠足"],
  海: ["夏", "魚", "砂浜"],
  花火: ["夏", "夜空", "お祭り"],
  すいか: ["夏", "赤", "海"],
  春: ["桜", "花", "入学"],
  雪: ["冬", "白", "雪だるま"],
  こたつ: ["冬", "みかん", "ねこ"],
  散歩: ["公園", "いぬ", "健康"],
  公園: ["散歩", "遊具", "緑"],
  旅行: ["電車", "温泉", "写真"],
  魚: ["海", "水族館", "料理"],
  桜: ["春", "花見", "ピンク"],
  お祭り: ["花火", "屋台", "夏"],
}

const memorySuggestions: Record<string, string[]> = {
  子どものころ好きだった遊び: ["かくれんぼ", "おにごっこ", "なわとび"],
  昔よく食べた懐かしい料理: ["カレーライス", "コロッケ", "おにぎり"],
  春になると思い出すこと: ["お花見", "入学式", "遠足"],
  行ってみたい日本の場所: ["京都", "北海道", "沖縄"],
  好きだった歌や音楽: ["童謡", "歌謡曲", "ラジオの音楽"],
  学校で楽しかった思い出: ["運動会", "給食", "修学旅行"],
  家族と出かけた思い出: ["海水浴", "動物園", "温泉"],
  昔使っていた懐かしい道具: ["黒電話", "そろばん", "ラジカセ"],
}

function normalizeAssociationWord(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, "").toLocaleLowerCase("ja")
}

function normalizeShiritoriWord(value: string): string {
  return value
    .trim()
    .replace(/[、。・\s！？!?]/g, "")
    .replace(/[ァ-ヶ]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0x60),
    )
    .replace(/[ゃゅょぁぃぅぇぉっ]/g, (character) => {
      const replacements: Record<string, string> = {
        ゃ: "や",
        ゅ: "ゆ",
        ょ: "よ",
        ぁ: "あ",
        ぃ: "い",
        ぅ: "う",
        ぇ: "え",
        ぉ: "お",
        っ: "つ",
      }
      return replacements[character] ?? character
    })
}

function lastShiritoriCharacter(value: string): string {
  const normalized = normalizeShiritoriWord(value)
  return normalized.endsWith("ー") && normalized.length > 1
    ? (normalized.at(-2) ?? "")
    : (normalized.at(-1) ?? "")
}

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const apiRoot = `https://${projectId}.supabase.co/functions/v1/make-server-8e9e0c0c`;
const sessionStorageKey = "sawakai-session";
const profileStorageKey = "sawakai-profile";
const activeGroupStorageKey = "sawakai-active-group";
const notificationStorageKey = "sawakai-notifications";
const notificationPreviewStorageKey = "sawakai-notification-preview";
const notificationSystemStorageKey = "sawakai-notification-system";
const quietHoursStorageKey = "sawakai-quiet-hours";
const appBadgeStorageKey = "sawakai-app-badge";
const textSizeStorageKey = "sawakai-text-size";
const analyticsStorageKey = "sawakai-analytics";
const themeStorageKey = "sawakai-theme";
const appName = "茶話会・みんなで脳活";
const fallbackSuggestions = ["土曜でいいね", "何時ごろにしますか？"];

function loadStoredProfile(): Profile | null {
  const stored = localStorage.getItem(profileStorageKey);
  if (!stored) return null;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "name" in parsed &&
      typeof parsed.name === "string" &&
      parsed.name.trim()
    ) {
      return {
        name: parsed.name,
        imageUrl:
          "imageUrl" in parsed && typeof parsed.imageUrl === "string"
            ? parsed.imageUrl
            : undefined,
      };
    }
  } catch {
    // A partial or legacy value should not prevent the app from opening.
  }

  localStorage.removeItem(profileStorageKey);
  localStorage.removeItem(sessionStorageKey);
  return null;
}

const localBrainQuestionBank: Record<
  BrainDifficulty,
  Required<BrainQuestion>[]
> = {
  easy: [
    {
      id: "local-easy-order",
      category: "暮らし",
      prompt: "植物の変化を早い順に並べたものはどれですか？",
      choices: ["つぼみ→花→実", "花→つぼみ→実", "実→花→つぼみ"],
      correctIndex: 0,
      explanation: "多くの植物は、つぼみから花が咲き、その後に実ができます。",
    },
    {
      id: "local-easy-attention",
      category: "注意",
      prompt: "数字の「2」はいくつありますか？ 2・5・2・8・2・9・2",
      choices: ["3つ", "4つ", "5つ"],
      correctIndex: 1,
      explanation: "左から数えると「2」は4つあります。",
    },
    {
      id: "local-easy-opposite",
      category: "ことば",
      prompt: "「増える」と反対の意味に近い言葉はどれですか？",
      choices: ["減る", "集まる", "続く"],
      correctIndex: 0,
      explanation: "増えるの反対は減るです。",
    },
    {
      id: "local-easy-time",
      category: "暮らし",
      prompt: "午前9時20分から40分後は何時ですか？",
      choices: ["午前9時50分", "午前10時", "午前10時20分"],
      correctIndex: 1,
      explanation: "9時20分に40分を足すと10時です。",
    },
  ],
  normal: [
    {
      id: "local-normal-sequence",
      category: "注意",
      prompt: "4・7・10・13と続きます。次の数字はどれですか？",
      choices: ["15", "16", "17"],
      correctIndex: 1,
      explanation: "3ずつ増えているので、13の次は16です。",
    },
    {
      id: "local-normal-proverb",
      category: "ことば",
      prompt: "「石の上にも三年」に近い意味はどれですか？",
      choices: [
        "続けると成果につながる",
        "急いだ方がよい",
        "場所を変えた方がよい",
      ],
      correctIndex: 0,
      explanation: "辛抱強く続ければ成果につながる、という意味です。",
    },
    {
      id: "local-normal-shopping",
      category: "暮らし",
      prompt: "120円の品を3個買い、500円を出しました。おつりはいくらですか？",
      choices: ["120円", "140円", "160円"],
      correctIndex: 1,
      explanation: "120円×3個は360円なので、おつりは140円です。",
    },
    {
      id: "local-normal-word",
      category: "ことば",
      prompt: "仲間が違うものはどれですか？",
      choices: ["新聞", "雑誌", "冷蔵庫"],
      correctIndex: 2,
      explanation: "新聞と雑誌は読むものですが、冷蔵庫は家電です。",
    },
    {
      id: "local-normal-history-edo",
      category: "歴史",
      prompt: "江戸幕府を開いた人物は誰ですか？",
      choices: ["徳川家康", "豊臣秀吉", "織田信長"],
      correctIndex: 0,
      explanation: "徳川家康が江戸幕府を開きました。",
    },
    {
      id: "local-normal-history-era",
      category: "歴史",
      prompt: "江戸時代の次に始まった時代はどれですか？",
      choices: ["明治時代", "室町時代", "平安時代"],
      correctIndex: 0,
      explanation: "江戸時代の次は明治時代です。",
    },
    {
      id: "local-normal-history-kamakura",
      category: "歴史",
      prompt: "鎌倉幕府を開いた人物は誰ですか？",
      choices: ["源頼朝", "足利尊氏", "徳川家康"],
      correctIndex: 0,
      explanation: "源頼朝が鎌倉幕府を開きました。",
    },
    {
      id: "local-normal-history-kinkaku",
      category: "歴史",
      prompt: "金閣を建てたことで知られる人物は誰ですか？",
      choices: ["足利義満", "足利尊氏", "聖徳太子"],
      correctIndex: 0,
      explanation: "室町幕府3代将軍の足利義満が金閣を建てました。",
    },
    {
      id: "local-normal-history-meiji",
      category: "歴史",
      prompt: "明治時代に行われたものはどれですか？",
      choices: ["廃藩置県", "参勤交代", "大化の改新"],
      correctIndex: 0,
      explanation: "廃藩置県は明治時代に行われました。",
    },
    {
      id: "local-normal-difference",
      category: "間違い探し",
      prompt: "見本「春・夏・秋・冬」と一文字違うのはどれですか？",
      choices: ["春・夏・秋・冬", "春・夏・秌・冬", "春・夏・秋・冬"],
      correctIndex: 1,
      explanation: "2番だけ「秋」が「秌」になっています。",
    },
  ],
  challenge: [
    {
      id: "local-challenge-sequence",
      category: "注意",
      prompt: "1・2・4・7・11と続きます。次の数字はどれですか？",
      choices: ["15", "16", "17"],
      correctIndex: 1,
      explanation: "1、2、3、4と増える数が一つずつ大きくなるため、次は5を足して16です。",
    },
    {
      id: "local-challenge-memory",
      category: "注意",
      prompt: "青・赤・黄・青・緑・赤。2回出てきた色の組み合わせはどれですか？",
      choices: ["青と赤", "赤と黄", "青と緑"],
      correctIndex: 0,
      explanation: "青と赤がそれぞれ2回ずつ出てきます。",
    },
    {
      id: "local-challenge-time",
      category: "暮らし",
      prompt: "午前9時45分から午前11時20分までは何時間何分ですか？",
      choices: ["1時間25分", "1時間35分", "1時間45分"],
      correctIndex: 1,
      explanation: "9時45分から10時45分で1時間、さらに35分です。",
    },
    {
      id: "local-challenge-shopping",
      category: "計算",
      prompt: "680円と240円の品を買い、1000円を出しました。おつりはいくらですか？",
      choices: ["60円", "80円", "120円"],
      correctIndex: 1,
      explanation: "合計は920円なので、おつりは80円です。",
    },
    {
      id: "local-challenge-history-order",
      category: "歴史",
      prompt: "古い順に正しく並んでいるものはどれですか？",
      choices: [
        "平安時代→鎌倉時代→室町時代",
        "鎌倉時代→平安時代→室町時代",
        "室町時代→鎌倉時代→平安時代",
      ],
      correctIndex: 0,
      explanation: "平安時代、鎌倉時代、室町時代の順です。",
    },
    {
      id: "local-challenge-history-restoration",
      category: "歴史",
      prompt: "大政奉還を行った江戸幕府最後の将軍は誰ですか？",
      choices: ["徳川慶喜", "徳川家光", "徳川吉宗"],
      correctIndex: 0,
      explanation: "第15代将軍の徳川慶喜が大政奉還を行いました。",
    },
    {
      id: "local-challenge-difference",
      category: "間違い探し",
      prompt: "見本「東京・京都・大阪・神戸」と一文字違うのはどれですか？",
      choices: [
        "東京・京都・大阪・神戸",
        "東京・京都・大坂・神戸",
        "東京・京都・大阪・神戸",
      ],
      correctIndex: 1,
      explanation: "2番だけ「大阪」が「大坂」になっています。",
    },
    {
      id: "local-challenge-history-period",
      category: "歴史",
      prompt: "江戸、明治、大正、昭和を古い順に並べたものはどれですか？",
      choices: [
        "江戸→明治→大正→昭和",
        "江戸→大正→明治→昭和",
        "明治→江戸→大正→昭和",
      ],
      correctIndex: 0,
      explanation: "江戸、明治、大正、昭和の順です。",
    },
    {
      id: "local-challenge-history-onin",
      category: "歴史",
      prompt: "応仁の乱が起きた時代はどれですか？",
      choices: ["室町時代", "鎌倉時代", "江戸時代"],
      correctIndex: 0,
      explanation: "応仁の乱は室町時代に起きました。",
    },
    {
      id: "local-challenge-history-reform",
      category: "歴史",
      prompt: "古い順に正しく並んでいる改革はどれですか？",
      choices: [
        "享保の改革→寛政の改革→天保の改革",
        "寛政の改革→享保の改革→天保の改革",
        "天保の改革→享保の改革→寛政の改革",
      ],
      correctIndex: 0,
      explanation: "享保、寛政、天保の改革の順です。",
    },
  ],
};

const safetyBrainQuestionBank: Required<BrainQuestion>[] = [
  { id: "safety-earthquake", category: "防災", prompt: "強い地震で揺れているとき、まず取る行動はどれですか？", choices: ["丈夫な机の下などで頭を守る", "急いで外へ飛び出す", "エレベーターに乗る"], correctIndex: 0, explanation: "揺れている間は頭を守り、慌てて外へ飛び出さないことが大切です。" },
  { id: "safety-flood", category: "防災", prompt: "大雨で避難情報が出たとき、適切な行動はどれですか？", choices: ["明るいうちに安全な場所へ移動する", "川の様子を見に行く", "車で低い道を通る"], correctIndex: 0, explanation: "危険が迫る前に、川や低い場所を避けて安全な場所へ移動します。" },
  { id: "safety-fire", category: "防災", prompt: "火災で煙がある場所を避難するときの姿勢はどれですか？", choices: ["低い姿勢で移動する", "立ったまま走る", "その場で待ち続ける"], correctIndex: 0, explanation: "煙を吸いにくくするため、口元を覆い低い姿勢で避難します。" },
  { id: "health-heat", category: "健康", prompt: "暑い日に熱中症を防ぐ行動はどれですか？", choices: ["のどが渇く前から水分を取る", "水分を控える", "暑い部屋で我慢する"], correctIndex: 0, explanation: "水分をこまめに取り、涼しい場所や冷房も利用します。" },
  { id: "health-medicine", category: "健康", prompt: "薬の飲み方で安全なのはどれですか？", choices: ["決められた量と時間を守る", "調子で量を倍にする", "他人の薬を試す"], correctIndex: 0, explanation: "薬は医師や薬剤師の説明、薬袋の指示を守って使います。" },
  { id: "health-sudden", category: "健康", prompt: "突然ろれつが回らず片方の手足に力が入らないときはどうしますか？", choices: ["すぐに119番へ連絡する", "翌日まで様子を見る", "一人で車を運転する"], correctIndex: 0, explanation: "脳卒中などの可能性があるため、迷わず119番へ連絡します。" },
  { id: "fraud-phone", category: "防犯", prompt: "家族を名乗る電話で急にお金を求められたときはどうしますか？", choices: ["一度切り、元から知る番号へ確認する", "すぐ振り込む", "暗証番号を伝える"], correctIndex: 0, explanation: "電話を一度切り、普段使っている家族の番号や警察相談窓口へ確認します。" },
  { id: "fraud-card", category: "防犯", prompt: "警察や銀行を名乗る人からキャッシュカードを預かると言われたら？", choices: ["渡さず、正式な窓口へ確認する", "暗証番号と一緒に渡す", "玄関に置いておく"], correctIndex: 0, explanation: "警察や銀行職員が暗証番号を聞いたり、カードを預かったりすることはありません。" },
  { id: "fraud-message", category: "防犯", prompt: "身に覚えのない料金請求のメールが届いたらどうしますか？", choices: ["リンクを開かず公式窓口へ確認する", "記載番号へすぐ電話する", "カード番号を入力する"], correctIndex: 0, explanation: "メール内のリンクや番号は使わず、公式サイトなどから確認します。" },
  { id: "traffic-crossing", category: "交通", prompt: "横断歩道を渡る前に確認することはどれですか？", choices: ["左右の安全と車の停止", "信号だけ", "後ろだけ"], correctIndex: 0, explanation: "青信号でも左右を確認し、車が止まったことを確かめて渡ります。" },
  { id: "traffic-bicycle", category: "交通", prompt: "自転車に乗るとき安全のために大切なのはどれですか？", choices: ["ヘルメットを着用する", "傘を差して運転する", "スマートフォンを見ながら走る"], correctIndex: 0, explanation: "ヘルメットを着用し、ながら運転をしないことが大切です。" },
  { id: "traffic-night", category: "交通", prompt: "夜道を歩くとき、車から見えやすくする方法はどれですか？", choices: ["明るい服や反射材を使う", "黒い服だけ着る", "車道の中央を歩く"], correctIndex: 0, explanation: "明るい服や反射材、ライトを使うと運転者から見えやすくなります。" },
  { id: "common-119", category: "一般常識", prompt: "救急車や消防車を呼ぶ電話番号はどれですか？", choices: ["119", "110", "118"], correctIndex: 0, explanation: "火事や救急は119番、事件や事故で警察を呼ぶときは110番です。" },
  { id: "common-freeze", category: "一般常識", prompt: "冷凍食品を買った後の扱いで適切なのはどれですか？", choices: ["なるべく早く冷凍庫へ入れる", "長時間常温に置く", "暖かい場所に置く"], correctIndex: 0, explanation: "品質と安全を保つため、持ち帰ったら早めに冷凍庫へ入れます。" },
  { id: "common-password", category: "一般常識", prompt: "インターネットのパスワード管理で安全なのはどれですか？", choices: ["他人に教えず使い回しを避ける", "全て同じにする", "紙に書いて玄関へ貼る"], correctIndex: 0, explanation: "推測されにくいパスワードを使い、サービスごとの使い回しを避けます。" },
  { id: "safety-quake-gas", category: "防災", prompt: "地震の揺れが収まった直後、火の始末で正しいのはどれですか？", choices: ["揺れが収まってから落ち着いて火元を確認する", "揺れている最中に必ず鍋を押さえる", "火は使ったまま避難する"], correctIndex: 0, explanation: "身の安全を最優先にし、揺れが収まってから火元を確認します。避難時はガスの元栓を閉めブレーカーを落とします。" },
  { id: "safety-tsunami", category: "防災", prompt: "海の近くで強い揺れを感じたとき、正しい行動はどれですか？", choices: ["海の様子を見に行く", "津波警報を待たず、すぐ高い場所へ逃げる", "警報が出るまで自宅で待つ"], correctIndex: 1, explanation: "津波は揺れの後すぐ来ることがあります。警報を待たず、できるだけ高い場所へ避難します。" },
  { id: "safety-stock", category: "防災", prompt: "災害に備えた水の備蓄の目安として正しいのはどれですか？", choices: ["1人1日500ミリリットルを1日分", "備蓄は不要で水道を使う", "1人1日3リットルを目安に数日分"], correctIndex: 2, explanation: "飲料水は1人1日3リットルを目安に、最低3日分、できれば1週間分の備えが勧められています。" },
  { id: "safety-evac-level", category: "防災", prompt: "高齢者等避難（警戒レベル3）が出たとき、高齢の方や避難に時間がかかる方はどうしますか？", choices: ["危険な場所から避難を始める", "レベル5になるまで待つ", "外に出ず何もしない"], correctIndex: 0, explanation: "レベル3は、避難に時間がかかる方が危険な場所から避難を始める段階です。" },
  { id: "safety-blackout", category: "防災", prompt: "停電のとき、明かりとして安全性が高いのはどれですか？", choices: ["ろうそくを床に置く", "懐中電灯やLEDランタン", "ライターの火を持ち歩く"], correctIndex: 1, explanation: "ろうそくは火災の原因になります。電池式の懐中電灯やランタンを備えておきます。" },
  { id: "safety-typhoon", category: "防災", prompt: "台風が接近しているとき、してはいけないことはどれですか？", choices: ["窓の近くから離れる", "早めに避難場所を確認する", "田んぼや川の様子を見に行く"], correctIndex: 2, explanation: "用水路や川の様子を見に行って事故に遭う例が多くあります。外出は控えましょう。" },
  { id: "health-stroke-act", category: "健康", prompt: "顔のゆがみ、腕の力が入らない、言葉が出にくい。この3つを確認する合言葉は何ですか？", choices: ["FAST（ファスト）", "STOP（ストップ）", "REST（レスト）"], correctIndex: 0, explanation: "FASTは顔・腕・言葉の異常と、すぐ救急要請するTime（時間）を表す合言葉です。" },
  { id: "health-bp", category: "健康", prompt: "高血圧を防ぐ生活習慣として適切なのはどれですか？", choices: ["毎日しっかり濃い味にする", "塩分を控えめにする", "運動を一切しない"], correctIndex: 1, explanation: "減塩、適度な運動、節酒、適正体重の維持が血圧管理に役立ちます。" },
  { id: "health-fall", category: "健康", prompt: "家の中での転倒を防ぐ工夫として適切なのはどれですか？", choices: ["夜は暗いまま歩く", "靴下だけで滑りやすい床を歩く", "床の物を片づけ、段差に手すりや照明を付ける"], correctIndex: 2, explanation: "つまずきやすい物を片づけ、手すりや足元の照明を整えると転倒を減らせます。" },
  { id: "health-flu", category: "健康", prompt: "冬に感染症を防ぐ基本的な習慣はどれですか？", choices: ["外出後の手洗いとうがい、換気", "手洗いをしない", "窓を閉め切って人混みへ行く"], correctIndex: 0, explanation: "手洗い、換気、必要に応じたマスクとワクチン接種が基本の予防策です。" },
  { id: "health-sleep", category: "健康", prompt: "睡眠のとり方で健康によいのはどれですか？", choices: ["昼夜逆転の生活を続ける", "毎日ほぼ同じ時刻に寝起きする", "寝る直前まで強い光の画面を見る"], correctIndex: 1, explanation: "規則正しい睡眠が生活リズムを整えます。寝る前の強い光は眠りを妨げます。" },
  { id: "health-water-heat", category: "健康", prompt: "入浴時のヒートショックを防ぐ方法はどれですか？", choices: ["熱いお湯にすぐ肩まで浸かる", "飲酒後にすぐ入浴する", "脱衣所や浴室を暖めてから入る"], correctIndex: 2, explanation: "急な温度差が血圧を大きく変えるため、脱衣所と浴室を暖め、ぬるめの湯にします。" },
  { id: "fraud-refund", category: "防犯", prompt: "「還付金があるのでATMで手続きを」と電話で言われました。正しい対応はどれですか？", choices: ["ATMへ行かず、電話を切って役所に確認する", "指示どおりATMを操作する", "口座番号を教える"], correctIndex: 0, explanation: "ATMで還付金を受け取る手続きはありません。電話を切り、役所や警察へ相談します。" },
  { id: "fraud-giftcard", category: "防犯", prompt: "「電子マネーのカードを買って番号を教えて」と求められたら、どうしますか？", choices: ["言われた番号を伝える", "詐欺を疑い、番号を教えず相談する", "コンビニで急いで購入する"], correctIndex: 1, explanation: "電子マネーの番号を要求するのは詐欺の典型的な手口です。消費生活センターや警察に相談します。" },
  { id: "fraud-door", category: "防犯", prompt: "訪問販売で「今だけ契約すれば安い」と迫られたら、どうしますか？", choices: ["急いで契約書に署名する", "個人情報をすべて教える", "その場で契約せず、はっきり断る"], correctIndex: 2, explanation: "契約を急がせる勧誘は要注意です。必要なければ断り、困ったら消費者ホットライン188へ相談します。" },
  { id: "fraud-188", category: "防犯", prompt: "契約や悪質商法で困ったとき、相談できる全国共通の番号はどれですか？", choices: ["188（消費者ホットライン）", "119", "117"], correctIndex: 0, explanation: "188は最寄りの消費生活センターにつながる消費者ホットラインです。" },
  { id: "fraud-9110", category: "防犯", prompt: "詐欺かどうか迷う電話があったとき、緊急ではない警察への相談に使う番号はどれですか？", choices: ["#8000", "#9110（警察相談専用電話）", "#7119"], correctIndex: 1, explanation: "#9110は警察相談専用電話です。緊急のときは110番へ連絡します。" },
  { id: "fraud-sms", category: "防犯", prompt: "宅配業者を名乗るSMSに、不在通知のリンクがありました。どうしますか？", choices: ["すぐにリンクを開いて入力する", "知人にも転送する", "リンクを開かず、公式アプリや窓口で確認する"], correctIndex: 2, explanation: "偽SMSから偽サイトへ誘導する手口があります。リンクは開かず、公式の方法で確認します。" },
  { id: "fraud-record", category: "防犯", prompt: "詐欺電話を防ぐ対策として有効なのはどれですか？", choices: ["留守番電話や通話録音機能を使う", "知らない番号にも必ず出て個人情報を話す", "電話では家族構成を詳しく話す"], correctIndex: 0, explanation: "留守番電話や通話録音機能付きの電話は、犯人に警戒されて効果があります。" },
  { id: "traffic-bike-helmet", category: "交通", prompt: "自転車の交通ルールとして正しいのはどれですか？", choices: ["並んで走ってよい", "夜間はライトをつける", "歩道を高速で走る"], correctIndex: 1, explanation: "夜間はライトをつけ、車道の左側を通行するなど、ルールを守りましょう。" },
  { id: "traffic-car-senior", category: "交通", prompt: "車の運転中、安全のために正しいのはどれですか？", choices: ["眠くても少し我慢して走る", "飲酒後でも少量なら運転する", "体調が悪いときは運転を控える"], correctIndex: 2, explanation: "疲れや眠気、体調不良は事故につながります。飲酒運転は絶対にいけません。" },
]

const localShapeQuestionBank: Record<
  BrainDifficulty,
  Required<BrainQuestion>[]
> = {
  easy: [
    {
      id: "shape-easy-sequence",
      category: "図形",
      prompt: "○・△・○・△と並んでいます。次の図形はどれですか？",
      choices: ["○（丸）", "△（三角）", "□（四角）"],
      correctIndex: 0,
      explanation: "丸と三角が交互に並んでいるので、次は丸です。",
    },
    {
      id: "shape-easy-direction",
      category: "図形",
      prompt: "向きが一つだけ違う図形はどれですか？ ▲・▲・▼",
      choices: ["左の▲", "真ん中の▲", "右の▼"],
      correctIndex: 2,
      explanation: "右の三角だけが下を向いています。",
    },
    {
      id: "shape-easy-count",
      category: "図形",
      prompt: "四角はいくつありますか？ □・○・□・△・□",
      choices: ["2つ", "3つ", "4つ"],
      correctIndex: 1,
      explanation: "四角は左、中央、右の3つです。",
    },
  ],
  normal: [
    {
      id: "shape-normal-rotation",
      category: "図形",
      prompt: "矢印が90度ずつ右へ回ります。↑・→・↓・？",
      choices: ["←", "↑", "→"],
      correctIndex: 0,
      explanation: "下向きの次は左向きです。",
    },
    {
      id: "shape-normal-reverse",
      category: "図形",
      prompt: "○・△・□を左右反対の順に並べるとどれですか？",
      choices: ["□・△・○", "△・○・□", "○・□・△"],
      correctIndex: 0,
      explanation: "並びを逆にすると、四角・三角・丸です。",
    },
    {
      id: "shape-normal-pair",
      category: "図形",
      prompt: "■・□□・■・□□と並んでいます。次はどれですか？",
      choices: ["■", "□", "■■"],
      correctIndex: 0,
      explanation: "黒四角1つと白四角2つが交互に並んでいます。",
    },
  ],
  challenge: [
    {
      id: "shape-challenge-double",
      category: "図形",
      prompt: "○・△・□・○○・△△と並んでいます。次はどれですか？",
      choices: ["□□", "○○○", "△△△"],
      correctIndex: 0,
      explanation: "丸・三角・四角の順で、2巡目は図形が2つずつになります。",
    },
    {
      id: "shape-challenge-direction",
      category: "図形",
      prompt: "▲・△・▼・▽・▲と並んでいます。次はどれですか？",
      choices: ["△", "▼", "▽"],
      correctIndex: 0,
      explanation: "上向き黒、上向き白、下向き黒、下向き白の順です。",
    },
    {
      id: "shape-challenge-grid",
      category: "図形",
      prompt: "上段が○・△、下段が△・？です。縦横で同じ図形が重ならない「？」はどれですか？",
      choices: ["○", "△", "□"],
      correctIndex: 0,
      explanation: "左列が丸と三角なので、右列も三角と丸にすると重なりません。",
    },
  ],
};

const localDifferencePairs = {
  normal: [
    ["春・夏・秋・冬", "春・夏・秌・冬"],
    ["赤・青・黄・緑", "赤・青・黄・縁"],
    ["月・火・水・木・金", "月・火・氷・木・金"],
    ["梅・桃・桜・藤", "梅・桃・楼・藤"],
    ["東・西・南・北", "東・西・商・北"],
  ],
  challenge: [
    ["東京・京都・大阪・神戸", "東京・京都・大坂・神戸"],
    ["札幌・仙台・横浜・名古屋", "札幌・仙台・横浜・名古尾"],
    ["一月・三月・五月・七月", "一月・三月・互月・七月"],
    ["松・竹・梅・桜・菊", "松・竹・毎・桜・菊"],
    ["北海道・本州・四国・九州", "北海道・本州・四国・丸州"],
  ],
} as const;

function createLocalDifferenceQuestion(
  difficulty: "normal" | "challenge",
  playIndex: number,
): Required<BrainQuestion> {
  const pairs = localDifferencePairs[difficulty];
  const [original, changed] = pairs[playIndex % pairs.length];
  return {
    id: `local-difference-${difficulty}-${playIndex}`,
    category: "間違い探し",
    prompt: `見本「${original}」と一文字違うのはどれですか？`,
    choices: [original, changed, original],
    correctIndex: 1,
    explanation: `2番だけが見本の「${original}」と一文字違います。`,
  };
}

function createLocalEasyAttentionQuestion(
  playIndex: number,
): Required<BrainQuestion> {
  const digits = ["1", "2", "3", "4", "5"];
  const target = digits[playIndex % digits.length];
  const length = 7 + (playIndex % 4);
  const sequence = Array.from(
    { length },
    (_, index) => digits[(index * 2 + playIndex) % digits.length],
  );
  const count = sequence.filter((digit) => digit === target).length;
  return {
    id: `local-attention-easy-${playIndex}`,
    category: "注意",
    prompt: `次の並びに「${target}」はいくつありますか？ ${sequence.join("・")}`,
    choices: [
      `${Math.max(0, count - 1)}個`,
      `${count}個`,
      `${count + 1}個`,
    ],
    correctIndex: 1,
    explanation: `「${target}」は${count}個あります。`,
  };
}

function createLocalShapeQuestion(
  difficulty: BrainDifficulty,
  playIndex: number,
): Required<BrainQuestion> {
  const symbols = ["○", "△", "□", "☆", "◇"];
  const target = symbols[playIndex % symbols.length];
  const length =
    difficulty === "challenge"
      ? 13 + (playIndex % 4)
      : difficulty === "normal"
        ? 9 + (playIndex % 3)
        : 6 + (playIndex % 3);
  const sequence = Array.from(
    { length },
    (_, index) =>
      symbols[
        (index * (difficulty === "challenge" ? 3 : difficulty === "normal" ? 2 : 1) +
          playIndex) %
          symbols.length
      ],
  );
  const count = sequence.filter((symbol) => symbol === target).length;
  return {
    id: `local-shape-${difficulty}-${playIndex}`,
    category: "図形",
    prompt: `次の並びに「${target}」はいくつありますか？ ${sequence.join("・")}`,
    choices: [
      `${Math.max(0, count - 1)}個`,
      `${count}個`,
      `${count + 1}個`,
    ],
    correctIndex: 1,
    explanation: `左から確認すると「${target}」は${count}個あります。`,
  };
}

function createLocalBrainQuestions(
  difficulty: BrainDifficulty,
  groupId: string,
): Required<BrainQuestion>[] {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  const historyKey = `sawakai-brain-history:${groupId}:${difficulty}:${today}`
  let history: string[] = []
  try {
    const stored = JSON.parse(localStorage.getItem(historyKey) ?? "[]")
    if (Array.isArray(stored)) history = stored.filter((item) => typeof item === "string")
  } catch {
    localStorage.removeItem(historyKey)
  }
  const playIndex = Math.floor(history.length / 5);
  const ranges = {
    easy: { first: 12, firstRange: 24, second: 4, secondRange: 15 },
    normal: { first: 25, firstRange: 45, second: 12, secondRange: 30 },
    challenge: { first: 6, firstRange: 7, second: 4, secondRange: 6 },
  }
  const range = ranges[difficulty]
  const firstStride = difficulty === "challenge" ? 3 : 7;
  const secondStride = difficulty === "challenge" ? 5 : 11;
  const first =
    range.first + ((playIndex * firstStride + 3) % range.firstRange);
  const second =
    range.second + ((playIndex * secondStride + 2) % range.secondRange);
  const total =
    difficulty === "challenge"
      ? first * second + first
      : difficulty === "normal"
        ? first + second - 10
        : first + second;
  const difference =
    difficulty === "challenge" ? first : difficulty === "normal" ? 5 : 3;
  const numericChoices = [
    total,
    total + difference,
    Math.max(1, total - difference),
  ].sort(
    () => Math.random() - 0.5,
  );
  const calculation: Required<BrainQuestion> = {
    id: `local-calculation-${Date.now()}`,
    category: "計算",
    prompt:
      difficulty === "challenge"
        ? `${first} × ${second} + ${first} はいくつですか？`
        : difficulty === "normal"
          ? `${first} + ${second} - 10 はいくつですか？`
          : `${first} + ${second} はいくつですか？`,
    choices: numericChoices.map(String),
    correctIndex: numericChoices.indexOf(total),
    explanation:
      difficulty === "challenge"
        ? `${first}×${second}を計算し、さらに${first}を足すと${total}です。`
        : difficulty === "normal"
          ? `${first}と${second}を足して10を引くと${total}です。`
          : `${first}に${second}を足すと${total}です。`,
  };
  const historyQuestions = localBrainQuestionBank[difficulty].filter(
    (question) => question.category === "歴史",
  );
  const selected =
    difficulty === "easy"
      ? createLocalEasyAttentionQuestion(playIndex)
      : playIndex % 2 === 0
      ? createLocalDifferenceQuestion(difficulty, Math.floor(playIndex / 2))
      : historyQuestions.length
        ? historyQuestions[Math.floor(playIndex / 2) % historyQuestions.length]
        : localBrainQuestionBank[difficulty][
            playIndex % localBrainQuestionBank[difficulty].length
          ];
  const varied = {
    ...selected,
    id: `${selected.id}-${crypto.randomUUID()}`,
  }
  const selectedShape = createLocalShapeQuestion(difficulty, playIndex);
  const shape = {
    ...selectedShape,
    id: `${selectedShape.id}-${crypto.randomUUID()}`,
  }
  const safetyFirst =
    safetyBrainQuestionBank[(playIndex * 2) % safetyBrainQuestionBank.length]
  const safetySecond =
    safetyBrainQuestionBank[(playIndex * 2 + 5) % safetyBrainQuestionBank.length]
  const safetyQuestions = [safetyFirst, safetySecond].map((question) => ({
    ...question,
    id: `${question.id}-${crypto.randomUUID()}`,
  }))
  localStorage.setItem(
    historyKey,
    JSON.stringify(
      [
        ...history,
        calculation.prompt,
        shape.prompt,
        selected.prompt,
        ...safetyQuestions.map((question) => question.prompt),
      ].slice(-300),
    ),
  )
  return difficulty === "easy"
    ? [calculation, shape, varied, ...safetyQuestions]
    : [varied, calculation, shape, ...safetyQuestions];
}

function hasValidBrainQuestions(round: BrainRound | null): boolean {
  return Boolean(
    round &&
      round.schemaVersion === 3 &&
      round.questions.length === 5 &&
      round.questions.every(
        (question) =>
          Array.isArray(question.choices) &&
          question.choices.length === 3 &&
          question.choices.every(
            (choice) => typeof choice === "string" && choice.trim().length > 0,
          ),
      ),
  );
}

function apiHeaders(token?: string, groupId?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${publicAnonKey}`,
    ...(token ? { "X-Session-Token": token } : {}),
    ...(groupId ? { "X-Group-Id": groupId } : {}),
  };
}

function mediaHeaders(token: string, groupId: string) {
  return {
    Authorization: `Bearer ${publicAnonKey}`,
    "X-Session-Token": token,
    "X-Group-Id": groupId,
  };
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = window.atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function compressImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1280;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像を縮小できませんでした。");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.72),
  );
  if (!blob) throw new Error("画像を縮小できませんでした。");
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.webp`, {
    type: "image/webp",
  });
}

async function showSystemNotification(
  title: string,
  body: string,
  tag: string,
) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      await registration.showNotification(title, {
        body,
        tag,
        icon: `${import.meta.env.BASE_URL}pwa-icon-192.png`,
        badge: `${import.meta.env.BASE_URL}pwa-icon-192.png`,
      });
      return;
    }
  }
  new Notification(title, { body, tag });
}

function SendIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="22"
      viewBox="0 0 24 24"
      width="22"
    >
      <path
        d="m22 2-7 20-4-9-9-4L22 2Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="m22 2-11 11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      viewBox="0 0 24 24"
      width="24"
    >
      <path
        d="m6 6 12 12M18 6 6 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      viewBox="0 0 24 24"
      width="24"
    >
      <path
        d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="25"
      viewBox="0 0 24 24"
      width="25"
    >
      <path
        d="M9.5 4.2A3.2 3.2 0 0 0 4 6.4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5.5 14v.3A3.7 3.7 0 0 0 9.2 18H10V5.3c0-.4-.2-.8-.5-1.1ZM14.5 4.2A3.2 3.2 0 0 1 20 6.4c0 .5-.1 1-.3 1.4a3.5 3.5 0 0 1-1.2 6.2v.3a3.7 3.7 0 0 1-3.7 3.7H14V5.3c0-.4.2-.8.5-1.1Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M7 9.5h3M14 9.5h3M7.5 14H10M14 14h2.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function NinePuzzleGrid({
  board,
  disabled = false,
  onSelect,
  selectedIndex,
}: {
  board: number[]
  disabled?: boolean
  onSelect: (index: number) => void
  selectedIndex: number | null
}) {
  return (
    <div aria-label="1から9の並べ替えパズル" className="nine-puzzle-grid">
      {board.map((value, index) => {
        const correct = value === index + 1
        const selected = selectedIndex === index
        return (
          <button
            aria-label={`${value}のパネル${correct ? "、正しい位置" : ""}`}
            aria-pressed={selected}
            className={`${correct ? "is-correct" : ""} ${
              selected ? "is-selected" : ""
            }`}
            disabled={disabled}
            key={`${value}-${index}`}
            onClick={() => onSelect(index)}
            type="button"
          >
            {value}
            {correct && <small>正しい位置</small>}
          </button>
        )
      })}
    </div>
  )
}

function NinePuzzlePractice({ onBack }: { onBack: () => void }) {
  const [board, setBoard] = useState(createNinePuzzleBoard)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [moves, setMoves] = useState(0)
  const complete = isNinePuzzleComplete(board)

  const selectTile = (index: number) => {
    if (complete) return
    if (selectedIndex === null) {
      setSelectedIndex(index)
      return
    }
    if (selectedIndex === index) {
      setSelectedIndex(null)
      return
    }
    setBoard((current) => {
      const next = [...current]
      ;[next[selectedIndex], next[index]] = [next[index], next[selectedIndex]]
      return next
    })
    setMoves((current) => current + 1)
    setSelectedIndex(null)
  }

  const restart = () => {
    setBoard(createNinePuzzleBoard())
    setSelectedIndex(null)
    setMoves(0)
  }

  return (
    <div className="nine-puzzle-screen">
      <button className="group-play-back" onClick={onBack}>
        遊びを選ぶ画面へ戻る
      </button>
      <p className="group-play-eyebrow">ひとりでゆっくり練習</p>
      <h3>みんなで9マス</h3>
      <div className={`nine-puzzle-status ${complete ? "is-complete" : ""}`}>
        <strong>
          {complete
            ? "完成しました"
            : selectedIndex === null
              ? "動かしたい数字を選びましょう"
              : "入れ替える相手を選びましょう"}
        </strong>
        <span>{moves}回 入れ替えました</span>
      </div>
      <NinePuzzleGrid
        board={board}
        disabled={complete}
        onSelect={selectTile}
        selectedIndex={selectedIndex}
      />
      {selectedIndex !== null && !complete && (
        <button
          className="nine-puzzle-cancel"
          onClick={() => setSelectedIndex(null)}
        >
          選び直す
        </button>
      )}
      <button className="nine-puzzle-restart" onClick={restart}>
        {complete ? "もう一度練習する" : "最初からやり直す"}
      </button>
    </div>
  )
}

function ProverbPuzzleBoard({
  board,
  disabled = false,
  onSelect,
  selectedIndex,
}: {
  board: string[]
  disabled?: boolean
  onSelect: (index: number) => void
  selectedIndex: number | null
}) {
  return (
    <div aria-label="ことわざの語句並べ替え" className="proverb-puzzle-board">
      {board.map((piece, index) => (
        <button
          aria-label={`${index + 1}番目、${piece}`}
          aria-pressed={selectedIndex === index}
          className={selectedIndex === index ? "is-selected" : ""}
          disabled={disabled}
          key={`${piece}-${index}`}
          onClick={() => onSelect(index)}
          type="button"
        >
          <small>{index + 1}</small>
          <strong>{piece}</strong>
        </button>
      ))}
    </div>
  )
}

function ProverbPuzzlePractice({ onBack }: { onBack: () => void }) {
  const [questions, setQuestions] = useState(() =>
    shuffledList(proverbQuestionBank).slice(0, 10),
  )
  const [questionIndex, setQuestionIndex] = useState(0)
  const [board, setBoard] = useState(() => createProverbBoard(questions[0]))
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [moves, setMoves] = useState(0)
  const [showMeaning, setShowMeaning] = useState(false)
  const complete = questionIndex >= questions.length
  const question = questions[Math.min(questionIndex, questions.length - 1)]

  const nextPracticeQuestion = () => {
    const nextQuestionIndex = questionIndex + 1
    setQuestionIndex(nextQuestionIndex)
    setShowMeaning(false)
    if (nextQuestionIndex < questions.length) {
      setBoard(createProverbBoard(questions[nextQuestionIndex]))
    }
  }

  const selectPiece = (index: number) => {
    if (complete || showMeaning) return
    if (selectedIndex === null) {
      setSelectedIndex(index)
      return
    }
    if (selectedIndex === index) {
      setSelectedIndex(null)
      return
    }
    const next = [...board]
    ;[next[selectedIndex], next[index]] = [next[index], next[selectedIndex]]
    setMoves((current) => current + 1)
    setSelectedIndex(null)
    if (isProverbComplete(next, question)) {
      setBoard(next)
      setShowMeaning(true)
    } else {
      setBoard(next)
    }
  }

  const restart = () => {
    const nextQuestions = shuffledList(proverbQuestionBank).slice(0, 10)
    setQuestions(nextQuestions)
    setQuestionIndex(0)
    setBoard(createProverbBoard(nextQuestions[0]))
    setSelectedIndex(null)
    setMoves(0)
    setShowMeaning(false)
  }

  return (
    <div className="proverb-puzzle-screen">
      <button className="group-play-back" onClick={onBack}>
        遊びを選ぶ画面へ戻る
      </button>
      <p className="group-play-eyebrow">ひとりでゆっくり練習</p>
      <h3>ことわざ並べ替え</h3>
      <div className={`proverb-puzzle-progress ${complete || showMeaning ? "is-complete" : ""}`}>
        <strong>
          {complete
            ? "10問完成しました"
            : showMeaning
              ? `正解　${question.pieces.join("")}`
              : `第${questionIndex + 1}問 / 10問`}
        </strong>
        <span>
          {complete
            ? `${moves}回の入れ替えで完成`
            : showMeaning
              ? question.hint
              : "語句を正しい順番に並べましょう"}
        </span>
      </div>
      <ProverbPuzzleBoard
        board={board}
        disabled={complete || showMeaning}
        onSelect={selectPiece}
        selectedIndex={selectedIndex}
      />
      {!complete && !showMeaning && (
        <p className="proverb-puzzle-guide">
          {selectedIndex === null
            ? "動かしたい語句を選びましょう"
            : "入れ替える語句を選びましょう"}
        </p>
      )}
      {selectedIndex !== null && !complete && !showMeaning && (
        <button
          className="nine-puzzle-cancel"
          onClick={() => setSelectedIndex(null)}
        >
          選び直す
        </button>
      )}
      {showMeaning && (
        <button className="group-play-start" onClick={nextPracticeQuestion}>
          {questionIndex + 1 >= questions.length
            ? "結果を見る"
            : "次の問題"}
        </button>
      )}
      <button className="nine-puzzle-restart" onClick={restart}>
        {complete ? "別の10問に挑戦する" : "最初からやり直す"}
      </button>
    </div>
  )
}

function MemoryMatchBoard({
  cards,
  disabled,
  matchedIds,
  onFlip,
  visibleIds,
}: {
  cards: MemoryCard[]
  disabled: boolean
  matchedIds: string[]
  onFlip: (cardId: string) => void
  visibleIds: string[]
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [page, setPage] = useState(0)
  const showPage = (nextPage: number) => {
    setPage(nextPage)
    scrollRef.current?.children[nextPage]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "start",
    })
  }
  const visible = new Set([...visibleIds, ...matchedIds])
  return (
    <div className="memory-match-board">
      <div className="memory-match-pages" role="tablist" aria-label="カード面">
        {[0, 1].map((pageIndex) => (
          <button
            aria-selected={page === pageIndex}
            className={page === pageIndex ? "is-active" : ""}
            key={pageIndex}
            onClick={() => showPage(pageIndex)}
            role="tab"
            type="button"
          >
            {pageIndex + 1}面
          </button>
        ))}
      </div>
      <div
        className="memory-match-scroll"
        onScroll={(event) => {
          const width = event.currentTarget.clientWidth
          if (width) setPage(Math.round(event.currentTarget.scrollLeft / width))
        }}
        ref={scrollRef}
      >
        {[cards.slice(0, 9), cards.slice(9, 18)].map((pageCards, pageIndex) => (
          <div
            aria-label={`${pageIndex + 1}面のカード`}
            className="memory-match-grid"
            key={pageIndex}
            role="tabpanel"
          >
            {pageCards.map((card, cardIndex) => {
              const isVisible = visible.has(card.id)
              const isMatched = matchedIds.includes(card.id)
              const cardNumber = pageIndex * 9 + cardIndex + 1
              return (
                <button
                  aria-label={
                    isVisible
                      ? `${cardNumber}番、${card.label}のカード`
                      : `${cardNumber}番、裏向きのカード`
                  }
                  className={`${isVisible ? "is-visible" : ""} ${
                    isMatched ? "is-matched" : ""
                  }`}
                  disabled={disabled || isMatched}
                  key={card.id}
                  onClick={() => onFlip(card.id)}
                  type="button"
                >
                  <span className="memory-card-number">{cardNumber}</span>
                  <span className="memory-card-face">
                    {isVisible ? card.label : "？"}
                  </span>
                  {isMatched && <small>そろいました</small>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <p className="memory-match-swipe">左右に動かして、もう一方の面も見られます</p>
    </div>
  )
}

function MemoryMatchPractice({ onBack }: { onBack: () => void }) {
  const [cards, setCards] = useState(createMemoryCards)
  const [revealedIds, setRevealedIds] = useState<string[]>([])
  const [matchedIds, setMatchedIds] = useState<string[]>([])
  const [attempts, setAttempts] = useState(0)
  const [isChecking, setIsChecking] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const complete = matchedIds.length === cards.length

  useEffect(() => {
    if (!countdown) return
    const timeout = window.setTimeout(() => {
      if (countdown === 1) {
        setRevealedIds([])
        setIsChecking(false)
      }
      setCountdown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearTimeout(timeout)
  }, [countdown])

  const flip = (cardId: string) => {
    if (isChecking || revealedIds.includes(cardId)) return
    if (!revealedIds.length) {
      setRevealedIds([cardId])
      return
    }
    const pair = [revealedIds[0], cardId]
    const first = cards.find((card) => card.id === pair[0])
    const second = cards.find((card) => card.id === pair[1])
    setAttempts((current) => current + 1)
    setRevealedIds(pair)
    if (first?.label === second?.label) {
      setMatchedIds((current) => [...current, ...pair])
      setRevealedIds([])
      return
    }
    setIsChecking(true)
    setCountdown(5)
  }

  const restart = () => {
    setCards(createMemoryCards())
    setRevealedIds([])
    setMatchedIds([])
    setAttempts(0)
    setIsChecking(false)
    setCountdown(0)
  }

  return (
    <div className="memory-match-screen">
      <button className="group-play-back" onClick={onBack}>
        遊びを選ぶ画面へ戻る
      </button>
      <p className="group-play-eyebrow">ひとりでゆっくり練習</p>
      <h3>みんなで神経衰弱</h3>
      <div className={`memory-match-status ${complete ? "is-complete" : ""}`}>
        <strong>
          {complete
            ? "9組そろいました"
            : countdown
              ? `カードを確認してください　${countdown}`
              : "同じカードを2枚見つけましょう"}
        </strong>
        <span>{matchedIds.length / 2}組完成・{attempts}回挑戦</span>
      </div>
      <MemoryMatchBoard
        cards={cards}
        disabled={complete || isChecking}
        matchedIds={matchedIds}
        onFlip={flip}
        visibleIds={revealedIds}
      />
      <button className="nine-puzzle-restart" onClick={restart}>
        {complete ? "もう一度遊ぶ" : "カードを配り直す"}
      </button>
    </div>
  )
}

function GroupActivities({
  activeGroupId,
  isAdmin,
  members,
  onBack,
  profile,
  token,
}: {
  activeGroupId: string
  isAdmin: boolean
  members: Member[]
  onBack: () => void
  profile: Profile
  token: string
}) {
  const [activity, setActivity] = useState<GroupActivity | null>(null)
  const [kind, setKind] = useState<GroupActivityKind>("shiritori")
  const [selectedNames, setSelectedNames] = useState<string[]>([])
  const [answer, setAnswer] = useState("")
  const [showHints, setShowHints] = useState(false)
  const [isPuzzlePractice, setIsPuzzlePractice] = useState(false)
  const [isProverbPractice, setIsProverbPractice] = useState(false)
  const [isMemoryMatchPractice, setIsMemoryMatchPractice] = useState(false)
  const [selectedPuzzleIndex, setSelectedPuzzleIndex] = useState<number | null>(
    null,
  )
  const [selectedProverbIndex, setSelectedProverbIndex] = useState<number | null>(
    null,
  )
  const [inviteNotice, setInviteNotice] = useState("")
  const [isInviting, setIsInviting] = useState(false)
  const [error, setError] = useState("")
  const [isBusy, setIsBusy] = useState(true)
  const [memoryCountdown, setMemoryCountdown] = useState(0)
  const advancingMemoryTurn = useRef(false)

  const loadActivity = async (quiet = false) => {
    if (!quiet) setIsBusy(true)
    try {
      const loadLatest = async (path: string) => {
        const response = await fetch(`${apiRoot}${path}`, {
          headers: apiHeaders(token, activeGroupId),
          cache: "no-store",
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.error)
        return result.activity as GroupActivity | null
      }
      const results = await Promise.allSettled([
        loadLatest("/activities/latest"),
        loadLatest("/nine-puzzles/latest"),
        loadLatest("/proverb-puzzles/latest"),
        loadLatest("/memory-matches/latest"),
      ])
      const candidates = results.flatMap((result) =>
        result.status === "fulfilled" && result.value ? [result.value] : [],
      )
      if (!candidates.length && results.every((result) => result.status === "rejected")) {
        throw results[0].status === "rejected"
          ? results[0].reason
          : new Error("みんなの遊びを読み込めませんでした。")
      }
      const activeCandidates = candidates.filter(
        (candidate) => candidate.status === "active",
      )
      const latest = [...(activeCandidates.length ? activeCandidates : candidates)]
        .sort(
          (first, second) =>
            new Date(first.createdAt).getTime() -
            new Date(second.createdAt).getTime(),
        )
        .at(-1) ?? null
      setActivity((current) =>
        current === null && latest?.status === "finished"
          ? null
          : latest,
      )
      setError("")
    } catch (reason) {
      if (!quiet) {
        setError(
          reason instanceof Error
            ? reason.message
            : "みんなの遊びを読み込めませんでした。",
        )
      }
    } finally {
      if (!quiet) setIsBusy(false)
    }
  }

  useEffect(() => {
    setSelectedNames(members.map((member) => member.name))
    void loadActivity()
    const interval = window.setInterval(() => void loadActivity(true), 4000)
    return () => window.clearInterval(interval)
  }, [activeGroupId])

  useEffect(() => {
    if (
      activity?.kind !== "memory-match" ||
      !activity.nextTurnAt ||
      activity.status !== "active"
    ) {
      setMemoryCountdown(0)
      advancingMemoryTurn.current = false
      return
    }
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil(
          (new Date(activity.nextTurnAt!).getTime() - Date.now()) / 1000,
        ),
      )
      setMemoryCountdown(remaining)
      if (remaining === 0 && !advancingMemoryTurn.current) {
        advancingMemoryTurn.current = true
        void fetch(`${apiRoot}/memory-matches/${activity.id}/advance`, {
          method: "POST",
          headers: apiHeaders(token, activeGroupId),
          body: "{}",
        })
          .then(async (response) => {
            const result = await response.json().catch(() => ({}))
            if (response.ok && result.activity) setActivity(result.activity)
          })
          .finally(() => {
            advancingMemoryTurn.current = false
          })
      }
    }
    tick()
    const interval = window.setInterval(tick, 250)
    return () => window.clearInterval(interval)
  }, [activity?.id, activity?.nextTurnAt, activity?.status, activeGroupId, token])

  useEffect(() => {
    setShowHints(false)
    setSelectedPuzzleIndex(null)
    setSelectedProverbIndex(null)
  }, [activity?.id, activity?.turnIndex])

  const start = async () => {
    setIsBusy(true)
    setError("")
    try {
      const endpoint =
        kind === "nine-puzzle"
          ? "/nine-puzzles"
          : kind === "proverb-puzzle"
            ? "/proverb-puzzles"
            : kind === "memory-match"
              ? "/memory-matches"
            : "/activities"
      const response = await fetch(`${apiRoot}${endpoint}`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({ kind, participants: selectedNames }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setActivity(result.activity)
      setAnswer("")
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "遊びを開始できませんでした。",
      )
    } finally {
      setIsBusy(false)
    }
  }

  const notifySelected = async () => {
    const recipients = selectedNames.filter((name) => name !== profile.name)
    if (!recipients.length) return
    setIsInviting(true)
    setInviteNotice("")
    setError("")
    try {
      const inviteEndpoint =
        kind === "nine-puzzle"
          ? "/nine-puzzles/invite"
          : kind === "proverb-puzzle"
            ? "/proverb-puzzles/invite"
            : kind === "memory-match"
              ? "/memory-matches/invite"
          : "/activities/invite"
      const response = await fetch(`${apiRoot}${inviteEndpoint}`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({ kind, participants: recipients }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setInviteNotice(
        result.notifiedCount > 0
          ? `${result.notifiedCount}人に遊びのお誘いを送りました。`
          : "選んだ参加者は、まだ通知を有効にしていません。",
      )
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "お誘いの通知を送れませんでした。",
      )
    } finally {
      setIsInviting(false)
    }
  }

  const activityAction = async (
    action: "answer" | "skip" | "finish",
    answerText = answer,
  ) => {
    if (!activity) return
    const submittedAnswer = answerText.trim()
    if (action === "answer" && !submittedAnswer) return
    setIsBusy(true)
    setError("")
    try {
      const activityRoot =
        activity.kind === "nine-puzzle"
          ? "nine-puzzles"
          : activity.kind === "proverb-puzzle"
            ? "proverb-puzzles"
            : activity.kind === "memory-match"
              ? "memory-matches"
            : "activities"
      const response = await fetch(
        `${apiRoot}/${activityRoot}/${activity.id}/${action}`,
        {
          method: "POST",
          headers: apiHeaders(token, activeGroupId),
          body:
            action === "answer"
              ? JSON.stringify({ text: submittedAnswer })
              : "{}",
        },
      )
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setActivity(result.activity)
      setAnswer("")
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "操作を完了できませんでした。",
      )
    } finally {
      setIsBusy(false)
    }
  }

  const movePuzzle = async (first: number, second: number) => {
    if (!activity || activity.kind !== "nine-puzzle") return
    setIsBusy(true)
    setError("")
    try {
      const response = await fetch(
        `${apiRoot}/nine-puzzles/${activity.id}/move`,
        {
          method: "POST",
          headers: apiHeaders(token, activeGroupId),
          body: JSON.stringify({ first, second }),
        },
      )
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error)
      setActivity(result.activity)
      setSelectedPuzzleIndex(null)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "パネルを入れ替えられませんでした。",
      )
    } finally {
      setIsBusy(false)
    }
  }

  const selectPuzzleTile = (index: number) => {
    if (selectedPuzzleIndex === null) {
      setSelectedPuzzleIndex(index)
      return
    }
    if (selectedPuzzleIndex === index) {
      setSelectedPuzzleIndex(null)
      return
    }
    void movePuzzle(selectedPuzzleIndex, index)
  }

  const moveProverb = async (first: number, second: number) => {
    if (!activity || activity.kind !== "proverb-puzzle") return
    setIsBusy(true)
    setError("")
    try {
      const response = await fetch(
        `${apiRoot}/proverb-puzzles/${activity.id}/move`,
        {
          method: "POST",
          headers: apiHeaders(token, activeGroupId),
          body: JSON.stringify({ first, second }),
        },
      )
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error)
      setActivity(result.activity)
      setSelectedProverbIndex(null)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "語句を入れ替えられませんでした。",
      )
    } finally {
      setIsBusy(false)
    }
  }

  const advanceProverbQuestion = async () => {
    if (!activity || activity.kind !== "proverb-puzzle") return
    setIsBusy(true)
    setError("")
    try {
      const response = await fetch(
        `${apiRoot}/proverb-puzzles/${activity.id}/advance`,
        {
          method: "POST",
          headers: apiHeaders(token, activeGroupId),
          body: "{}",
        },
      )
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error)
      setActivity(result.activity)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "次の問題へ進めませんでした。",
      )
    } finally {
      setIsBusy(false)
    }
  }

  const selectProverbPiece = (index: number) => {
    if (selectedProverbIndex === null) {
      setSelectedProverbIndex(index)
      return
    }
    if (selectedProverbIndex === index) {
      setSelectedProverbIndex(null)
      return
    }
    void moveProverb(selectedProverbIndex, index)
  }

  const flipMemoryCard = async (cardId: string) => {
    if (!activity || activity.kind !== "memory-match") return
    setIsBusy(true)
    setError("")
    try {
      const response = await fetch(
        `${apiRoot}/memory-matches/${activity.id}/flip`,
        {
          method: "POST",
          headers: apiHeaders(token, activeGroupId),
          body: JSON.stringify({ cardId }),
        },
      )
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error)
      if (result.activity.nextTurnAt) setMemoryCountdown(5)
      setActivity(result.activity)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "カードをめくれませんでした。",
      )
    } finally {
      setIsBusy(false)
    }
  }

  const gameNames: Record<GroupActivityKind, string> = {
    shiritori: "しりとり",
    association: "連想リレー",
    memory: "思い出お題",
    "nine-puzzle": "みんなで9マス",
    "proverb-puzzle": "ことわざ並べ替え",
    "memory-match": "みんなで神経衰弱",
  }
  const gameDescriptions: Record<GroupActivityKind, string> = {
    shiritori: "前の言葉の最後の文字から、次の言葉をつなぎます",
    association: "前の言葉から思い浮かぶものを順番に答えます",
    memory: "懐かしいお題について、一人ずつ思い出を話します",
    "nine-puzzle": "2枚を選んで入れ替え、1から9まで順番に並べます",
    "proverb-puzzle": "語句を入れ替えて、ランダムなことわざ10問を完成させます",
    "memory-match": "18枚のカードから同じ言葉の9組を見つけます",
  }
  const currentName = activity
    ? activity.participants[activity.turnIndex % activity.participants.length]
    : ""
  const myTurn = currentName === profile.name
  const previousWord = activity?.entries.at(-1)?.text ?? ""
  const requiredShiritoriCharacter = previousWord
    ? lastShiritoriCharacter(previousWord)
    : ""
  const usedShiritoriWords = new Set(
    activity?.entries.map((entry) => normalizeShiritoriWord(entry.text)) ?? [],
  )
  const associationKey = normalizeAssociationWord(activity?.prompt ?? "")
  const usedAssociationWords = new Set(
    activity?.entries.map((entry) => normalizeAssociationWord(entry.text)) ?? [],
  )
  const suggestions =
    activity?.kind === "shiritori"
      ? requiredShiritoriCharacter
        ? (shiritoriSuggestions[requiredShiritoriCharacter] ?? []).filter(
            (word) => !usedShiritoriWords.has(normalizeShiritoriWord(word)),
          )
        : ["りんご", "さくら", "ねこ"]
      : activity?.kind === "association"
        ? (associationSuggestions[associationKey] ?? []).filter(
            (word) => !usedAssociationWords.has(normalizeAssociationWord(word)),
          )
        : (memorySuggestions[activity?.prompt ?? ""] ?? [])

  if (isPuzzlePractice) {
    return <NinePuzzlePractice onBack={() => setIsPuzzlePractice(false)} />
  }

  if (isProverbPractice) {
    return <ProverbPuzzlePractice onBack={() => setIsProverbPractice(false)} />
  }

  if (isMemoryMatchPractice) {
    return <MemoryMatchPractice onBack={() => setIsMemoryMatchPractice(false)} />
  }

  if (isBusy && !activity) {
    return <div className="group-play-loading">準備しています…</div>
  }

  if (
    activity?.kind === "nine-puzzle" &&
    activity.status === "finished"
  ) {
    const complete = isNinePuzzleComplete(activity.board ?? [])
    return (
      <div className="group-play-review nine-puzzle-review">
        <button className="group-play-back" onClick={onBack}>
          脳活タイムへ戻る
        </button>
        <div className="group-play-review__hero">
          <span>{complete ? "みんなで完成" : "パズルを終了しました"}</span>
          <h3>みんなで9マス</h3>
          <strong>{activity.moves ?? 0}回 入れ替えました</strong>
        </div>
        <NinePuzzleGrid
          board={activity.board ?? [1, 2, 3, 4, 5, 6, 7, 8, 9]}
          disabled
          onSelect={() => undefined}
          selectedIndex={null}
        />
        {isAdmin ? (
          <button
            className="group-play-start"
            onClick={() => setActivity(null)}
          >
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

  if (
    activity?.kind === "proverb-puzzle" &&
    activity.status === "finished"
  ) {
    const allComplete =
      (activity.solvedCount ?? 0) >= (activity.questions?.length ?? 10)
    return (
      <div className="group-play-review proverb-puzzle-review">
        <button className="group-play-back" onClick={onBack}>
          脳活タイムへ戻る
        </button>
        <div className="group-play-review__hero">
          <span>{allComplete ? "10問完成" : "並べ替えを終了しました"}</span>
          <h3>ことわざ並べ替え</h3>
          <strong>
            {activity.solvedCount ?? 0}問正解・{activity.moves ?? 0}回入れ替え
          </strong>
        </div>
        <p className="proverb-puzzle-result">
          {allComplete
            ? "みんなで力を合わせて、すべてのことわざを完成させました。"
            : "続きはまた次回、みんなで挑戦しましょう。"}
        </p>
        {isAdmin ? (
          <button
            className="group-play-start"
            onClick={() => setActivity(null)}
          >
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

  if (activity?.kind === "memory-match" && activity.status === "finished") {
    const scores = Object.entries(activity.matchesByName ?? {}).sort(
      ([, first], [, second]) => second - first,
    )
    const totalPairs = (activity.matchedIds?.length ?? 0) / 2
    return (
      <div className="group-play-review memory-match-review">
        <button className="group-play-back" onClick={onBack}>
          脳活タイムへ戻る
        </button>
        <div className="group-play-review__hero">
          <span>
            {(activity.matchedIds?.length ?? 0) === 18
              ? "9組そろいました"
              : "ゲームを終了しました"}
          </span>
          <h3>みんなで神経衰弱</h3>
          <strong>{activity.attempts ?? 0}回挑戦しました</strong>
        </div>
        <div className="memory-match-total-result">
          <span>みんなで見つけたペア</span>
          <strong>
            {totalPairs}<small> / 9組</small>
          </strong>
        </div>
        <h4 className="memory-match-results-title">参加者ごとのペア数</h4>
        <div className="memory-match-results">
          {scores.map(([name, score]) => (
            <div key={name}>
              <span>{name}さん</span>
              <strong>{score}組</strong>
            </div>
          ))}
        </div>
        {isAdmin ? (
          <button className="group-play-start" onClick={() => setActivity(null)}>
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

  if (activity?.status === "finished") {
    return (
      <div className="group-play-review">
        <button className="group-play-back" onClick={onBack}>
          脳活タイムへ戻る
        </button>
        <div className="group-play-review__hero">
          <span>おつかれさまでした</span>
          <h3>{gameNames[activity.kind]}の振り返り</h3>
          <strong>{activity.entries.length}回つながりました</strong>
        </div>
        <div className="group-play-history">
          <h4>みんなの答え</h4>
          {activity.entries.length ? (
            activity.entries.map((entry, index) => (
              <div key={`${entry.createdAt}-${index}`}>
                <strong>{entry.name}</strong>
                <span>{entry.text}</span>
              </div>
            ))
          ) : (
            <p className="group-play-waiting">
              今回は回答がありませんでした。また遊んでみましょう。
            </p>
          )}
        </div>
        {isAdmin ? (
          <button
            className="group-play-start"
            onClick={() => setActivity(null)}
          >
            次の遊びを選ぶ
          </button>
        ) : (
          <p className="group-play-waiting">
            管理者が次の遊びを始めるまで、この記録を見返せます。
          </p>
        )}
      </div>
    )
  }

  if (!activity) {
    return (
      <div className="group-play-setup">
        <button className="group-play-back" onClick={onBack}>
          脳活タイムへ戻る
        </button>
        <p className="group-play-eyebrow">指先で選んで、みんなで楽しむ</p>
        <h3>みんなの遊び</h3>
        <p className="group-play-lead">
          大きなボタンを順番に押すだけで楽しめます。
        </p>
        <div className="group-play-games">
          {(
            [
              "shiritori",
              "association",
              "memory",
              "nine-puzzle",
              "proverb-puzzle",
              "memory-match",
            ] as const
          ).map((value) => (
              <button
                aria-pressed={kind === value}
                className={kind === value ? "is-selected" : ""}
                key={value}
                onClick={() => {
                  setKind(value)
                  setInviteNotice("")
                }}
              >
                <strong>{gameNames[value]}</strong>
                <span>{gameDescriptions[value]}</span>
              </button>
            ))}
        </div>
        {kind === "nine-puzzle" && (
          <button
            className="nine-puzzle-practice-launch"
            onClick={() => setIsPuzzlePractice(true)}
          >
            <strong>ひとりで練習する</strong>
            <span>通知や参加者選択なしですぐに始められます</span>
          </button>
        )}
        {kind === "proverb-puzzle" && (
          <button
            className="nine-puzzle-practice-launch"
            onClick={() => setIsProverbPractice(true)}
          >
            <strong>ひとりで練習する</strong>
            <span>ランダムに選ばれた10問へすぐに挑戦できます</span>
          </button>
        )}
        {kind === "memory-match" && (
          <button
            className="nine-puzzle-practice-launch"
            onClick={() => setIsMemoryMatchPractice(true)}
          >
            <strong>ひとりで練習する</strong>
            <span>18枚・9組のカードですぐに始められます</span>
          </button>
        )}
        <h4>遊ぶ人を選ぶ</h4>
        <div className="group-play-members">
          {members.map((member) => {
            const selected = selectedNames.includes(member.name)
            return (
              <button
                aria-pressed={selected}
                className={selected ? "is-selected" : ""}
                key={member.name}
                onClick={() => {
                  setInviteNotice("")
                  setSelectedNames((current) =>
                    selected
                      ? current.filter((name) => name !== member.name)
                      : [...current, member.name],
                  )
                }}
              >
                <span>{selected ? "✓" : "＋"}</span>
                {member.name}
              </button>
            )
          })}
        </div>
        {error && <p className="group-play-error">{error}</p>}
        {inviteNotice && (
          <p className="group-play-invite-notice">{inviteNotice}</p>
        )}
        {isAdmin ? (
          <>
            <button
              className="group-play-invite"
              disabled={
                !selectedNames.some((name) => name !== profile.name) ||
                isInviting
              }
              onClick={() => void notifySelected()}
            >
              {isInviting ? "通知を送っています…" : "選んだ人に通知する"}
            </button>
            <button
              className="group-play-start"
              disabled={selectedNames.length < 2 || isBusy}
              onClick={() => void start()}
            >
              {selectedNames.length < 2
                ? "2人以上選んでください"
                : `${selectedNames.length}人で始める`}
            </button>
          </>
        ) : (
          <p className="group-play-waiting">
            管理者が遊びを始めるまでお待ちください。
          </p>
        )}
      </div>
    )
  }

  if (activity.kind === "memory-match") {
    const waitingForNextTurn = Boolean(activity.nextTurnAt)
    const visibleIds = [
      ...(activity.revealedIds ?? []),
      ...(waitingForNextTurn ? (activity.lastMismatchIds ?? []) : []),
    ]
    const selectedCards = visibleIds.flatMap((cardId) => {
      const index = activity.cards?.findIndex((card) => card.id === cardId) ?? -1
      const card = index >= 0 ? activity.cards?.[index] : undefined
      return card
        ? [
            {
              ...card,
              number: index + 1,
              page: index < 9 ? 1 : 2,
            },
          ]
        : []
    })
    return (
      <div className="group-play-active memory-match-screen">
        <button className="group-play-back" onClick={onBack}>
          脳活タイムへ戻る
        </button>
        <div className="group-play-heading">
          <span>みんなで神経衰弱</span>
          <strong>{(activity.matchedIds?.length ?? 0) / 2}組 / 9組</strong>
        </div>
        <div className={`group-play-turn ${myTurn ? "is-my-turn" : ""}`}>
          <small>{myTurn ? "あなたの番です" : "次の人"}</small>
          <strong>{currentName}さん</strong>
        </div>
        <div className="memory-match-status">
          <strong>
            {waitingForNextTurn
              ? "2枚のカードを確認してください"
              : myTurn
                ? visibleIds.length
                  ? "もう1枚選びましょう"
                  : "カードを1枚選びましょう"
                : `${currentName}さんの操作を待っています`}
          </strong>
          {waitingForNextTurn ? (
            <span className="memory-match-countdown">
              次の方まで <b>{Math.max(1, memoryCountdown)}</b>
            </span>
          ) : (
            <span>2面を左右に動かして、同じ言葉を探します</span>
          )}
        </div>
        {selectedCards.length > 0 && (
          <div className="memory-match-shared-selection" aria-live="polite">
            <span>{currentName}さんがめくったカード</span>
            <div>
              {selectedCards.map((card) => (
                <strong key={card.id}>
                  <small>{card.page}面</small>
                  {card.number}番
                  <b>{card.label}</b>
                </strong>
              ))}
            </div>
          </div>
        )}
        <MemoryMatchBoard
          cards={activity.cards ?? []}
          disabled={!myTurn || isBusy || waitingForNextTurn}
          matchedIds={activity.matchedIds ?? []}
          onFlip={(cardId) => void flipMemoryCard(cardId)}
          visibleIds={visibleIds}
        />
        <p className="memory-match-score">
          {activity.attempts ?? 0}回挑戦・あなたは
          {activity.matchesByName?.[profile.name] ?? 0}組発見
        </p>
        {error && <p className="group-play-error">{error}</p>}
        {isAdmin && (
          <div className="group-play-admin">
            <button onClick={() => void activityAction("skip")}>
              今の人をスキップ
            </button>
            <button onClick={() => void activityAction("finish")}>
              神経衰弱を終了
            </button>
          </div>
        )}
      </div>
    )
  }

  if (activity.kind === "proverb-puzzle") {
    const questionIndex = activity.questionIndex ?? 0
    const question = activity.questions?.[questionIndex]
    const wordBoard = activity.wordBoard ?? question?.pieces ?? []
    const showingMeaning =
      Boolean(activity.nextQuestionAt) ||
      isProverbComplete(wordBoard, question)
    const canAdvanceQuestion =
      activity.participants.includes(profile.name) || isAdmin
    return (
      <div className="group-play-active proverb-puzzle-screen">
        <button className="group-play-back" onClick={onBack}>
          脳活タイムへ戻る
        </button>
        <div className="group-play-heading">
          <span>ことわざ並べ替え</span>
          <strong>第{questionIndex + 1}問 / 10問</strong>
        </div>
        <div className={`group-play-turn ${myTurn ? "is-my-turn" : ""}`}>
          <small>{myTurn ? "あなたの番です" : "次の人"}</small>
          <strong>{currentName}さん</strong>
        </div>
        <div className={`proverb-puzzle-progress ${showingMeaning ? "is-complete" : ""}`}>
          <strong>
            {showingMeaning
              ? `正解　${question?.pieces.join("") ?? ""}`
              : myTurn
              ? selectedProverbIndex === null
                ? "動かしたい語句を選びましょう"
                : "入れ替える語句を選びましょう"
              : `${currentName}さんの操作を待っています`}
          </strong>
          <span>
            {showingMeaning
              ? question?.hint ?? ""
              : "語句を正しい順番に並べましょう"}
          </span>
        </div>
        <ProverbPuzzleBoard
          board={wordBoard}
          disabled={!myTurn || isBusy || showingMeaning}
          onSelect={selectProverbPiece}
          selectedIndex={selectedProverbIndex}
        />
        <p className="proverb-puzzle-score">
          ここまで {activity.solvedCount ?? 0}問正解・
          {activity.moves ?? 0}回入れ替え
        </p>
        {showingMeaning &&
          (canAdvanceQuestion ? (
            <button
              className="group-play-start"
              disabled={isBusy}
              onClick={() => void advanceProverbQuestion()}
            >
              {questionIndex + 1 >= (activity.questions?.length ?? 10)
                ? "結果を見る"
                : "次の問題"}
            </button>
          ) : (
            <p className="group-play-waiting">
              {currentName}さんが次の問題へ進むのをお待ちください。
            </p>
          ))}
        {selectedProverbIndex !== null && myTurn && !showingMeaning && (
          <button
            className="nine-puzzle-cancel"
            onClick={() => setSelectedProverbIndex(null)}
          >
            選び直す
          </button>
        )}
        {error && <p className="group-play-error">{error}</p>}
        {isAdmin && (
          <div className="group-play-admin">
            <button onClick={() => void activityAction("skip")}>
              今の人をスキップ
            </button>
            <button onClick={() => void activityAction("finish")}>
              並べ替えを終了
            </button>
          </div>
        )}
      </div>
    )
  }

  if (activity.kind === "nine-puzzle") {
    const puzzleBoard = activity.board ?? [1, 2, 3, 4, 5, 6, 7, 8, 9]
    return (
      <div className="group-play-active nine-puzzle-screen">
        <button className="group-play-back" onClick={onBack}>
          脳活タイムへ戻る
        </button>
        <div className="group-play-heading">
          <span>みんなで9マス</span>
          <strong>{activity.moves ?? 0}回 入れ替え</strong>
        </div>
        <div className={`group-play-turn ${myTurn ? "is-my-turn" : ""}`}>
          <small>{myTurn ? "あなたの番です" : "次の人"}</small>
          <strong>{currentName}さん</strong>
        </div>
        <div className="nine-puzzle-status">
          <strong>
            {myTurn
              ? selectedPuzzleIndex === null
                ? "動かしたい数字を選びましょう"
                : "入れ替える相手を選びましょう"
              : `${currentName}さんの操作を待っています`}
          </strong>
          <span>1から9まで順番に並べると完成です</span>
        </div>
        <NinePuzzleGrid
          board={puzzleBoard}
          disabled={!myTurn || isBusy}
          onSelect={selectPuzzleTile}
          selectedIndex={selectedPuzzleIndex}
        />
        {selectedPuzzleIndex !== null && myTurn && (
          <button
            className="nine-puzzle-cancel"
            onClick={() => setSelectedPuzzleIndex(null)}
          >
            選び直す
          </button>
        )}
        {error && <p className="group-play-error">{error}</p>}
        {isAdmin && (
          <div className="group-play-admin">
            <button onClick={() => void activityAction("skip")}>
              今の人をスキップ
            </button>
            <button onClick={() => void activityAction("finish")}>
              パズルを終了
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="group-play-active">
      <button className="group-play-back" onClick={onBack}>
        脳活タイムへ戻る
      </button>
      <div className="group-play-heading">
        <span>{gameNames[activity.kind]}</span>
        <strong>{activity.entries.length}回つながりました</strong>
      </div>
      <div className={`group-play-turn ${myTurn ? "is-my-turn" : ""}`}>
        <small>{myTurn ? "あなたの番です" : "次の人"}</small>
        <strong>{currentName}さん</strong>
      </div>
      <div className="group-play-instruction">
        {activity.kind === "shiritori" ? (
          <>
            <span>前の言葉</span>
            <strong>{previousWord || "好きな言葉から始めましょう"}</strong>
          </>
        ) : (
          <>
            <span>
              {activity.kind === "association" ? "前の言葉" : "今日のお題"}
            </span>
            <strong>{activity.prompt}</strong>
          </>
        )}
      </div>
      {myTurn ? (
        <div className="group-play-answer">
          <label htmlFor="group-play-answer">あなたの答え</label>
          <input
            autoComplete="off"
            enterKeyHint="send"
            id="group-play-answer"
            maxLength={40}
            onChange={(event) => {
              setAnswer(event.target.value)
              setError("")
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                answer.trim() &&
                !isBusy
              ) {
                event.preventDefault()
                void activityAction("answer", answer)
              }
            }}
            placeholder="ここに入力"
            value={answer}
          />
          <p className="group-play-answer-note">
            {activity.kind === "shiritori"
              ? "回答例にない言葉も、しりとりとしてつながれば使えます。"
              : activity.kind === "association"
                ? "前の言葉から思い浮かぶ、まだ出ていない言葉を答えましょう。"
                : "回答例にない思い出も自由に答えられます。"}
          </p>
          <button
            aria-expanded={showHints}
            className="group-play-hint-toggle"
            onClick={() => setShowHints((current) => !current)}
            type="button"
          >
            {showHints ? "ヒントを閉じる" : "ヒントを見る"}
          </button>
          {showHints && (
            <div className="group-play-hint-panel">
              <span>回答例</span>
              {suggestions.length > 0 ? (
                <div className="group-play-hints">
                  {suggestions.map((suggestion) => (
                    <button
                      aria-pressed={answer === suggestion}
                      className={answer === suggestion ? "is-selected" : ""}
                      key={suggestion}
                      onClick={() => {
                        setAnswer(suggestion)
                        setError("")
                      }}
                      type="button"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="group-play-hint-note">
                  {activity.kind === "shiritori"
                    ? `「${requiredShiritoriCharacter}」から始まる言葉を考えてみましょう。`
                    : activity.kind === "association"
                      ? `「${activity.prompt}」の色・形・仲間・使う場所を考えてみましょう。`
                      : `「${activity.prompt}」について、いつ・どこで・誰と過ごしたか思い出してみましょう。`}
                </p>
              )}
            </div>
          )}
          <button
            className="group-play-submit"
            disabled={!answer.trim() || isBusy}
            onClick={() => void activityAction("answer", answer)}
          >
            答えて次の人へ
          </button>
        </div>
      ) : (
        <p className="group-play-waiting">
          {currentName}さんの答えを待っています。
        </p>
      )}
      {error && <p className="group-play-error">{error}</p>}
      <div className="group-play-history">
        <h4>みんなの答え</h4>
        {[...activity.entries]
          .reverse()
          .slice(0, 8)
          .map((entry, index) => (
            <div key={`${entry.createdAt}-${index}`}>
              <strong>{entry.name}</strong>
              <span>{entry.text}</span>
            </div>
          ))}
      </div>
      {isAdmin && (
        <div className="group-play-admin">
          <button onClick={() => void activityAction("skip")}>
            今の人をスキップ
          </button>
          <button onClick={() => void activityAction("finish")}>
            遊びを終了
          </button>
        </div>
      )}
    </div>
  )
}

function BrainPanel({
  activeGroupId,
  isAdmin,
  members,
  onClose,
  onTrack,
  profile,
  token,
}: {
  activeGroupId: string
  isAdmin: boolean
  members: Member[]
  onClose: () => void
  onTrack: (event: string) => void
  profile: Profile
  token: string
}) {
  const [mode, setMode] = useState<"group" | "practice">("group")
  const [difficulty, setDifficulty] = useState<BrainDifficulty>("normal")
  const [summary, setSummary] = useState<BrainSummary | null>(null)
  const [answers, setAnswers] = useState<number[]>([])
  const [questionIndex, setQuestionIndex] = useState(0)
  const [isBusy, setIsBusy] = useState(true)
  const [busyKind, setBusyKind] = useState<
    "loading" | "generating" | "submitting"
  >("loading")
  const [busyStep, setBusyStep] = useState(0)
  const [error, setError] = useState("")
  const [useLocalBrain, setUseLocalBrain] = useState(false)
  const [showActivities, setShowActivities] = useState(false)

  const emptySummary = (): BrainSummary => ({
    round: null,
    result: null,
    leaderboard: [],
    todayBest: [],
    myTodayBest: 0,
    myTodayPlays: 0,
  })

  const activateLocalBrainHome = () => {
    setUseLocalBrain(true)
    setSummary(emptySummary())
    setAnswers([])
    setQuestionIndex(0)
    setError("")
  }

  const beginLocalRound = (nextMode: "group" | "practice") => {
    const questions = createLocalBrainQuestions(difficulty, activeGroupId)
    setUseLocalBrain(true)
    setSummary((current) => ({
      round: {
        id: `local-${crypto.randomUUID()}`,
        schemaVersion: 3,
        mode: nextMode,
        difficulty,
        createdAt: new Date().toISOString(),
        createdBy: profile.name,
        answered: false,
        questions,
      },
      result: null,
      leaderboard: [],
      todayBest: current?.todayBest ?? [],
      myTodayBest: current?.myTodayBest ?? 0,
      myTodayPlays: current?.myTodayPlays ?? 0,
    }))
    setAnswers([])
    setQuestionIndex(0)
    onTrack("brain_started")
  }

  const load = async (nextMode = mode) => {
    setIsBusy(true)
    setBusyKind("loading")
    setBusyStep(0)
    setError("")
    try {
      const response = await fetch(`${apiRoot}/brain/rounds?mode=${nextMode}`, {
        headers: apiHeaders(token, activeGroupId),
        cache: "no-store",
      })
      if (response.status === 404) {
        activateLocalBrainHome()
        return
      }
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error ?? "脳活タイムを読み込めませんでした。")
      }
      const loadedRound = result.round as BrainRound | null
      const hasValidQuestions = hasValidBrainQuestions(loadedRound)
      const needsAdvancedQuestion =
        loadedRound &&
        (loadedRound.difficulty === "normal" ||
          loadedRound.difficulty === "challenge")
      const hasAdvancedQuestion = loadedRound?.questions.some(
        (question) =>
          question.category === "歴史" ||
          question.category === "間違い探し",
      )
      setSummary(
        (loadedRound && !hasValidQuestions) ||
          (needsAdvancedQuestion && !hasAdvancedQuestion)
          ? { ...result, round: null, result: null, leaderboard: [] }
          : result,
      )
      setAnswers([])
      setQuestionIndex(0)
    } catch {
      activateLocalBrainHome()
    } finally {
      setIsBusy(false)
    }
  }

  useEffect(() => {
    void load("group")
  }, [])

  useEffect(() => {
    if (!isBusy || busyKind !== "generating") return
    const interval = window.setInterval(
      () => setBusyStep((current) => Math.min(current + 1, 2)),
      2500,
    )
    return () => window.clearInterval(interval)
  }, [busyKind, isBusy])

  const changeMode = (nextMode: "group" | "practice") => {
    setMode(nextMode)
    void load(nextMode)
  }

  const startRound = async (nextMode: "group" | "practice") => {
    setMode(nextMode)
    setIsBusy(true)
    setBusyKind("generating")
    setBusyStep(0)
    setError("")
    if (useLocalBrain) {
      beginLocalRound(nextMode)
      setIsBusy(false)
      return
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 7000)
    try {
      const response = await fetch(`${apiRoot}/brain/rounds`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({ mode: nextMode, difficulty }),
        signal: controller.signal,
      })
      if (response.status === 404) {
        beginLocalRound(nextMode)
        return
      }
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error ?? "問題を用意できませんでした。")
      }
      const hasAdvancedQuestion = result.round?.questions?.some(
        (question: BrainQuestion) =>
          question.category === "歴史" ||
          question.category === "間違い探し",
      )
      if (
        !hasValidBrainQuestions(result.round ?? null) ||
        (difficulty !== "easy" && !hasAdvancedQuestion)
      ) {
        beginLocalRound(nextMode)
        return
      }
      setSummary({
        round: result.round,
        result: null,
        leaderboard: [],
        todayBest: summary?.todayBest ?? [],
        myTodayBest: summary?.myTodayBest ?? 0,
        myTodayPlays: summary?.myTodayPlays ?? 0,
      })
      setAnswers([])
      setQuestionIndex(0)
      onTrack("brain_started")
    } catch {
      beginLocalRound(nextMode)
    } finally {
      window.clearTimeout(timeout)
      setIsBusy(false)
    }
  }

  const selectAnswer = (choiceIndex: number) => {
    setAnswers((current) => {
      const next = [...current]
      next[questionIndex] = choiceIndex
      return next
    })
  }

  const submitAnswers = async () => {
    if (!summary?.round || answers.length !== 5) return
    setIsBusy(true)
    setBusyKind("submitting")
    setBusyStep(0)
    setError("")
    if (useLocalBrain || summary.round.id.startsWith("local-")) {
      const questions = summary.round
        .questions as Required<BrainQuestion>[]
      const score = questions.reduce(
        (total, question, index) =>
          total + (question.correctIndex === answers[index] ? 1 : 0),
        0,
      )
      const localResult: BrainResult = { score, answers, questions }
      setSummary((current) =>
        current?.round
          ? {
              ...current,
              round: { ...current.round, answered: true },
              result: localResult,
              leaderboard:
                mode === "group"
                  ? [{ rank: 1, name: profile.name, score }]
                  : [],
              todayBest:
                mode === "group"
                  ? [{ name: profile.name, score }]
                  : current.todayBest,
              myTodayBest:
                mode === "group"
                  ? Math.max(current.myTodayBest, score)
                  : current.myTodayBest,
              myTodayPlays:
                mode === "group"
                  ? current.myTodayPlays + 1
                  : current.myTodayPlays,
            }
          : current,
      )
      onTrack("brain_completed")
      setIsBusy(false)
      return
    }
    try {
      const response = await fetch(
        `${apiRoot}/brain/rounds/${summary.round.id}/submit`,
        {
          method: "POST",
          headers: apiHeaders(token, activeGroupId),
          body: JSON.stringify({ answers }),
        },
      )
      if (response.status === 404) {
        setUseLocalBrain(true)
        throw new Error("この回を読み込めませんでした。新しい5問を始めてください。")
      }
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error ?? "答えを送信できませんでした。")
      }
      setSummary((current) =>
        current
          ? {
              ...current,
              result: result.result,
              leaderboard: result.leaderboard,
              round: current.round
                ? { ...current.round, answered: true }
                : null,
              myTodayBest:
                mode === "group"
                  ? Math.max(current.myTodayBest, result.result.score)
                  : current.myTodayBest,
              myTodayPlays:
                mode === "group"
                  ? current.myTodayPlays + 1
                  : current.myTodayPlays,
            }
          : current,
      )
      onTrack("brain_completed")
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "答えを送信できませんでした。",
      )
    } finally {
      setIsBusy(false)
    }
  }

  const round = summary?.round
  const question = round?.questions[questionIndex]
  const result = summary?.result
  const showQuestion = round && !round.answered && !result
  const topScore = summary?.todayBest[0]?.score ?? 0

  if (showActivities) {
    return (
      <div className="brain-backdrop">
        <section
          aria-labelledby="group-play-title"
          aria-modal="true"
          className="brain-panel"
          role="dialog"
        >
          <header className="brain-panel__header">
            <div className="brain-title-mark">
              <BrainIcon />
            </div>
            <div>
              <p>順番に答えて楽しむ</p>
              <h2 id="group-play-title">みんなの遊び</h2>
            </div>
            <button
              aria-label="みんなの遊びを閉じる"
              className="dialog-close"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </header>
          <div className="brain-panel__body">
            <GroupActivities
              activeGroupId={activeGroupId}
              isAdmin={isAdmin}
              members={members}
              onBack={() => setShowActivities(false)}
              profile={profile}
              token={token}
            />
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="brain-backdrop">
      <section
        aria-labelledby="brain-title"
        aria-modal="true"
        className="brain-panel"
        role="dialog"
      >
        <header className="brain-panel__header">
          <div className="brain-title-mark">
            <BrainIcon />
          </div>
          <div>
            <p>1回5問・3回で楽しめます</p>
            <h2 id="brain-title">脳活タイム</h2>
          </div>
          <button
            aria-label="脳活タイムを閉じる"
            className="dialog-close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="brain-panel__body">
          <button
            className="group-play-launch"
            onClick={() => setShowActivities(true)}
          >
            <strong>みんなの遊び</strong>
            <span>しりとり・9マス・ことわざ・神経衰弱など</span>
          </button>

          <section className="brain-quiz-mode-card">
            <div>
              <strong>5問クイズ</strong>
              <span>参加方法を選んで問題に挑戦します</span>
            </div>
            <nav aria-label="5問クイズの参加方法" className="brain-mode-tabs">
              <button
                className={mode === "group" ? "is-active" : ""}
                onClick={() => changeMode("group")}
              >
                <strong>みんなで</strong>
                <small>同じ問題に参加</small>
              </button>
              <button
                className={mode === "practice" ? "is-active" : ""}
                onClick={() => changeMode("practice")}
              >
                <strong>ひとり練習</strong>
                <small>自分のペースで回答</small>
              </button>
            </nav>
          </section>

          {isBusy && (
            <div className="brain-loading" role="status">
              <span />
              <div>
                <strong>
                  {busyKind === "generating"
                    ? [
                        "AIが5問を考えています",
                        "問題の重なりを確認しています",
                        "もう少しで準備できます",
                      ][busyStep]
                    : busyKind === "submitting"
                      ? "答えを採点しています"
                      : "脳活タイムを読み込んでいます"}
                </strong>
                <small>
                  {busyKind === "generating"
                    ? `${
                        {
                          easy: "やさしい",
                          normal: "ふつう",
                          challenge: "チャレンジ",
                        }[difficulty]
                      }問題・通常は7秒ほどで始まります`
                    : "そのままお待ちください"}
                </small>
              </div>
            </div>
          )}

          {!isBusy && error && (
            <div className="brain-error" role="alert">
              <p>{error}</p>
              <button onClick={() => void load()}>もう一度試す</button>
            </div>
          )}

          {!isBusy && !error && !showQuestion && (
            <div className="brain-difficulty">
              <strong>難しさを選ぶ</strong>
              <div role="group" aria-label="問題の難しさ">
                {(
                  [
                    ["easy", "やさしい", "ゆっくり考える"],
                    ["normal", "ふつう", "少し考えごたえ"],
                    ["challenge", "チャレンジ", "歴史も含む難問"],
                  ] as const
                ).map(([value, label, note]) => (
                  <button
                    aria-pressed={difficulty === value}
                    className={difficulty === value ? "is-selected" : ""}
                    key={value}
                    onClick={() => setDifficulty(value)}
                  >
                    <span>{label}</span>
                    <small>{note}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!isBusy && !error && showQuestion && question && (
            <div className="brain-question">
              <div className="brain-progress">
                <span>
                  第{questionIndex + 1}問 <b>{question.category}</b>
                  <i>
                    第{((summary?.myTodayPlays ?? 0) % 3) + 1}回 / 3回・
                    {
                      {
                        easy: "やさしい",
                        normal: "ふつう",
                        challenge: "チャレンジ",
                      }[round.difficulty ?? difficulty]
                    }
                  </i>
                </span>
                <strong>{questionIndex + 1} / 5</strong>
              </div>
              <div className="brain-progress-bar">
                <span
                  className={`brain-progress-bar__fill brain-progress-bar__fill--${questionIndex + 1}`}
                />
              </div>
              <h3>{question.prompt}</h3>
              <div
                className="brain-choices"
                key={`${round.id}-${question.id}-${questionIndex}`}
              >
                {question.choices.slice(0, 3).map((choice, choiceIndex) => (
                  <button
                    className={
                      answers[questionIndex] === choiceIndex
                        ? "is-selected"
                        : ""
                    }
                    key={`${question.id}-${choiceIndex}`}
                    onClick={() => selectAnswer(choiceIndex)}
                  >
                    <span>{["A", "B", "C"][choiceIndex]}</span>
                    {choice}
                  </button>
                ))}
              </div>
              <button
                className="brain-next-button"
                disabled={answers[questionIndex] === undefined}
                onClick={() => {
                  if (questionIndex < 4) {
                    setQuestionIndex((current) => current + 1)
                  } else {
                    void submitAnswers()
                  }
                }}
              >
                {questionIndex < 4 ? "次の問題へ" : "結果を見る"}
              </button>
              {questionIndex > 0 && (
                <button
                  className="brain-back-button"
                  onClick={() => setQuestionIndex((current) => current - 1)}
                >
                  前の問題に戻る
                </button>
              )}
            </div>
          )}

          {!isBusy && !error && result && (
            <div className="brain-result">
              <p className="brain-result__eyebrow">
                {mode === "practice" ? "練習の結果" : "今回の結果"}
              </p>
              <div className="brain-score">
                <strong>{result.score}</strong>
                <span>問正解 / 5問</span>
              </div>
              <p className="brain-cheer">
                {result.score === 5
                  ? "全問正解です。すばらしい集中力でした。"
                  : result.score >= 3
                    ? "あと一歩です。楽しく取り組めました。"
                    : "参加することが大切です。おつかれさまでした。"}
              </p>

              <div className="brain-review">
                <h3>答え合わせ</h3>
                {result.questions.map((item, index) => {
                  const correct = result.answers[index] === item.correctIndex
                  return (
                    <article key={item.id}>
                      <span className={correct ? "is-correct" : "is-missed"}>
                        {correct ? "正解" : "おしい"}
                      </span>
                      <div>
                        <strong>
                          {index + 1}. {item.choices[item.correctIndex]}
                        </strong>
                        <p>{item.explanation}</p>
                      </div>
                    </article>
                  )
                })}
              </div>

              {mode === "group" && summary && (
                <>
                  <div className="brain-stats">
                    <div>
                      <span>今日の自己ベスト</span>
                      <strong>{summary.myTodayBest} / 5</strong>
                    </div>
                    <div>
                      <span>今日の参加</span>
                      <strong>{summary.myTodayPlays}回</strong>
                    </div>
                  </div>
                  {summary.myTodayPlays > 0 &&
                    summary.myTodayPlays % 3 === 0 && (
                      <p className="brain-break-note">
                        3回楽しみました。お茶を飲んで、ひと休みしませんか。
                      </p>
                    )}
                </>
              )}

              <div className="brain-replay-actions">
                {mode === "practice" ? (
                  <button onClick={() => void startRound("practice")}>
                    もう一度練習する
                  </button>
                ) : isAdmin ? (
                  <button onClick={() => void startRound("group")}>
                    新しい5問を始める
                  </button>
                ) : (
                  <p>次の回は管理者が始められます。</p>
                )}
                <button
                  onClick={() =>
                    changeMode(mode === "practice" ? "group" : "practice")
                  }
                >
                  {mode === "practice" ? "みんなの問題を見る" : "ひとりで練習"}
                </button>
              </div>
            </div>
          )}

          {!isBusy && !error && !showQuestion && !result && (
            <div className="brain-home">
              <p className="brain-home__lead">
                正解を競うだけでなく、みんなで気軽に楽しむ時間です。
              </p>
              <div className="brain-daily-card">
                <span>今日のグループ最高点</span>
                <strong>
                  {topScore ? `${topScore} / 5` : "まだありません"}
                </strong>
              </div>
              {mode === "group" && round?.answered && (
                <p className="brain-waiting">この回は回答済みです。</p>
              )}
              <div className="brain-start-actions">
                {mode === "group" && isAdmin && (
                  <button
                    className="brain-start-card brain-start-card--group"
                    onClick={() => void startRound("group")}
                  >
                    <span className="brain-start-card__icon">
                      <PeopleIcon />
                    </span>
                    <span>
                      <strong>みんなの5問を始める</strong>
                      <small>このグループで順位を楽しみます</small>
                    </span>
                  </button>
                )}
                {mode === "group" && !isAdmin && !round && (
                  <p className="brain-waiting">
                    みんなの5問は管理者が始めると参加できます。
                  </p>
                )}
                <button
                  className="brain-start-card"
                  onClick={() => void startRound("practice")}
                >
                  <span className="brain-start-card__icon">
                    <BrainIcon />
                  </span>
                  <span>
                    <strong>ひとりで練習する</strong>
                    <small>練習の点数は順位に入りません</small>
                  </span>
                </button>
              </div>
              <p className="brain-safety-note">
                無理のない範囲でお楽しみください。結果は健康状態を判定するものではありません。
              </p>
            </div>
          )}

          {!isBusy &&
            !error &&
            mode === "group" &&
            summary &&
            (summary.leaderboard.length > 0 ||
              summary.todayBest.length > 0) && (
              <aside className="brain-ranking">
                {summary.leaderboard.length > 0 && (
                  <>
                    <h3>今回の順位</h3>
                    <ol>
                      {summary.leaderboard.map((entry) => (
                        <li key={entry.name}>
                          <span>{entry.rank}</span>
                          <strong>
                            {entry.name}
                            {entry.name === profile.name ? "（あなた）" : ""}
                          </strong>
                          <b>{entry.score} / 5</b>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                {summary.todayBest.length > 0 && (
                  <>
                    <h3>今日のベスト</h3>
                    <ol>
                      {summary.todayBest.slice(0, 5).map((entry, index) => (
                        <li key={entry.name}>
                          <span>{index + 1}</span>
                          <strong>{entry.name}</strong>
                          <b>{entry.score} / 5</b>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </aside>
            )}
        </div>
      </section>
    </div>
  )
}

function JoinScreen({
  onJoined,
}: {
  onJoined: (token: string, profile: Profile, activeGroupId: string) => void;
}) {
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [profileImage, setProfileImage] = useState<{
    file: File;
    previewUrl: string;
  } | null>(null);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setIsJoining(true);

    try {
      const response = await fetch(`${apiRoot}/join`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ name, inviteCode }),
      });
      const responseText = await response.text();
      let result: {
        error?: string;
        token?: string;
        user?: Profile;
        activeGroupId?: string;
      } = {};
      try {
        result = responseText ? JSON.parse(responseText) : {};
      } catch {
        if (
          response.status === 520 ||
          /origin is disallowed/i.test(responseText)
        ) {
          throw new Error(
            "参加サーバーの公開設定を更新する必要があります。Makeの設定からSupabase Edge Functionを再デプロイして、もう一度お試しください。",
          );
        }
        throw new Error(
          "参加サーバーから正しい応答を受け取れませんでした。Supabase Edge Functionを再デプロイしてください。",
        );
      }
      if (!response.ok) throw new Error(result.error ?? "参加できませんでした。");
      if (!result.token || !result.user || !result.activeGroupId) {
        throw new Error("参加情報を確認できませんでした。もう一度お試しください。");
      }
      let user = result.user;
      if (profileImage) {
        const prepared = await compressImage(profileImage.file);
        if (prepared.size > 2 * 1024 * 1024) {
          throw new Error("参加者画像は2MB以下にしてください。");
        }
        const formData = new FormData();
        formData.append("file", prepared, prepared.name);
        const uploadResponse = await fetch(`${apiRoot}/profile/image`, {
          method: "POST",
          headers: mediaHeaders(result.token, result.activeGroupId),
          body: formData,
        });
        const uploadText = await uploadResponse.text();
        let uploadResult: { error?: string; imageUrl?: string } = {};
        try {
          uploadResult = uploadText ? JSON.parse(uploadText) : {};
        } catch {
          // A readable error is shown below for non-JSON gateway responses.
        }
        if (!uploadResponse.ok || !uploadResult.imageUrl) {
          if (uploadResponse.status === 404) {
            throw new Error(
              "参加者画像APIがサーバーに反映されていません。Makeの設定からSupabase Edge Functionを再デプロイしてください。",
            );
          }
          throw new Error(
            uploadResult.error ??
              `参加者画像を登録できませんでした（エラー ${uploadResponse.status}）。`,
          );
        }
        user = { ...user, imageUrl: uploadResult.imageUrl };
      }
      onJoined(result.token, user, result.activeGroupId);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "通信を確認して、もう一度お試しください。",
      );
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <main className="join-screen">
      <section className="join-card" aria-labelledby="join-title">
        <div className="join-icon">
          <img alt="" height="25" src="/assets/9cbab.svg" width="25" />
        </div>
        <p className="join-eyebrow">招待された方専用</p>
        <h1 id="join-title">{appName}</h1>
        <p className="join-description">
          お名前と招待コードを入力して、会話に参加してください。
        </p>
        <form onSubmit={join}>
          <label htmlFor="display-name">お名前</label>
          <input
            autoComplete="name"
            id="display-name"
            maxLength={12}
            onChange={(event) => setName(event.target.value)}
            placeholder="例：ゆき"
            required
            value={name}
          />
          <label htmlFor="invite-code">招待コード</label>
          <input
            autoCapitalize="none"
            autoComplete="off"
            id="invite-code"
            onChange={(event) => setInviteCode(event.target.value)}
            placeholder="招待コードを入力"
            required
            type="password"
            value={inviteCode}
          />
          <label htmlFor="profile-image">参加者画像（任意・1枚）</label>
          <input
            accept="image/jpeg,image/png,image/webp"
            className="profile-image-input"
            id="profile-image"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (profileImage) URL.revokeObjectURL(profileImage.previewUrl);
              setProfileImage({
                file,
                previewUrl: URL.createObjectURL(file),
              });
            }}
            type="file"
          />
          {profileImage && (
            <div className="profile-image-preview">
              <img alt="登録する参加者画像" src={profileImage.previewUrl} />
              <button
                onClick={() => {
                  URL.revokeObjectURL(profileImage.previewUrl);
                  setProfileImage(null);
                }}
                type="button"
              >
                画像を外す
              </button>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="join-button"
            disabled={isJoining || !name.trim() || !inviteCode.trim()}
            type="submit"
          >
            {isJoining ? "確認しています…" : "会話に参加する"}
          </button>
        </form>
        <p className="join-note">
          この端末には表示名と参加情報だけが保存されます。使いやすさの改善のため、
          会話内容やお名前を含まない操作回数を記録します。
        </p>
      </section>
    </main>
  );
}

export default function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem(sessionStorageKey) ?? "",
  );
  const [profile, setProfile] = useState<Profile | null>(loadStoredProfile);
  const [activeGroupId, setActiveGroupId] = useState(
    () => localStorage.getItem(activeGroupStorageKey) ?? "weekend-meal",
  );
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [showGroups, setShowGroups] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupImage, setNewGroupImage] = useState<{
    file: File;
    previewUrl: string;
  } | null>(null);
  const [joinGroupCode, setJoinGroupCode] = useState("");
  const [groupSwitcherError, setGroupSwitcherError] = useState("");
  const [isChangingGroups, setIsChangingGroups] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{
    file: File;
    previewUrl: string;
    kind: "image" | "video";
  } | null>(null);
  const [isSendingMedia, setIsSendingMedia] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(Boolean(token));
  const [isPositioningMessages, setIsPositioningMessages] = useState(
    Boolean(token),
  );
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [isWriting, setIsWriting] = useState(false);
  const [isReplyPanelOpen, setIsReplyPanelOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingMessage, setPendingMessage] = useState("");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showLeaveConfirmation, setShowLeaveConfirmation] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sentNotice, setSentNotice] = useState(false);
  const [suggestions, setSuggestions] =
    useState<string[]>(fallbackSuggestions);
  const [suggestionError, setSuggestionError] = useState("");
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteCode, setInviteCode] = useState("");
  const [groupName, setGroupName] = useState(appName);
  const [groupNameDraft, setGroupNameDraft] = useState(appName);
  const [groupImageUrl, setGroupImageUrl] = useState("");
  const [showGroup, setShowGroup] = useState(false);
  const [showBrain, setShowBrain] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [showDirectCall, setShowDirectCall] = useState(false);
  const [dmListening, setDmListening] = useState(true);
  const [isRotatingCode, setIsRotatingCode] = useState(false);
  const [isSavingGroupName, setIsSavingGroupName] = useState(false);
  const [isSavingProfileImage, setIsSavingProfileImage] = useState(false);
  const [isSavingGroupImage, setIsSavingGroupImage] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [canDeleteGroup, setCanDeleteGroup] = useState(false);
  const [showDeleteGroup, setShowDeleteGroup] = useState(false);
  const [isDeletingGroup, setIsDeletingGroup] = useState(false);
  const [memberActionName, setMemberActionName] = useState("");
  const [groupError, setGroupError] = useState("");
  const [unreadIds, setUnreadIds] = useState<string[]>([]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () =>
      localStorage.getItem(notificationStorageKey) === "enabled" &&
      "Notification" in window &&
      Notification.permission === "granted",
  );
  const [isNotificationBusy, setIsNotificationBusy] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [showNotificationSettings, setShowNotificationSettings] =
    useState(false);
  const [notificationPreview, setNotificationPreview] = useState(
    () => localStorage.getItem(notificationPreviewStorageKey) !== "hidden",
  );
  const [notifySystemMessages, setNotifySystemMessages] = useState(
    () => localStorage.getItem(notificationSystemStorageKey) !== "disabled",
  );
  const [quietHours, setQuietHours] = useState(
    () => localStorage.getItem(quietHoursStorageKey) === "enabled",
  );
  const [appBadgeEnabled, setAppBadgeEnabled] = useState(
    () => localStorage.getItem(appBadgeStorageKey) !== "disabled",
  );
  const [canInstall, setCanInstall] = useState(false);
  const [showInstallInstructions, setShowInstallInstructions] = useState(false);
  const [showRetentionNotice, setShowRetentionNotice] = useState(false);
  const [isInstalled, setIsInstalled] = useState(
    () => window.matchMedia("(display-mode: standalone)").matches,
  );
  const [analyticsEnabled, setAnalyticsEnabled] = useState(
    () => localStorage.getItem(analyticsStorageKey) !== "disabled",
  );
  const [analyticsSummary, setAnalyticsSummary] = useState<
    Record<string, number>
  >({});
  const [textSize, setTextSizeState] = useState<"small" | "normal" | "large">(
    () => {
      const stored = localStorage.getItem(textSizeStorageKey);
      return stored === "small" || stored === "large" ? stored : "normal";
    },
  );
  const [themeColor, setThemeColor] = useState<ThemeColor>(() => {
    const stored = localStorage.getItem(themeStorageKey);
    return stored === "pink" || stored === "blue" || stored === "black"
      ? stored
      : "green";
  });
  const [pendingSend, setPendingSend] = useState<ChatMessage | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const installPromptRef = useRef<InstallPromptEvent | null>(null);
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const hasLoadedMessagesRef = useRef(false);
  const notificationsEnabledRef = useRef(notificationsEnabled);
  const notificationPreviewRef = useRef(notificationPreview);
  const notifySystemMessagesRef = useRef(notifySystemMessages);
  const quietHoursRef = useRef(quietHours);
  const groupNameRef = useRef(groupName);
  const profileRef = useRef(profile);
  const groupUnreadRef = useRef<Record<string, number>>({});
  const unreadIdsRef = useRef<string[]>([]);
  const oldestMessageIdRef = useRef("");
  const isLoadingOlderRef = useRef(false);

  notificationsEnabledRef.current = notificationsEnabled;
  notificationPreviewRef.current = notificationPreview;
  notifySystemMessagesRef.current = notifySystemMessages;
  quietHoursRef.current = quietHours;
  groupNameRef.current = groupName;
  profileRef.current = profile;
  const totalGroupUnread = groups.reduce(
    (total, group) => total + (group.unreadCount ?? 0),
    0,
  );

  const leaveSession = () => {
    localStorage.removeItem(sessionStorageKey);
    localStorage.removeItem(profileStorageKey);
    localStorage.removeItem(activeGroupStorageKey);
    setToken("");
    setProfile(null);
    setMessages([]);
  };

  const loadMessages = async (quiet = false) => {
    if (!token) return;
    if (!quiet) {
      setIsLoading(true);
      setIsPositioningMessages(true);
    }

    try {
      const response = await fetch(`${apiRoot}/messages?limit=30`, {
        headers: apiHeaders(token, activeGroupId),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        leaveSession();
        return;
      }
      if (response.status === 404) {
        throw new Error(
          "会話サーバーが更新されていません。Supabase Edge Functionを再デプロイしてください。",
        );
      }
      if (!response.ok) throw new Error(result.error ?? "会話を読み込めません。");
      const nextMessages = result.messages as ChatMessage[];
      const incoming = nextMessages.filter(
        (message) => !knownMessageIdsRef.current.has(message.id),
      );
      if (hasLoadedMessagesRef.current && incoming.length && document.hidden) {
        const unread = incoming.filter(
          (message) => message.sender !== profileRef.current?.name,
        );
        if (unread.length) {
          setUnreadIds((current) => {
            const next = [
              ...new Set([...current, ...unread.map((message) => message.id)]),
            ];
            unreadIdsRef.current = next;
            return next;
          });
          const latest = unread.at(-1);
          if (
            latest &&
            notificationsEnabledRef.current &&
            "Notification" in window &&
            Notification.permission === "granted" &&
            (latest.kind !== "system" || notifySystemMessagesRef.current) &&
            !(
              quietHoursRef.current &&
              (new Date().getHours() >= 20 || new Date().getHours() < 8)
            )
          ) {
            void showSystemNotification(
              groupNameRef.current,
              notificationPreviewRef.current
                ? latest.kind === "system"
                  ? latest.text
                  : `${latest.sender}さん: ${latest.text}`
                : "新しいメッセージが届きました。",
              latest.id,
            );
          }
        }
      }
      const wasFirstLoad = !hasLoadedMessagesRef.current;
      hasLoadedMessagesRef.current = true;
      setMessages((current) => {
        const merged = wasFirstLoad
          ? nextMessages
          : mergeUniqueMessages(current, nextMessages);
        knownMessageIdsRef.current = new Set(
          merged.map((message) => message.id),
        );
        oldestMessageIdRef.current = merged.at(0)?.id ?? "";
        return merged;
      });
      if (wasFirstLoad) {
        setHasOlderMessages(result.hasMore === true);
      }
      setProfile(result.user);
      setLoadError("");
      if (
        !document.hidden &&
        (wasFirstLoad ||
          (incoming.length > 0 && unreadIdsRef.current.length === 0))
      ) {
        void markActiveGroupRead();
      }
    } catch (reason) {
      if (!quiet) {
        setIsPositioningMessages(false);
        const isFetchFailure =
          reason instanceof TypeError &&
          /failed to fetch|networkerror/i.test(reason.message);
        setLoadError(
          isFetchFailure
            ? "会話サーバーに接続できません。Supabase Edge Functionを再デプロイしてから、もう一度お試しください。"
            : reason instanceof Error
            ? reason.message
            : "会話を読み込めませんでした。通信状況をご確認ください。",
        );
      }
    } finally {
      if (!quiet) setIsLoading(false);
    }
  };

  const loadOlderMessages = async () => {
    const before = oldestMessageIdRef.current;
    if (
      !token ||
      !before ||
      !hasOlderMessages ||
      isLoadingOlderRef.current ||
      isLoading
    ) {
      return;
    }
    isLoadingOlderRef.current = true;
    setIsLoadingOlder(true);
    const previousHeight = document.documentElement.scrollHeight;
    try {
      const response = await fetch(
        `${apiRoot}/messages?limit=30&before=${encodeURIComponent(before)}`,
        { headers: apiHeaders(token, activeGroupId) },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error ?? "過去の会話を読み込めませんでした。");
      }
      const olderMessages = result.messages as ChatMessage[];
      setMessages((current) => {
        const merged = mergeUniqueMessages(olderMessages, current);
        knownMessageIdsRef.current = new Set(
          merged.map((message) => message.id),
        );
        oldestMessageIdRef.current = merged.at(0)?.id ?? "";
        return merged;
      });
      setHasOlderMessages(result.hasMore === true);
      window.requestAnimationFrame(() => {
        const addedHeight =
          document.documentElement.scrollHeight - previousHeight;
        window.scrollBy({ top: addedHeight, behavior: "auto" });
      });
    } catch (reason) {
      setLoadError(
        reason instanceof Error
          ? reason.message
          : "過去の会話を読み込めませんでした。",
      );
    } finally {
      isLoadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  };

  const loadGroup = async () => {
    if (!token) return;
    try {
      const response = await fetch(`${apiRoot}/group`, {
        headers: apiHeaders(token, activeGroupId),
        cache: "no-store",
      });
      const result = await response.json();
      if (response.status === 401) {
        leaveSession();
        return;
      }
      if (!response.ok) throw new Error(result.error);
      setMembers(result.members);
      setInviteCode(result.inviteCode);
      setGroupName(result.name);
      setGroupNameDraft(result.name);
      setGroupImageUrl(result.imageUrl ?? "");
      setIsAdmin(result.isAdmin === true);
      setCanDeleteGroup(
        result.isAdmin === true && result.canDelete === true,
      );
      setGroupError("");
    } catch {
      setGroupError("参加者情報を読み込めませんでした。");
    }
  };

  const loadGroups = async () => {
    if (!token) return;
    try {
      const response = await fetch(`${apiRoot}/groups`, {
        headers: apiHeaders(token, activeGroupId),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const nextGroups = (result.groups ?? []) as GroupSummary[];
      if (Object.keys(groupUnreadRef.current).length) {
        for (const group of nextGroups) {
          const previous = groupUnreadRef.current[group.id] ?? 0;
          const current = group.unreadCount ?? 0;
          if (
            group.id !== activeGroupId &&
            current > previous &&
            group.latestMessage &&
            notificationsEnabledRef.current &&
            "Notification" in window &&
            Notification.permission === "granted" &&
            (group.latestMessage.kind !== "system" ||
              notifySystemMessagesRef.current) &&
            !(
              quietHoursRef.current &&
              (new Date().getHours() >= 20 || new Date().getHours() < 8)
            )
          ) {
            void showSystemNotification(
              group.name,
              notificationPreviewRef.current
                ? group.latestMessage.hasAttachment
                  ? `${group.latestMessage.sender}さんからファイルが届きました。`
                  : `${group.latestMessage.sender}さん: ${group.latestMessage.text}`
                : "新しいメッセージが届きました。",
              `group-${group.id}`,
            );
          }
        }
      }
      groupUnreadRef.current = Object.fromEntries(
        nextGroups.map((group) => [group.id, group.unreadCount ?? 0]),
      );
      setGroups(nextGroups);
      setGroupSwitcherError("");
    } catch {
      setGroupSwitcherError("グループ一覧を読み込めませんでした。");
    }
  };

  const markActiveGroupRead = async () => {
    if (!token || !activeGroupId) return;
    setUnreadIds([]);
    unreadIdsRef.current = [];
    setGroups((current) =>
      current.map((group) =>
        group.id === activeGroupId ? { ...group, unreadCount: 0 } : group,
      ),
    );
    groupUnreadRef.current[activeGroupId] = 0;
    try {
      await fetch(`${apiRoot}/groups/read`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
      });
      setGroups((current) =>
        current.map((group) =>
          group.id === activeGroupId ? { ...group, unreadCount: 0 } : group,
        ),
      );
    } catch {
      // Read markers are retried when the group is opened again.
    }
  };

  const loadAnalyticsSummary = async () => {
    if (!token) return;
    try {
      const response = await fetch(`${apiRoot}/analytics/summary`, {
        headers: apiHeaders(token, activeGroupId),
        cache: "no-store",
      });
      const result = await response.json();
      if (response.ok) setAnalyticsSummary(result.counts ?? {});
    } catch {
      // Analytics must never block the chat experience.
    }
  };

  const trackEvent = (event: string) => {
    if (!analyticsEnabled || !token) return;
    setAnalyticsSummary((current) => ({
      ...current,
      [event]: (current[event] ?? 0) + 1,
    }));
    void fetch(`${apiRoot}/analytics/events`, {
      method: "POST",
      headers: apiHeaders(token, activeGroupId),
      body: JSON.stringify({ event }),
    }).catch(() => undefined);
  };

  const loadSuggestions = async (manual = false) => {
    if (!token) return;
    setIsLoadingSuggestions(true);
    setSuggestionError(manual ? "AIで作り直しています…" : "");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);

    try {
      const latestId = messages.at(-1)?.id ?? Date.now().toString();
      const response = await fetch(
        `${apiRoot}/suggestions?message=${encodeURIComponent(latestId)}&retry=${Date.now()}`,
        {
          headers: apiHeaders(token, activeGroupId),
          signal: controller.signal,
          cache: "no-store",
        },
      );
      const result = await response.json();
      if (response.status === 401) {
        leaveSession();
        return;
      }
      if (!response.ok) {
        throw new Error(result.error ?? "返信案を作れませんでした。");
      }
      setSuggestions(result.suggestions);
      setSuggestionError(
        result.source === "fallback"
          ? "AIが利用できないため、会話に合わせた例文を表示しています"
          : "",
      );
    } catch (reason) {
      setSuggestions((current) =>
        current.length ? current : fallbackSuggestions,
      );
      setSuggestionError("例文を表示しています");
    } finally {
      window.clearTimeout(timeout);
      setIsLoadingSuggestions(false);
    }
  };

  useEffect(() => {
    if (!token || !activeGroupId) return;
    setMessages([]);
    setIsPositioningMessages(true);
    setIsLoadingOlder(false);
    isLoadingOlderRef.current = false;
    setHasOlderMessages(false);
    setUnreadIds([]);
    unreadIdsRef.current = [];
    setSuggestions(fallbackSuggestions);
    knownMessageIdsRef.current = new Set();
    oldestMessageIdRef.current = "";
    hasLoadedMessagesRef.current = false;
    void loadMessages();
    void loadGroup();
    void loadGroups();
    void loadAnalyticsSummary();
    const interval = window.setInterval(() => void loadMessages(true), 4000);
    const groupInterval = window.setInterval(() => {
      void loadGroup();
      void loadGroups();
    }, 30000);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(groupInterval);
    };
  }, [token, activeGroupId]);

  const latestMessageId = pendingSend?.id ?? messages.at(-1)?.id;
  useLayoutEffect(() => {
    if (isLoading || !isPositioningMessages || !messageEndRef.current) return;
    messageEndRef.current.scrollIntoView({ behavior: "auto", block: "end" });
    setIsPositioningMessages(false);
  }, [isLoading, isPositioningMessages, messages.length]);

  useEffect(() => {
    const handleHistoryScroll = () => {
      if (
        window.scrollY <= 160 &&
        hasLoadedMessagesRef.current &&
        hasOlderMessages &&
        !isLoadingOlder &&
        !isLoading
      ) {
        void loadOlderMessages();
      }
    };
    window.addEventListener("scroll", handleHistoryScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleHistoryScroll);
  }, [
    activeGroupId,
    hasOlderMessages,
    isLoading,
    isLoadingOlder,
    messages.at(0)?.id,
  ]);

  useEffect(() => {
    if (latestMessageId) void loadSuggestions();
  }, [latestMessageId]);

  useEffect(() => {
    if (!latestMessageId) return;
    if (isPositioningMessages) return;
    if (document.hidden || unreadIds.length) return;
    window.requestAnimationFrame(() => {
      messageEndRef.current?.scrollIntoView({
        behavior: isLoading ? "auto" : "smooth",
        block: "end",
      });
    });
  }, [
    latestMessageId,
    isLoading,
    isPositioningMessages,
    unreadIds.length,
  ]);

  useEffect(() => {
    const pageTitle = `${groupName}｜${appName}`;
    document.title = totalGroupUnread
      ? `(${totalGroupUnread}) ${pageTitle}`
      : pageTitle;
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const badgeCount = appBadgeEnabled ? totalGroupUnread : 0;
    if (badgeCount > 0) {
      void badgeNavigator.setAppBadge?.(badgeCount)?.catch(() => undefined);
    } else {
      void badgeNavigator.clearAppBadge?.()?.catch(() => undefined);
    }
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.ready
        .then((registration) =>
          registration.active?.postMessage({
            type: "SAWAKAI_BADGE_SYNC",
            count: badgeCount,
          }),
        )
        .catch(() => undefined);
    }
  }, [appBadgeEnabled, groupName, totalGroupUnread]);

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        void loadGroups();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [token, activeGroupId]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handlePushMessage = (event: MessageEvent) => {
      if (event.data?.type !== "SAWAKAI_PUSH_RECEIVED") return;
      void loadGroups();
      void loadMessages(true);
    };
    navigator.serviceWorker.addEventListener("message", handlePushMessage);
    return () =>
      navigator.serviceWorker.removeEventListener(
        "message",
        handlePushMessage,
      );
  }, [token, activeGroupId]);

  useEffect(() => {
    if (
      !token ||
      !notificationsEnabled ||
      !("Notification" in window) ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    void registerPushSubscription().catch((reason) => {
      setNotificationMessage(
        reason instanceof Error
          ? reason.message
          : "バックグラウンド通知を準備できませんでした。",
      );
    });
  }, [token, activeGroupId]);

  useEffect(() => {
    if (isWriting) inputRef.current?.focus();
  }, [isWriting]);

  useEffect(
    () => () => {
      if (pendingTimerRef.current) {
        window.clearTimeout(pendingTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      installPromptRef.current = event as InstallPromptEvent;
      setCanInstall(true);
    };
    const early = (window as unknown as { __installPrompt?: Event })
      .__installPrompt;
    if (early) capturePrompt(early);
    const markInstalled = () => {
      installPromptRef.current = null;
      setCanInstall(false);
      setIsInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  const handleJoined = (
    nextToken: string,
    nextProfile: Profile,
    nextGroupId: string,
  ) => {
    localStorage.setItem(sessionStorageKey, nextToken);
    localStorage.setItem(profileStorageKey, JSON.stringify(nextProfile));
    localStorage.setItem(activeGroupStorageKey, nextGroupId);
    setProfile(nextProfile);
    setActiveGroupId(nextGroupId);
    setToken(nextToken);
  };

  const prepareMessage = (message: string) => {
    if (!message.trim()) return;
    setPendingMessage(message.trim());
    setShowConfirmation(true);
  };

  const selectSuggestion = (suggestion: string) => {
    trackEvent("suggestion_selected");
    prepareMessage(suggestion);
  };

  const cancelConfirmation = () => {
    trackEvent("confirmation_cancelled");
    setShowConfirmation(false);
  };

  const copyInviteCode = async () => {
    await navigator.clipboard.writeText(inviteCode);
    setSentNotice(true);
    window.setTimeout(() => setSentNotice(false), 2200);
  };

  const rotateInviteCode = async () => {
    if (
      !window.confirm(
        "招待コードを作り直しますか？ 今までのコードでは参加できなくなります。",
      )
    ) {
      return;
    }
    setIsRotatingCode(true);
    try {
      const response = await fetch(`${apiRoot}/group/invite-code`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setInviteCode(result.inviteCode);
      setGroupError("");
    } catch {
      setGroupError("招待コードを作り直せませんでした。");
    } finally {
      setIsRotatingCode(false);
    }
  };

  const saveGroupName = async () => {
    const nextName = groupNameDraft.trim();
    if (!nextName || nextName === groupName) return;
    setIsSavingGroupName(true);
    try {
      const response = await fetch(`${apiRoot}/group/name`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({ name: nextName }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setGroupName(result.name);
      setGroupNameDraft(result.name);
      if (result.message) {
        setMessages((current) => [...current, result.message]);
      }
      setGroupError("");
    } catch (reason) {
      setGroupError(
        reason instanceof Error
          ? reason.message
          : "グループ名を変更できませんでした。",
      );
    } finally {
      setIsSavingGroupName(false);
    }
  };

  const uploadImage = async (
    endpoint: "/profile/image" | "/group/image",
    file: File,
    groupId = activeGroupId,
  ) => {
    const prepared = await compressImage(file);
    if (prepared.size > 2 * 1024 * 1024) {
      throw new Error("画像は2MB以下にしてください。");
    }
    const formData = new FormData();
    formData.append("file", prepared, prepared.name);
    const response = await fetch(`${apiRoot}${endpoint}`, {
      method: "POST",
      headers: mediaHeaders(token, groupId),
      body: formData,
    });
    const result = await response.json();
    if (!response.ok || !result.imageUrl) {
      throw new Error(result.error ?? "画像を保存できませんでした。");
    }
    return result.imageUrl as string;
  };

  const changeProfileImage = async (file: File) => {
    if (!profile) return
    setIsSavingProfileImage(true);
    setGroupError("");
    try {
      const imageUrl = await uploadImage("/profile/image", file);
      const nextProfile = { ...profile, imageUrl };
      setProfile(nextProfile);
      localStorage.setItem(profileStorageKey, JSON.stringify(nextProfile));
      await loadGroup();
    } catch (reason) {
      setGroupError(
        reason instanceof Error ? reason.message : "参加者画像を変更できませんでした。",
      );
    } finally {
      setIsSavingProfileImage(false);
    }
  };

  const deleteProfileImage = async () => {
    if (!profile) return
    setIsSavingProfileImage(true);
    setGroupError("");
    try {
      const response = await fetch(`${apiRoot}/profile/image/delete`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const nextProfile = { ...profile, imageUrl: undefined };
      setProfile(nextProfile);
      localStorage.setItem(profileStorageKey, JSON.stringify(nextProfile));
      await loadGroup();
    } catch (reason) {
      setGroupError(
        reason instanceof Error ? reason.message : "参加者画像を削除できませんでした。",
      );
    } finally {
      setIsSavingProfileImage(false);
    }
  };

  const changeGroupImage = async (file: File) => {
    setIsSavingGroupImage(true);
    setGroupError("");
    try {
      const imageUrl = await uploadImage("/group/image", file);
      setGroupImageUrl(imageUrl);
      await loadGroups();
    } catch (reason) {
      setGroupError(
        reason instanceof Error ? reason.message : "茶話会画像を変更できませんでした。",
      );
    } finally {
      setIsSavingGroupImage(false);
    }
  };

  const deleteGroupImage = async () => {
    setIsSavingGroupImage(true);
    setGroupError("");
    try {
      const response = await fetch(`${apiRoot}/group/image/delete`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setGroupImageUrl("");
      await loadGroups();
    } catch (reason) {
      setGroupError(
        reason instanceof Error ? reason.message : "茶話会画像を削除できませんでした。",
      );
    } finally {
      setIsSavingGroupImage(false);
    }
  };

  const changeMemberRole = async (member: Member) => {
    setMemberActionName(member.name);
    setGroupError("");
    try {
      const response = await fetch(`${apiRoot}/group/members/role`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({
          name: member.name,
          isAdmin: !member.isAdmin,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await loadGroup();
      if (result.message) {
        setMessages((current) => [...current, result.message]);
      }
    } catch (reason) {
      setGroupError(
        reason instanceof Error ? reason.message : "権限を変更できませんでした。",
      );
    } finally {
      setMemberActionName("");
    }
  };

  const removeMember = async (member: Member) => {
    if (!window.confirm(`${member.name}さんをグループから外しますか？`)) {
      return;
    }
    setMemberActionName(member.name);
    setGroupError("");
    try {
      const response = await fetch(`${apiRoot}/group/members/remove`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({ name: member.name }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (result.removed !== true) {
        throw new Error("参加者を外せませんでした。");
      }
      setMembers((current) =>
        current.filter((item) => item.name !== member.name),
      );
      await loadGroups();
    } catch (reason) {
      setGroupError(
        reason instanceof Error
          ? reason.message
          : "参加者を外せませんでした。",
      );
    } finally {
      setMemberActionName("");
    }
  };

  const deleteGroup = async () => {
    if (!isAdmin || !canDeleteGroup) {
      setShowDeleteGroup(false);
      setGroupError("グループの削除は管理者だけが行えます。");
      return;
    }
    setIsDeletingGroup(true);
    setGroupError("");
    try {
      const response = await fetch(`${apiRoot}/group/delete`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);

      setShowDeleteGroup(false);
      setShowGroup(false);
      setMessages([]);
      setMembers([]);
      const nextGroup = result.remainingGroups?.[0] as
        | GroupSummary
        | undefined;
      if (nextGroup) {
        setGroups(result.remainingGroups);
        switchGroup(nextGroup.id);
      } else {
        localStorage.removeItem(activeGroupStorageKey);
        setActiveGroupId("");
        setGroups([]);
        setGroupName("茶話会を選択");
        setShowGroups(true);
      }
    } catch (reason) {
      setShowDeleteGroup(false);
      setGroupError(
        reason instanceof Error
          ? reason.message
          : "グループを削除できませんでした。",
      );
    } finally {
      setIsDeletingGroup(false);
    }
  };

  const registerPushSubscription = async (
    options: {
      preview?: boolean;
      quiet?: boolean;
      badge?: boolean;
    } = {},
  ) => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("この端末はバックグラウンド通知に対応していません。");
    }
    let registration = await navigator.serviceWorker.getRegistration(
      import.meta.env.BASE_URL,
    );
    if (!registration) {
      registration = await navigator.serviceWorker.register(
        `${import.meta.env.BASE_URL}sw.js`,
        { scope: import.meta.env.BASE_URL },
      );
    }
    registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) =>
        window.setTimeout(
          () =>
            reject(
              new Error(
                "通知の準備に時間がかかっています。画面を再読み込みして、もう一度お試しください。",
              ),
            ),
          8000,
        ),
      ),
    ]);
    const keyResponse = await fetch(`${apiRoot}/push/public-key`, {
      headers: apiHeaders(token, activeGroupId),
      cache: "no-store",
    });
    const keyResult = await keyResponse.json().catch(() => ({}));
    if (!keyResponse.ok || !keyResult.publicKey) {
      throw new Error(
        keyResult.error ?? "通知サーバーを準備できませんでした。",
      );
    }
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyResult.publicKey),
      });
    }
    const response = await fetch(`${apiRoot}/push/subscribe`, {
      method: "POST",
      headers: apiHeaders(token, activeGroupId),
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        preview: options.preview ?? notificationPreview,
        quietHours: options.quiet ?? quietHours,
        appBadge: options.badge ?? appBadgeEnabled,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error ?? "通知端末を登録できませんでした。");
    }
  };

  const enableNotifications = async () => {
    if (isNotificationBusy) return;
    setIsNotificationBusy(true);
    setNotificationMessage("通知を設定しています…");
    try {
    const isIos = /iPad|iPhone|iPod/i.test(navigator.userAgent);
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in navigator &&
        (navigator as Navigator & { standalone?: boolean }).standalone ===
          true);
    if (isIos && !isStandalone) {
      setNotificationMessage(
        "iPhoneでは、先に共有メニューから「ホーム画面に追加」し、追加したアプリを開いて通知を有効にしてください。",
      );
      return;
    }
    if (!("Notification" in window)) {
      setNotificationMessage("このブラウザは通知に対応していません。");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setNotificationsEnabled(false);
      localStorage.setItem(notificationStorageKey, "disabled");
      setNotificationMessage(
        "ブラウザの設定で通知が許可されていません。",
      );
      return;
    }
    try {
      await registerPushSubscription();
      setNotificationsEnabled(true);
      localStorage.setItem(notificationStorageKey, "enabled");
      setNotificationMessage(
        "バックグラウンド通知を有効にしました。アプリを閉じているときも通知を受け取れます。",
      );
      trackEvent("notifications_enabled");
    } catch (reason) {
      setNotificationsEnabled(false);
      localStorage.setItem(notificationStorageKey, "disabled");
      setNotificationMessage(
        reason instanceof Error
          ? reason.message
          : "通知を有効にできませんでした。",
      );
    }
    } finally {
      setIsNotificationBusy(false);
    }
  };

  const disableNotifications = async () => {
    if (isNotificationBusy) return;
    setIsNotificationBusy(true);
    setNotificationMessage("通知を停止しています…");
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await fetch(`${apiRoot}/push/unsubscribe`, {
          method: "POST",
          headers: apiHeaders(token, activeGroupId),
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
    } catch {
      // Local notification state is still disabled if cleanup is unavailable.
    } finally {
      setIsNotificationBusy(false);
    }
    setNotificationsEnabled(false);
    localStorage.setItem(notificationStorageKey, "disabled");
    setNotificationMessage("新着通知を停止しました。");
  };

  const testNotification = async () => {
    if (isNotificationBusy) return;
    setIsNotificationBusy(true);
    setNotificationMessage("テスト通知を準備しています…");
    try {
    if (!("Notification" in window)) {
      setNotificationMessage("このブラウザは通知に対応していません。");
      return;
    }
    const permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
    if (permission !== "granted") {
      setNotificationMessage(
        "通知が許可されていません。ブラウザの設定をご確認ください。",
      );
      return;
    }
    try {
      await registerPushSubscription();
    } catch (reason) {
      setNotificationMessage(
        reason instanceof Error
          ? reason.message
          : "バックグラウンド通知を準備できませんでした。",
      );
      return;
    }
    await showSystemNotification(
      appName,
      "通知は正しく設定されています。",
      `test-${Date.now()}`,
    );
    setNotificationsEnabled(true);
    localStorage.setItem(notificationStorageKey, "enabled");
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
    };
    if (appBadgeEnabled) {
      await badgeNavigator.setAppBadge?.(1).catch(() => undefined);
    }
    setNotificationMessage(
      "テスト通知を送信しました。対応端末ではアイコンにバッジも表示します。",
    );
    } finally {
      setIsNotificationBusy(false);
    }
  };

  const updateNotificationPreview = (enabled: boolean) => {
    setNotificationPreview(enabled);
    localStorage.setItem(
      notificationPreviewStorageKey,
      enabled ? "visible" : "hidden",
    );
    if (notificationsEnabled) {
      void registerPushSubscription({ preview: enabled }).catch(() => undefined);
    }
  };

  const updateSystemNotifications = (enabled: boolean) => {
    setNotifySystemMessages(enabled);
    localStorage.setItem(
      notificationSystemStorageKey,
      enabled ? "enabled" : "disabled",
    );
  };

  const updateQuietHours = (enabled: boolean) => {
    setQuietHours(enabled);
    localStorage.setItem(
      quietHoursStorageKey,
      enabled ? "enabled" : "disabled",
    );
    if (notificationsEnabled) {
      void registerPushSubscription({ quiet: enabled }).catch(() => undefined);
    }
  };

  const updateAppBadge = (enabled: boolean) => {
    setAppBadgeEnabled(enabled);
    localStorage.setItem(
      appBadgeStorageKey,
      enabled ? "enabled" : "disabled",
    );
    if (notificationsEnabled) {
      void registerPushSubscription({ badge: enabled }).catch(() => undefined);
    }
  };

  const installApp = async () => {
    const prompt = installPromptRef.current;
    if (prompt) {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") {
        installPromptRef.current = null;
        setCanInstall(false);
      }
      return;
    }
    setShowInstallInstructions(true);
  };

  const showUnreadMessages = () => {
    void markActiveGroupRead();
    window.requestAnimationFrame(() => {
      messageEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    });
  };

  const clearSelectedMedia = () => {
    if (selectedMedia) URL.revokeObjectURL(selectedMedia.previewUrl);
    setSelectedMedia(null);
    setMediaError("");
    if (mediaInputRef.current) mediaInputRef.current.value = "";
  };

  const selectMediaFile = async (file: File | undefined) => {
    if (!file) return;
    setLoadError("");
    setMediaError("");
    try {
      const isImage = file.type.startsWith("image/");
      const isMp4 = file.type === "video/mp4" || /\.mp4$/i.test(file.name);
      const isVideo = isMp4 || file.type === "video/webm";
      if (!isImage && !isVideo) {
        throw new Error("送信できるのは画像、MP4、WebMです。");
      }
      const prepared = isImage
        ? await compressImage(file)
        : isMp4 && file.type !== "video/mp4"
          ? new File([file], file.name, {
              type: "video/mp4",
              lastModified: file.lastModified,
            })
          : file;
      const limit = isImage ? 2 * 1024 * 1024 : 9 * 1024 * 1024;
      if (prepared.size > limit) {
        throw new Error(
          isImage
            ? "画像を2MB以下に縮小できませんでした。"
            : "動画は9MB以下を選んでください。",
        );
      }
      clearSelectedMedia();
      setSelectedMedia({
        file: prepared,
        previewUrl: URL.createObjectURL(prepared),
        kind: isImage ? "image" : "video",
      });
    } catch (reason) {
      setMediaError(
        reason instanceof Error ? reason.message : "ファイルを準備できません。",
      );
    }
  };

  const sendMedia = async () => {
    if (!selectedMedia) return;
    setIsSendingMedia(true);
    setMediaError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60000);
    try {
      const formData = new FormData();
      formData.append("file", selectedMedia.file, selectedMedia.file.name);
      const response = await fetch(`${apiRoot}/messages/media`, {
        method: "POST",
        headers: mediaHeaders(token, activeGroupId),
        body: formData,
        signal: controller.signal,
      });
      const responseText = await response.text();
      let result: { error?: string; message?: ChatMessage } = {};
      try {
        result = responseText ? JSON.parse(responseText) : {};
      } catch {
        // Gateways may return plain text for size and temporary server errors.
      }
      if (!response.ok || !result.message) {
        const message =
          result.error ??
          (response.status === 413
            ? "動画の容量が大きすぎます。9MB以下のMP4を選んでください。"
            : response.status === 415
              ? "この動画形式は送信できません。MP4またはWebMを選んでください。"
              : response.status === 401
                ? "参加情報の有効期限が切れました。もう一度参加してください。"
                : `動画を送信できませんでした（エラー ${response.status}）。`);
        throw new Error(message);
      }
      const uploadedMessage = result.message;
      setMessages((current) => [...current, uploadedMessage]);
      trackEvent("media_sent");
      clearSelectedMedia();
      setIsReplyPanelOpen(false);
      setSentNotice(true);
      window.setTimeout(() => setSentNotice(false), 2200);
    } catch (reason) {
      setMediaError(
        reason instanceof DOMException && reason.name === "AbortError"
          ? "送信に時間がかかりすぎています。通信状況を確認して、もう一度お試しください。"
          : reason instanceof Error
            ? reason.message
            : "ファイルを送信できませんでした。",
      );
    } finally {
      window.clearTimeout(timeout);
      setIsSendingMedia(false);
    }
  };

  const speakMessage = (text: string) => {
    if (!("speechSynthesis" in window)) {
      setLoadError("このブラウザは読み上げに対応していません。");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = 0.88;
    window.speechSynthesis.speak(utterance);
    trackEvent("read_aloud");
  };

  const persistMessage = async (message: ChatMessage) => {
    try {
      const response = await fetch(`${apiRoot}/messages`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({ text: message.text }),
      });
      const result = await response.json();
      if (response.status === 401) {
        leaveSession();
        return;
      }
      if (!response.ok) throw new Error(result.error ?? "送信できませんでした。");
      setMessages((current) => [...current, result.message]);
      setPendingSend(null);
      trackEvent("message_sent");
      setSentNotice(true);
      window.setTimeout(() => setSentNotice(false), 2200);
    } catch (reason) {
      setPendingSend(null);
      setLoadError(
        reason instanceof Error ? reason.message : "返事を送信できませんでした。",
      );
    }
  };

  const sendMessage = () => {
    if (pendingSend || !profile) return;
    setIsSending(true);
    const optimisticMessage: ChatMessage = {
      id: `pending-${Date.now()}`,
      sender: profile.name,
      text: pendingMessage,
      createdAt: new Date().toISOString(),
      avatar: "mint",
      pending: true,
    };
    setPendingSend(optimisticMessage);
    setPendingMessage("");
    setDraft("");
    setIsWriting(false);
    setIsReplyPanelOpen(false);
    setShowConfirmation(false);
    setIsSending(false);
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = null;
      void persistMessage(optimisticMessage);
    }, 5000);
  };

  const undoSend = () => {
    if (pendingTimerRef.current) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    setPendingSend(null);
    setSentNotice(false);
    trackEvent("send_undone");
  };

  const setTextSize = (size: "small" | "normal" | "large") => {
    setTextSizeState(size);
    localStorage.setItem(textSizeStorageKey, size);
    trackEvent(`text_${size}`);
  };

  const setAnalyticsPreference = (enabled: boolean) => {
    setAnalyticsEnabled(enabled);
    localStorage.setItem(analyticsStorageKey, enabled ? "enabled" : "disabled");
  };

  const setTheme = (theme: ThemeColor) => {
    setThemeColor(theme);
    localStorage.setItem(themeStorageKey, theme);
  };

  const switchGroup = (groupId: string) => {
    localStorage.setItem(activeGroupStorageKey, groupId);
    setActiveGroupId(groupId);
    setShowGroups(false);
    setShowGroup(false);
  };

  const createGroup = async () => {
    if (!newGroupName.trim()) return;
    setIsChangingGroups(true);
    setGroupSwitcherError("");
    try {
      const response = await fetch(`${apiRoot}/groups`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (newGroupImage) {
        try {
          await uploadImage("/group/image", newGroupImage.file, result.group.id);
        } catch (reason) {
          await fetch(`${apiRoot}/group/delete`, {
            method: "POST",
            headers: apiHeaders(token, result.group.id),
          }).catch(() => undefined);
          throw reason;
        }
      }
      setNewGroupName("");
      if (newGroupImage) URL.revokeObjectURL(newGroupImage.previewUrl);
      setNewGroupImage(null);
      await loadGroups();
      switchGroup(result.group.id);
    } catch (reason) {
      setGroupSwitcherError(
        reason instanceof Error
          ? reason.message
          : "グループを作成できませんでした。",
      );
    } finally {
      setIsChangingGroups(false);
    }
  };

  const joinAnotherGroup = async () => {
    if (!joinGroupCode.trim()) return;
    setIsChangingGroups(true);
    setGroupSwitcherError("");
    try {
      const response = await fetch(`${apiRoot}/groups/join`, {
        method: "POST",
        headers: apiHeaders(token, activeGroupId),
        body: JSON.stringify({ inviteCode: joinGroupCode.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setJoinGroupCode("");
      await loadGroups();
      switchGroup(result.group.id);
    } catch (reason) {
      setGroupSwitcherError(
        reason instanceof Error
          ? reason.message
          : "グループに参加できませんでした。",
      );
    } finally {
      setIsChangingGroups(false);
    }
  };

  if (!token || !profile) {
    return <JoinScreen onJoined={handleJoined} />;
  }

  return (
    <div
      className={`chat-app theme-${themeColor} ${
        textSize === "large"
          ? "text-large"
          : textSize === "small"
            ? "text-small"
            : ""
      }`}
    >
      <header className="group-header">
        <div className="group-header__inner">
          <button
            aria-label="茶話会を切り替える"
            className="group-icon"
            onClick={() => {
              setShowGroups(true);
              void loadGroups();
            }}
          >
            <img
              alt=""
              height="25"
              src="/assets/9cbab.svg"
              width="25"
            />
            {totalGroupUnread > 0 && (
              <span className="group-unread-badge">
                {totalGroupUnread > 99 ? "99+" : totalGroupUnread}
              </span>
            )}
          </button>
          <button
            className="group-details"
            onClick={() => {
              setShowGroup(true);
              void loadGroup();
            }}
          >
            <span className="group-details__title">
              {groupImageUrl && (
                <img alt="" src={groupImageUrl} />
              )}
              <h1>{groupName}</h1>
            </span>
          </button>
          <span
            className={`dm-listening ${dmListening ? "" : "is-off"}`}
            role="status"
          >
            {dmListening ? "📞 着信待ち中" : "📵 着信できません"}
          </span>
        </div>
        <nav aria-label="メニュー" className="header-actions">
          <button
            aria-label="グループで音声通話をする"
            className="header-action"
            onClick={() => setShowVoice(true)}
          >
            <span aria-hidden="true" className="header-action__icon">📞</span>
            <span>グループ通話</span>
          </button>
          <button
            aria-label="1対1で電話をする"
            className="header-action"
            onClick={() => setShowDirectCall(true)}
          >
            <span aria-hidden="true" className="header-action__icon">🤙</span>
            <span>1対1</span>
          </button>
          <button
            aria-label="みんなで脳活タイムを開く"
            className="header-action"
            onClick={() => setShowBrain(true)}
          >
            <span aria-hidden="true" className="header-action__icon">
              <BrainIcon />
            </span>
            <span>脳活</span>
          </button>
          <button
            aria-label={`参加者と招待コードを見る（${members.length || 4}人が参加中）`}
            className="header-action"
            onClick={() => {
              setShowGroup(true);
              void loadGroup();
            }}
          >
            <span aria-hidden="true" className="header-action__icon">
              <PeopleIcon />
            </span>
            <span>参加者</span>
          </button>
          <button
            aria-label="退出する"
            className="header-action header-action--leave"
            onClick={() => setShowLeaveConfirmation(true)}
          >
            <span aria-hidden="true" className="header-action__icon">🚪</span>
            <span>退出</span>
          </button>
        </nav>
      </header>

      <main className="chat-area">
        {loadError && (
          <button className="load-error" onClick={() => void loadMessages()}>
            {loadError}
            <span>もう一度試す</span>
          </button>
        )}
        {isLoading ? (
          <div className="initial-chat-loading" role="status">
            <div className="initial-chat-loading__icon">
              <PeopleIcon />
            </div>
            <strong>会話を準備しています</strong>
            <span>最新のメッセージを読み込んでいます</span>
            <div aria-hidden="true" className="initial-chat-loading__bar">
              <i />
            </div>
          </div>
        ) : (
          <div
            className={`message-list ${
              isPositioningMessages ? "is-positioning" : ""
            }`}
            aria-label="グループの会話"
          >
            {isLoadingOlder ? (
              <div className="history-loading" role="status">
                <span />
                過去の会話を読み込んでいます
              </div>
            ) : hasOlderMessages ? (
              <p className="history-guide">上へスクロールすると過去の会話を表示します</p>
            ) : messages.length > 0 ? (
              <p className="history-guide">これより前の会話はありません</p>
            ) : null}
            {[...messages, ...(pendingSend ? [pendingSend] : [])].map(
              (message) => {
              const mine = message.sender === profile.name;
              const time = new Intl.DateTimeFormat("ja-JP", {
                hour: "numeric",
                minute: "2-digit",
                hour12: false,
              }).format(new Date(message.createdAt));

              const unreadMarker =
                message.id === unreadIds[0] ? (
                  <div className="unread-divider">
                    <span>ここから新しいメッセージ</span>
                  </div>
                ) : null;

              if (message.kind === "system") {
                return (
                  <Fragment key={message.id}>
                    {unreadMarker}
                    <article className="system-message">
                    <span>グループ名が変わりました</span>
                    <strong>「{message.groupName}」</strong>
                    <small>
                      {message.sender}さんが変更しました · {time}
                    </small>
                    </article>
                  </Fragment>
                );
              }

              return (
                <Fragment key={message.id}>
                  {unreadMarker}
                  <article
                    className={`message-row ${mine ? "message-row--mine" : ""}`}
                  >
                  {!mine && (
                    <div className="sender">
                      <div className={`avatar avatar--${message.avatar}`}>
                        {members.find((member) => member.name === message.sender)
                          ?.imageUrl && (
                          <img
                            alt=""
                            src={
                              members.find(
                                (member) => member.name === message.sender,
                              )?.imageUrl
                            }
                          />
                        )}
                      </div>
                      <span>{message.sender}</span>
                    </div>
                  )}
                  <div className="message-bubble">
                    {message.attachment?.signedUrl &&
                      (message.attachment.kind === "image" ? (
                        <img
                          alt={message.attachment.fileName}
                          className="message-media"
                          loading="lazy"
                          src={message.attachment.signedUrl}
                        />
                      ) : (
                        <video
                          className="message-media"
                          controls
                          playsInline
                          preload="metadata"
                          src={message.attachment.signedUrl}
                        />
                      ))}
                    <p>{message.text}</p>
                    <div className="message-actions">
                      <time>{message.pending ? "送信待ち" : time}</time>
                      {!message.pending && (
                        <button onClick={() => speakMessage(message.text)}>
                          読み上げ
                        </button>
                      )}
                    </div>
                  </div>
                  {mine && (
                    <span className="mine-label">
                      {profile.imageUrl && <img alt="" src={profile.imageUrl} />}
                      {profile.name}
                    </span>
                  )}
                  </article>
                </Fragment>
                );
              },
            )}
            <div aria-hidden="true" className="message-end" ref={messageEndRef} />
            <div className="app-credits">
              <span>© Ron AI Systems</span>
              <a
                href="https://ron-home-app.vercel.app/"
                rel="noopener noreferrer"
                target="_blank"
              >
                ヘルプ
              </a>
              <button onClick={() => setShowRetentionNotice(true)}>
                データ保存について
              </button>
            </div>
          </div>
        )}
      </main>

      {unreadIds.length > 0 && (
        <button className="new-messages-button" onClick={showUnreadMessages}>
          新しいメッセージ {unreadIds.length}件
        </button>
      )}

      <footer className="composer">
        <div className="composer__inner">
          <input
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
            className="media-input"
            onChange={(event) =>
              void selectMediaFile(event.target.files?.[0])
            }
            ref={mediaInputRef}
            type="file"
          />
          {isWriting ? (
            <div className="writing-panel">
              <div className="writing-panel__heading">
                <label htmlFor="free-message">ほかの言葉で返事する</label>
                <button
                  aria-label="自由入力を閉じる"
                  className="close-button"
                  onClick={() => {
                    setIsWriting(false);
                    setIsReplyPanelOpen(false);
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
              <textarea
                id="free-message"
                maxLength={500}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="返事を入力してください"
                ref={inputRef}
                rows={2}
                value={draft}
              />
              <button
                className="reply-button reply-button--primary"
                disabled={!draft.trim()}
                onClick={() => prepareMessage(draft)}
              >
                内容を確認する
              </button>
              <button
                className="media-select-button"
                onClick={() => mediaInputRef.current?.click()}
              >
                写真・動画を送る
              </button>
            </div>
          ) : isReplyPanelOpen ? (
            <div className="expanded-replies">
              <div className="expanded-replies__heading">
                <strong>返信を選ぶ</strong>
                <button
                  aria-label="返信一覧を閉じる"
                  className="close-button"
                  onClick={() => setIsReplyPanelOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
              <div className="reply-actions">
                {isLoadingSuggestions && (
                  <div className="suggestion-status" role="status">
                    <span className="loading-dot" />
                    会話に合う返信案を考えています…
                  </div>
                )}
                {suggestions.map((suggestion, index) => (
                  <button
                    className={`reply-button ${
                      index === 0
                        ? "reply-button--primary"
                        : "reply-button--secondary"
                    }`}
                    key={suggestion}
                    onClick={() => selectSuggestion(suggestion)}
                  >
                    {suggestion} と返す
                  </button>
                ))}
                {suggestionError && (
                  <button
                    className="suggestion-refresh"
                    disabled={isLoadingSuggestions}
                    onClick={() => {
                      trackEvent("ai_retry");
                      void loadSuggestions(true);
                    }}
                  >
                    <span>{suggestionError}</span>
                    {isLoadingSuggestions ? "作成中…" : "AIでもう一度作る"}
                  </button>
                )}
                <button
                  className="write-own-button"
                  onClick={() => {
                    trackEvent("free_input_opened");
                    setIsWriting(true);
                  }}
                >
                  ほかの言葉で返事する
                </button>
                <button
                  className="media-select-button"
                  onClick={() => mediaInputRef.current?.click()}
                >
                  写真・動画を送る
                </button>
              </div>
            </div>
          ) : (
            <div className="compact-reply">
              <button
                className="compact-suggestion"
                onClick={() =>
                  selectSuggestion(suggestions[0] ?? fallbackSuggestions[0])
                }
              >
                <span>{suggestions[0] ?? fallbackSuggestions[0]}</span>
                <small>この言葉で返す</small>
              </button>
              <button
                className="open-replies-button"
                onClick={() => setIsReplyPanelOpen(true)}
              >
                返信を選ぶ
              </button>
              {isLoadingSuggestions && (
                <span className="compact-loading" aria-label="返信案を更新中" />
              )}
            </div>
          )}
        </div>
      </footer>

      {showVoice && (
        <VoiceCall
          apiRoot={apiRoot}
          headers={apiHeaders(token, activeGroupId)}
          myName={profile.name}
          onClose={() => setShowVoice(false)}
        />
      )}

      <DirectCall
        key={activeGroupId}
        apiRoot={apiRoot}
        headers={apiHeaders(token, activeGroupId)}
        members={members}
        myName={profile.name}
        notify={(title, body, tag) => {
          if (
            notificationsEnabledRef.current &&
            "Notification" in window &&
            Notification.permission === "granted"
          ) {
            void showSystemNotification(title, body, tag);
          }
        }}
        onClosePanel={() => setShowDirectCall(false)}
        onListeningChange={setDmListening}
        showPanel={showDirectCall}
      />

      {showBrain && (
        <BrainPanel
          activeGroupId={activeGroupId}
          isAdmin={isAdmin}
          members={members}
          onClose={() => setShowBrain(false)}
          onTrack={trackEvent}
          profile={profile}
          token={token}
        />
      )}

      {showRetentionNotice && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="retention-notice-title"
            aria-modal="true"
            className="confirm-dialog retention-notice"
            role="dialog"
          >
            <button
              aria-label="データ保存について閉じる"
              className="dialog-close"
              onClick={() => setShowRetentionNotice(false)}
            >
              <CloseIcon />
            </button>
            <p className="dialog-eyebrow">データ保存の注意事項</p>
            <h2 id="retention-notice-title">保存期間について</h2>
            <ul>
              <li>通常の会話は90日間保存します。</li>
              <li>画像・動画とシステムのお知らせは30日間保存します。</li>
              <li>会話が500件を超えた場合は、古いものから削除します。</li>
              <li>グループを削除した場合は、関連データも削除します。</li>
            </ul>
            <p className="dialog-note">
              保存期限を過ぎたデータは定期処理で削除されます。処理のタイミングにより、画面への反映まで時間がかかる場合があります。
            </p>
            <button
              className="dialog-button dialog-button--send retention-notice__close"
              onClick={() => setShowRetentionNotice(false)}
            >
              確認しました
            </button>
          </section>
        </div>
      )}

      {showLeaveConfirmation && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="leave-confirm-title"
            aria-modal="true"
            className="confirm-dialog"
            role="alertdialog"
          >
            <button
              aria-label="退出確認を閉じる"
              className="dialog-close"
              onClick={() => setShowLeaveConfirmation(false)}
            >
              <CloseIcon />
            </button>
            <p className="dialog-eyebrow">退出の確認</p>
            <h2 id="leave-confirm-title">{appName}から退出しますか？</h2>
            <p className="dialog-note">
              退出すると、茶話会の電話（着信）に気づけなくなります。よろしいですか？
              この端末の参加状態を解除します。これまでの会話内容は削除されません。
            </p>
            <div className="dialog-actions">
              <button
                className="dialog-button dialog-button--back"
                onClick={() => setShowLeaveConfirmation(false)}
              >
                戻る
              </button>
              <button
                className="dialog-button delete-confirm-button"
                onClick={() => {
                  setShowLeaveConfirmation(false);
                  leaveSession();
                }}
              >
                退出する
              </button>
            </div>
          </section>
        </div>
      )}

      {showConfirmation && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="confirm-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <button
              aria-label="確認画面を閉じる"
              className="dialog-close"
              onClick={cancelConfirmation}
            >
              <CloseIcon />
            </button>
            <p className="dialog-eyebrow">送信前の確認</p>
            <h2 id="confirm-title">この返事を送りますか？</h2>
            <div className="message-preview">{pendingMessage}</div>
            <p className="dialog-note">
              「送る」を押すまで、自動で送信されることはありません。
            </p>
            <div className="dialog-actions">
              <button
                className="dialog-button dialog-button--back"
                disabled={isSending}
                onClick={cancelConfirmation}
              >
                戻る
              </button>
              <button
                className="dialog-button dialog-button--send"
                disabled={isSending}
                onClick={sendMessage}
              >
                <SendIcon />
                {isSending ? "送信中…" : "送る"}
              </button>
            </div>
          </section>
        </div>
      )}

      {selectedMedia && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="media-confirm-title"
            aria-modal="true"
            className="confirm-dialog media-confirm-dialog"
            role="dialog"
          >
            <button
              aria-label="ファイル送信をやめる"
              className="dialog-close"
              disabled={isSendingMedia}
              onClick={clearSelectedMedia}
            >
              <CloseIcon />
            </button>
            <p className="dialog-eyebrow">送信前の確認</p>
            <h2 id="media-confirm-title">
              この{selectedMedia.kind === "image" ? "画像" : "動画"}を送りますか？
            </h2>
            {selectedMedia.kind === "image" ? (
              <img
                alt="送信する画像の確認"
                className="media-preview"
                src={selectedMedia.previewUrl}
              />
            ) : (
              <video
                className="media-preview"
                controls
                playsInline
                preload="metadata"
                src={selectedMedia.previewUrl}
              />
            )}
            <p className="media-size-note">
              {selectedMedia.kind === "image"
                ? "画像は通信量を抑えるため縮小されています"
                : "動画は自動再生されません。9MBまで送信できます"}{" "}
              · {(selectedMedia.file.size / 1024 / 1024).toFixed(1)}MB
            </p>
            {mediaError && (
              <p className="form-error media-upload-error" role="alert">
                {mediaError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="dialog-button dialog-button--back"
                disabled={isSendingMedia}
                onClick={clearSelectedMedia}
              >
                やめる
              </button>
              <button
                className="dialog-button dialog-button--send"
                disabled={isSendingMedia}
                onClick={sendMedia}
              >
                {isSendingMedia ? "送信しています…" : "送信する"}
              </button>
            </div>
          </section>
        </div>
      )}

      {mediaError && !selectedMedia && (
        <div className="media-error-toast" role="alert">
          <span>{mediaError}</span>
          <button onClick={() => setMediaError("")}>閉じる</button>
        </div>
      )}

      {showGroups && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="groups-title"
            aria-modal="true"
            className="group-panel group-switcher"
            role="dialog"
          >
            {activeGroupId && (
              <button
                aria-label="茶話会一覧を閉じる"
                className="dialog-close"
                onClick={() => setShowGroups(false)}
              >
                <CloseIcon />
              </button>
            )}
            <p className="dialog-eyebrow">参加している茶話会</p>
            <h2 id="groups-title">茶話会を選ぶ</h2>

            <div className="group-list">
              {groups.map((group) => (
                <button
                  className={group.id === activeGroupId ? "is-active" : ""}
                  key={group.id}
                  onClick={() => switchGroup(group.id)}
                >
                  <span className="group-list__image">
                    <img
                      alt=""
                      className={group.imageUrl ? "has-image" : ""}
                      src={group.imageUrl || "/assets/9cbab.svg"}
                    />
                  </span>
                  <span className="group-list__content">
                    <strong>{group.name}</strong>
                    <small>
                      {group.latestMessage
                        ? group.latestMessage.hasAttachment
                          ? `${group.latestMessage.sender}さんからファイル`
                          : `${group.latestMessage.sender}さん: ${group.latestMessage.text}`
                        : "まだメッセージはありません"}
                    </small>
                  </span>
                  <span className="group-list__status">
                    {(group.unreadCount ?? 0) > 0 && (
                      <b>{group.unreadCount}</b>
                    )}
                    <small>
                      {group.id === activeGroupId ? "表示中" : "開く"}
                    </small>
                  </span>
                </button>
              ))}
            </div>

            <div className="group-switcher__section">
              <label htmlFor="new-group-name">新しい茶話会を作る</label>
              <div>
                <input
                  id="new-group-name"
                  maxLength={20}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  placeholder="茶話会の名前"
                  value={newGroupName}
                />
                <button
                  disabled={isChangingGroups || !newGroupName.trim()}
                  onClick={createGroup}
                >
                  作る
                </button>
              </div>
              <label
                className="image-picker-label"
                htmlFor="new-group-image"
              >
                茶話会画像（任意・1枚）
              </label>
              <input
                accept="image/jpeg,image/png,image/webp"
                className="profile-image-input"
                id="new-group-image"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (newGroupImage) {
                    URL.revokeObjectURL(newGroupImage.previewUrl);
                  }
                  setNewGroupImage({
                    file,
                    previewUrl: URL.createObjectURL(file),
                  });
                }}
                type="file"
              />
              {newGroupImage && (
                <div className="profile-image-preview group-image-preview">
                  <img alt="新しい茶話会の画像" src={newGroupImage.previewUrl} />
                  <button
                    onClick={() => {
                      URL.revokeObjectURL(newGroupImage.previewUrl);
                      setNewGroupImage(null);
                    }}
                  >
                    画像を外す
                  </button>
                </div>
              )}
            </div>

            <div className="group-switcher__section">
              <label htmlFor="join-group-code">招待コードで参加する</label>
              <div>
                <input
                  autoCapitalize="characters"
                  id="join-group-code"
                  onChange={(event) => setJoinGroupCode(event.target.value)}
                  placeholder="招待コード"
                  value={joinGroupCode}
                />
                <button
                  disabled={isChangingGroups || !joinGroupCode.trim()}
                  onClick={joinAnotherGroup}
                >
                  参加
                </button>
              </div>
            </div>

            {groupSwitcherError && (
              <p className="form-error" role="alert">
                {groupSwitcherError}
              </p>
            )}
          </section>
        </div>
      )}

      {showGroup && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="group-panel-title"
            aria-modal="true"
            className="group-panel"
            role="dialog"
          >
            <button
              aria-label="参加者画面を閉じる"
              className="dialog-close"
              onClick={() => setShowGroup(false)}
            >
              <CloseIcon />
            </button>
            <p className="dialog-eyebrow">招待された方だけのグループ</p>
            <h2 id="group-panel-title">参加者と招待</h2>

            <div className="image-setting">
              <div className={`avatar avatar--${members.find((member) => member.name === profile.name)?.avatar ?? "mint"}`}>
                {profile.imageUrl && <img alt="" src={profile.imageUrl} />}
              </div>
              <div className="image-setting__content">
                <strong>あなたの参加者画像</strong>
                <span>この茶話会で表示する画像です</span>
                <div className="image-setting__actions">
                  <label
                    className={isSavingProfileImage ? "is-disabled" : ""}
                    htmlFor="profile-image-change"
                  >
                    {profile.imageUrl ? "画像を変更" : "画像を設定"}
                  </label>
                  <input
                    accept="image/jpeg,image/png,image/webp"
                    disabled={isSavingProfileImage}
                    id="profile-image-change"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void changeProfileImage(file);
                    }}
                    type="file"
                  />
                  {profile.imageUrl && (
                    <button
                      disabled={isSavingProfileImage}
                      onClick={() => void deleteProfileImage()}
                    >
                      削除
                    </button>
                  )}
                </div>
              </div>
            </div>

            {isAdmin && (
              <div className="image-setting">
                <div className="group-image-thumbnail">
                  <img
                    alt=""
                    className={groupImageUrl ? "has-image" : ""}
                    src={groupImageUrl || "/assets/9cbab.svg"}
                  />
                </div>
                <div className="image-setting__content">
                  <strong>茶話会画像</strong>
                  <span>一覧と画面上部に表示します</span>
                  <div className="image-setting__actions">
                    <label
                      className={isSavingGroupImage ? "is-disabled" : ""}
                      htmlFor="group-image-change"
                    >
                      {groupImageUrl ? "画像を変更" : "画像を設定"}
                    </label>
                    <input
                      accept="image/jpeg,image/png,image/webp"
                      disabled={isSavingGroupImage}
                      id="group-image-change"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void changeGroupImage(file);
                      }}
                      type="file"
                    />
                    {groupImageUrl && (
                      <button
                        disabled={isSavingGroupImage}
                        onClick={() => void deleteGroupImage()}
                      >
                        削除
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {isAdmin ? (
              <div className="group-name-editor">
                <label htmlFor="group-name">グループ名</label>
                <div>
                  <input
                    id="group-name"
                    maxLength={20}
                    onChange={(event) => setGroupNameDraft(event.target.value)}
                    value={groupNameDraft}
                  />
                  <button
                    disabled={
                      isSavingGroupName ||
                      !groupNameDraft.trim() ||
                      groupNameDraft.trim() === groupName
                    }
                    onClick={saveGroupName}
                  >
                    {isSavingGroupName ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="admin-note">
                グループの設定は管理者が行います。
              </p>
            )}

            <div className="invite-card">
              <span>現在の招待コード</span>
              <strong>{inviteCode || "読み込み中…"}</strong>
              <button
                className="copy-code-button"
                disabled={!inviteCode}
                onClick={copyInviteCode}
              >
                コードをコピー
              </button>
            </div>
            {isAdmin && (
              <button
                className="rotate-code-button"
                disabled={isRotatingCode}
                onClick={rotateInviteCode}
              >
                {isRotatingCode
                  ? "作り直しています…"
                  : "招待コードを作り直す"}
              </button>
            )}

            <div className="notification-setting">
              <div>
                <strong>新着メッセージの通知</strong>
                <span>
                  {notificationsEnabled
                    ? "アプリを閉じているときも通知を受け取ります"
                    : "新着メッセージを端末へ通知します"}
                </span>
              </div>
              <button
                disabled={isNotificationBusy}
                onClick={
                  notificationsEnabled
                    ? disableNotifications
                    : enableNotifications
                }
              >
                {isNotificationBusy
                  ? "設定中…"
                  : notificationsEnabled
                    ? "停止する"
                    : "有効にする"}
              </button>
            </div>
            <button
              className="notification-detail-button"
              onClick={() =>
                setShowNotificationSettings((current) => !current)
              }
            >
              {showNotificationSettings ? "通知設定を閉じる" : "通知を詳しく設定"}
            </button>
            <button
              className="notification-test-button"
              disabled={isNotificationBusy}
              onClick={testNotification}
            >
              テスト通知を送る
            </button>
            {showNotificationSettings && (
              <div className="notification-options">
                <label>
                  <span>
                    <strong>本文を表示</strong>
                    <small>通知に送信者名と文章を表示します</small>
                  </span>
                  <input
                    checked={notificationPreview}
                    onChange={(event) =>
                      updateNotificationPreview(event.target.checked)
                    }
                    type="checkbox"
                  />
                </label>
                <label>
                  <span>
                    <strong>設定変更も通知</strong>
                    <small>グループ名や管理者の変更を知らせます</small>
                  </span>
                  <input
                    checked={notifySystemMessages}
                    onChange={(event) =>
                      updateSystemNotifications(event.target.checked)
                    }
                    type="checkbox"
                  />
                </label>
                <label>
                  <span>
                    <strong>夜間は通知しない</strong>
                    <small>午後8時から午前8時まで通知を止めます</small>
                  </span>
                  <input
                    checked={quietHours}
                    onChange={(event) =>
                      updateQuietHours(event.target.checked)
                    }
                    type="checkbox"
                  />
                </label>
                <label>
                  <span>
                    <strong>アプリアイコンに未読件数</strong>
                    <small>
                      {"setAppBadge" in navigator
                        ? "ホーム画面のアイコンへ件数を表示します"
                        : "この端末ではOSバッジに未対応です。画面内には表示します"}
                    </small>
                  </span>
                  <span className="app-badge-preview" aria-hidden="true">
                    <img
                      alt=""
                      height="38"
                      src="/pwa-icon-192.png"
                      width="38"
                    />
                    <b>{totalGroupUnread || 1}</b>
                  </span>
                  <input
                    checked={appBadgeEnabled}
                    onChange={(event) =>
                      updateAppBadge(event.target.checked)
                    }
                    type="checkbox"
                  />
                </label>
              </div>
            )}
            {notificationMessage && (
              <p className="notification-message" role="status">
                {notificationMessage}
              </p>
            )}

            <div className="install-setting">
              <div className="install-setting__icon">
                <img alt="" height="28" src="/assets/9cbab.svg" width="28" />
              </div>
              <div>
                <strong>アプリとして使う</strong>
                <span>
                  {isInstalled
                    ? "この端末にインストール済みです"
                    : "ホーム画面からすぐに開けます"}
                </span>
              </div>
              {!isInstalled && (
                <button onClick={installApp}>
                  {canInstall ? "インストール" : "追加方法"}
                </button>
              )}
            </div>
            {showInstallInstructions && !isInstalled && (
              <div className="install-instructions">
                <strong>ホーム画面への追加方法</strong>
                <ol>
                  <li>ブラウザの共有またはメニューボタンを押す</li>
                  <li>「ホーム画面に追加」または「アプリをインストール」を選ぶ</li>
                  <li>「追加」を押す</li>
                </ol>
                <button onClick={() => setShowInstallInstructions(false)}>
                  閉じる
                </button>
              </div>
            )}

            <div className="text-size-setting">
              <div>
                <strong>文字の大きさ</strong>
                <span>この端末だけに設定されます</span>
              </div>
              <div className="text-size-buttons">
                <button
                  aria-pressed={textSize === "small"}
                  className={textSize === "small" ? "is-active" : ""}
                  onClick={() => setTextSize("small")}
                >
                  小さく
                </button>
                <button
                  aria-pressed={textSize === "normal"}
                  className={textSize === "normal" ? "is-active" : ""}
                  onClick={() => setTextSize("normal")}
                >
                  標準
                </button>
                <button
                  aria-pressed={textSize === "large"}
                  className={textSize === "large" ? "is-active" : ""}
                  onClick={() => setTextSize("large")}
                >
                  大きく
                </button>
              </div>
            </div>

            <div className="theme-setting">
              <div>
                <strong>画面の色</strong>
                <span>この端末だけに設定されます</span>
              </div>
              <div className="theme-buttons" role="group" aria-label="画面の色">
                {(
                  [
                    ["green", "緑"],
                    ["pink", "ピンク"],
                    ["blue", "ブルー"],
                    ["black", "黒"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    aria-pressed={themeColor === value}
                    className={themeColor === value ? "is-active" : ""}
                    key={value}
                    onClick={() => setTheme(value)}
                  >
                    <span className={`theme-swatch theme-swatch--${value}`} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="analytics-setting">
              <div>
                <strong>匿名の利用記録</strong>
                <span>会話内容や名前は記録しません</span>
              </div>
              <button
                className={analyticsEnabled ? "is-active" : ""}
                onClick={() => setAnalyticsPreference(!analyticsEnabled)}
              >
                {analyticsEnabled ? "記録中" : "停止中"}
              </button>
            </div>

            {isAdmin && <div className="usage-report">
              <div className="usage-report__heading">
                <strong>試用レポート</strong>
                <button onClick={() => void loadAnalyticsSummary()}>
                  更新
                </button>
              </div>
              <div className="usage-report__grid">
                <div>
                  <strong>{analyticsSummary.suggestion_selected ?? 0}</strong>
                  <span>返信案を選択</span>
                </div>
                <div>
                  <strong>{analyticsSummary.free_input_opened ?? 0}</strong>
                  <span>自由入力を利用</span>
                </div>
                <div>
                  <strong>{analyticsSummary.send_undone ?? 0}</strong>
                  <span>送信を取消</span>
                </div>
                <div>
                  <strong>{analyticsSummary.read_aloud ?? 0}</strong>
                  <span>読み上げを利用</span>
                </div>
              </div>
            </div>}

            <h3>参加者 {members.length}人</h3>
            <div className="member-list">
              {members.map((member) => (
                <div className="member-row" key={member.name}>
                  <div className={`avatar avatar--${member.avatar}`}>
                    {member.imageUrl && <img alt="" src={member.imageUrl} />}
                  </div>
                  <div className="member-row__identity">
                    <span>{member.name}</span>
                    <small>
                      {member.name === profile.name ? "あなた" : ""}
                      {member.name === profile.name && member.isAdmin
                        ? " · "
                        : ""}
                      {member.isAdmin ? "管理者" : ""}
                    </small>
                  </div>
                  {isAdmin && (
                    <div className="member-admin-actions">
                      <button
                        disabled={memberActionName === member.name}
                        onClick={() => void changeMemberRole(member)}
                      >
                        {member.isAdmin ? "管理者を解除" : "管理者にする"}
                      </button>
                      {member.name !== profile.name && (
                        <button
                          className="remove-member-button"
                          disabled={memberActionName === member.name}
                          onClick={() => void removeMember(member)}
                        >
                          外す
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {groupError && (
              <button className="group-error" onClick={() => void loadGroup()}>
                {groupError} もう一度試す
              </button>
            )}
            {isAdmin && canDeleteGroup && (
              <div className="danger-zone">
                <strong>グループの削除</strong>
                <p>管理者だけが、このグループと会話を削除できます。</p>
                <button onClick={() => setShowDeleteGroup(true)}>
                  このグループを削除
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {showDeleteGroup && isAdmin && canDeleteGroup && (
        <div className="dialog-backdrop destructive-backdrop">
          <section
            aria-labelledby="delete-group-title"
            aria-modal="true"
            className="confirm-dialog delete-group-dialog"
            role="alertdialog"
          >
            <p className="delete-eyebrow">取り消すことはできません</p>
            <h2 id="delete-group-title">「{groupName}」を削除しますか？</h2>
            <div className="delete-warning">
              <strong>削除されるもの</strong>
              <ul>
                <li>すべてのチャット本文</li>
                <li>参加者と管理者の情報</li>
                <li>招待コードとグループ設定</li>
                <li>匿名の試用レポート</li>
              </ul>
            </div>
            <p className="dialog-note">
              削除後は、ほかの参加者もこのグループを開けなくなります。
            </p>
            <div className="dialog-actions">
              <button
                className="dialog-button dialog-button--back"
                disabled={isDeletingGroup}
                onClick={() => setShowDeleteGroup(false)}
              >
                削除しない
              </button>
              <button
                className="dialog-button delete-confirm-button"
                disabled={isDeletingGroup}
                onClick={deleteGroup}
              >
                {isDeletingGroup ? "削除しています…" : "すべて削除する"}
              </button>
            </div>
          </section>
        </div>
      )}

      {sentNotice && (
        <div className="sent-notice" role="status">
          {showGroup ? "招待コードをコピーしました" : "返事を送りました"}
        </div>
      )}

      {pendingSend && (
        <div className="undo-toast" role="status">
          <span>5秒後に送信します</span>
          <button onClick={undoSend}>送信を取り消す</button>
        </div>
      )}
    </div>
  );
}
