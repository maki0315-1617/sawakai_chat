import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import * as kv from "./kv_store.tsx";

const app = new Hono();
const root = "/make-server-8e9e0c0c";
const defaultInviteCode = Deno.env.get("SAWAKAI_INVITE_CODE") || "ochakai";
const defaultGroupId = "weekend-meal";
const groupsKey = "sawakai:groups";
const mediaBucket = "sawakai-media";
const dayMs = 24 * 60 * 60 * 1000;
const messageRetentionMs = 90 * dayMs;
const shortRetentionMs = 30 * dayMs;
const messageLimit = 500;
const retentionCleanupKey = "sawakai:retention:last-cleanup";

type Session = {
  name: string;
  expiresAt: number;
  groupIds?: string[];
  readAt?: Record<string, string>;
};
type Group = {
  id: string;
  name: string;
  inviteCode: string;
  createdAt: string;
  adminNames?: string[];
  createdBy?: string;
  image?: {
    path: string;
    signedUrl?: string;
    signedUntil?: string;
  };
};
type Message = {
  id: string;
  sender: string;
  text: string;
  createdAt: string;
  avatar: "mint" | "peach" | "sand";
  kind?: "message" | "system";
  groupName?: string;
  attachment?: {
    path: string;
    kind: "image" | "video";
    mimeType: string;
    size: number;
    fileName: string;
    signedUrl?: string;
    signedUntil?: string;
  };
};
type Member = {
  name: string;
  joinedAt: string;
  lastSeenAt: string;
  avatar: Message["avatar"];
  avatarImage?: {
    path: string;
    signedUrl?: string;
    signedUntil?: string;
  };
};
type Analytics = {
  counts: Record<string, number>;
  updatedAt: string;
};
type PushDevice = {
  name: string;
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
  preview: boolean;
  quietHours: boolean;
  appBadge: boolean;
  updatedAt: string;
};
type VapidKeys = {
  publicKey: string;
  privateKey: string;
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
  correctIndex: number
  explanation: string
}
type BrainDifficulty = "easy" | "normal" | "challenge"
type BrainResponse = {
  name: string
  answers: number[]
  score: number
  submittedAt: string
}
type BrainRound = {
  id: string
  schemaVersion?: number
  mode: "group" | "practice"
  difficulty: BrainDifficulty
  createdAt: string
  createdBy: string
  status: "active" | "finished"
  questions: BrainQuestion[]
  responses: Record<string, BrainResponse>
}

type GroupActivityKind = "shiritori" | "association" | "memory"
type GroupActivityEntry = {
  name: string
  text: string
  createdAt: string
}
type GroupActivity = {
  id: string
  kind: GroupActivityKind
  participants: string[]
  turnIndex: number
  status: "active" | "finished"
  createdAt: string
  createdBy: string
  prompt: string
  entries: GroupActivityEntry[]
}

type PuzzleSession = {
  id: string;
  kind: "nine-puzzle";
  participants: string[];
  turnIndex: number;
  status: "active" | "finished";
  createdAt: string;
  createdBy: string;
  prompt: string;
  entries: [];
  board: number[];
  moves: number;
};

type ProverbQuestion = {
  id: string;
  pieces: string[];
  hint: string;
};

type ProverbPuzzleSession = {
  id: string;
  kind: "proverb-puzzle";
  participants: string[];
  turnIndex: number;
  status: "active" | "finished";
  createdAt: string;
  createdBy: string;
  prompt: string;
  entries: [];
  questions: ProverbQuestion[];
  questionIndex: number;
  wordBoard: string[];
  solvedCount: number;
  moves: number;
  nextQuestionAt?: string;
  pendingQuestionIndex?: number;
  pendingTurnIndex?: number;
};

type MemoryCard = { id: string; label: string };
type MemoryMatchSession = {
  id: string;
  kind: "memory-match";
  participants: string[];
  turnIndex: number;
  status: "active" | "finished";
  createdAt: string;
  createdBy: string;
  prompt: string;
  entries: [];
  cards: MemoryCard[];
  revealedIds: string[];
  matchedIds: string[];
  lastMismatchIds: string[];
  lastMismatchAt?: string;
  nextTurnAt?: string;
  pendingTurnIndex?: number;
  matchesByName: Record<string, number>;
  attempts: number;
};

type AppSession = {
  name: string;
  expiresAt: number;
  groupIds?: string[];
};

type AppGroup = {
  id: string;
  adminNames?: string[];
  createdBy?: string;
};

type PuzzlePushDevice = {
  name: string;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
  preview: boolean;
  quietHours: boolean;
  appBadge: boolean;
};

type PuzzleVapidKeys = {
  publicKey: string;
  privateKey: string;
};


function puzzleDataKey(groupId: string) {
  return `sawakai:group:${groupId}:nine-puzzles`;
}

function proverbPuzzleDataKey(groupId: string) {
  return `sawakai:group:${groupId}:proverb-puzzles`;
}

function memoryMatchDataKey(groupId: string) {
  return `sawakai:group:${groupId}:memory-matches`;
}

function memberDataKey(groupId: string) {
  return groupId === defaultGroupId
    ? "sawakai:members"
    : `sawakai:group:${groupId}:members`;
}

async function puzzleSession(token?: string): Promise<AppSession | null> {
  if (!token) return null;
  const session = (await kv.get(`sawakai:session:${token}`)) as
    | AppSession
    | undefined;
  return session && session.expiresAt >= Date.now() ? session : null;
}

function sessionCanAccessGroup(session: AppSession, groupId: string) {
  const groupIds = session.groupIds?.length
    ? session.groupIds
    : [defaultGroupId];
  return groupIds.includes(groupId);
}

async function puzzleRequestContext(c: {
  req: { header: (name: string) => string | undefined };
}) {
  const session = await puzzleSession(c.req.header("X-Session-Token"));
  if (!session) {
    return { error: "もう一度参加してください。", status: 401 as const };
  }
  const groupId = c.req.header("X-Group-Id") || defaultGroupId;
  if (!sessionCanAccessGroup(session, groupId)) {
    return {
      error: "このグループには参加していません。",
      status: 403 as const,
    };
  }
  return { session, groupId };
}

async function puzzleIsAdmin(groupId: string, name: string) {
  const groups =
    ((await kv.get("sawakai:groups")) as AppGroup[] | undefined) ?? [];
  const group = groups.find((item) => item.id === groupId);
  return Boolean(
    group &&
      (group.adminNames?.includes(name) || group.createdBy === name),
  );
}

async function getPuzzleSessions(groupId: string): Promise<PuzzleSession[]> {
  return (
    ((await kv.get(puzzleDataKey(groupId))) as PuzzleSession[] | undefined) ??
    []
  );
}

async function getProverbPuzzleSessions(
  groupId: string,
): Promise<ProverbPuzzleSession[]> {
  return (
    ((await kv.get(proverbPuzzleDataKey(groupId))) as
      | ProverbPuzzleSession[]
      | undefined) ?? []
  );
}

async function getMemoryMatchSessions(
  groupId: string,
): Promise<MemoryMatchSession[]> {
  return (
    ((await kv.get(memoryMatchDataKey(groupId))) as
      | MemoryMatchSession[]
      | undefined) ?? []
  );
}

async function sendPuzzleInvitations(
  groupId: string,
  sender: string,
  recipientNames: Set<string>,
  game: "nine" | "proverb" | "memory-match" = "nine",
) {
  const deviceKey = `sawakai:group:${groupId}:push-devices`;
  const devices =
    ((await kv.get(deviceKey)) as PuzzlePushDevice[] | undefined) ?? [];
  const hourInJapan = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
  const targets = devices.filter(
    (device) =>
      device.name !== sender &&
      recipientNames.has(device.name) &&
      (!device.quietHours || (hourInJapan >= 8 && hourInJapan < 20)),
  );
  if (!targets.length) return 0;
  const webPushModule = await import("npm:web-push@3.6.7");
  const webPush = webPushModule.default ?? webPushModule;
  const vapidKey = "sawakai:vapid-keys";
  let vapidKeys = (await kv.get(vapidKey)) as PuzzleVapidKeys | undefined;
  if (!vapidKeys?.publicKey || !vapidKeys.privateKey) {
    vapidKeys = webPush.generateVAPIDKeys() as PuzzleVapidKeys;
    await kv.set(vapidKey, vapidKeys);
  }
  webPush.setVapidDetails(
    "mailto:notifications@ron-ai-systems.com",
    vapidKeys.publicKey,
    vapidKeys.privateKey,
  );
  const expired = new Set<string>();
  const notifiedNames = new Set<string>();
  await Promise.all(
    targets.map(async (device) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: device.endpoint,
            expirationTime: device.expirationTime,
            keys: device.keys,
          },
          JSON.stringify({
            title:
              game === "proverb"
                ? "ことわざ並べ替えのお誘い"
                : game === "memory-match"
                  ? "みんなで神経衰弱のお誘い"
                : "みんなで9マスのお誘い",
            body: device.preview
              ? game === "proverb"
                ? `${sender}さんからことわざ並べ替えのお誘いです。みんなで語句を正しい順番に並べましょう。`
                : game === "memory-match"
                  ? `${sender}さんから神経衰弱のお誘いです。みんなで同じカードを見つけましょう。`
                : `${sender}さんから9マスパズルのお誘いです。みんなで1から9まで並べましょう。`
              : "みんなの遊びへのお誘いが届きました。",
            tag: `${game}-puzzle-${groupId}`,
            url: "./",
            appBadge: device.appBadge,
          }),
        );
        notifiedNames.add(device.name);
      } catch (reason) {
        const statusCode =
          typeof reason === "object" &&
          reason !== null &&
          "statusCode" in reason
            ? Number(reason.statusCode)
            : 0;
        if (statusCode === 404 || statusCode === 410) {
          expired.add(device.endpoint);
        } else {
          console.warn("Nine-puzzle invitation could not be delivered");
        }
      }
    }),
  );
  if (expired.size) {
    await kv.set(
      deviceKey,
      devices.filter((device) => !expired.has(device.endpoint)),
    );
  }
  return notifiedNames.size;
}

function shuffledPuzzleBoard() {
  const target = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  let board = [...target];
  while (board.every((value, index) => value === target[index])) {
    board = [...target];
    for (let index = board.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [board[index], board[swapIndex]] = [board[swapIndex], board[index]];
    }
  }
  return board;
}

function puzzleComplete(board: number[]) {
  return (
    board.length === 9 &&
    board.every((value, index) => value === index + 1)
  );
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
];

function shuffledItems<T>(items: T[]) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function shuffledProverbBoard(question: ProverbQuestion) {
  let board = shuffledItems(question.pieces);
  while (
    board.length > 1 &&
    board.every((piece, index) => piece === question.pieces[index])
  ) {
    board = shuffledItems(question.pieces);
  }
  return board;
}

function proverbComplete(board: string[], question: ProverbQuestion) {
  return (
    board.length === question.pieces.length &&
    board.every((piece, index) => piece === question.pieces[index])
  );
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
];

function createMemoryCards(): MemoryCard[] {
  return shuffledItems(
    memoryCardLabels.flatMap((label, pairIndex) => [
      { id: `${pairIndex}-a-${crypto.randomUUID()}`, label },
      { id: `${pairIndex}-b-${crypto.randomUUID()}`, label },
    ]),
  );
}

const allowedAnalyticsEvents = new Set([
  "suggestion_selected",
  "free_input_opened",
  "confirmation_cancelled",
  "message_sent",
  "send_undone",
  "read_aloud",
  "text_small",
  "text_normal",
  "text_large",
  "notifications_enabled",
  "ai_retry",
  "media_sent",
  "brain_started",
  "brain_completed",
]);

const brainQuestionBank: Record<BrainDifficulty, BrainQuestion[]> = {
  easy: [
    {
      id: "easy-order",
      category: "暮らし",
      prompt: "植物の変化を早い順に並べたものはどれですか？",
      choices: ["つぼみ→花→実", "花→つぼみ→実", "実→花→つぼみ"],
      correctIndex: 0,
      explanation: "多くの植物は、つぼみから花が咲き、その後に実ができます。",
    },
    {
      id: "easy-attention",
      category: "注意",
      prompt: "数字の「2」はいくつありますか？ 2・5・2・8・2・9・2",
      choices: ["3つ", "4つ", "5つ"],
      correctIndex: 1,
      explanation: "左から数えると「2」は4つあります。",
    },
    {
      id: "easy-opposite",
      category: "ことば",
      prompt: "「増える」と反対の意味に近い言葉はどれですか？",
      choices: ["減る", "集まる", "続く"],
      correctIndex: 0,
      explanation: "増えるの反対は減るです。",
    },
    {
      id: "easy-time",
      category: "暮らし",
      prompt: "午前9時20分から40分後は何時ですか？",
      choices: ["午前9時50分", "午前10時", "午前10時20分"],
      correctIndex: 1,
      explanation: "9時20分に40分を足すと10時です。",
    },
  ],
  normal: [
    {
      id: "normal-sequence",
      category: "注意",
      prompt: "4・7・10・13と続きます。次の数字はどれですか？",
      choices: ["15", "16", "17"],
      correctIndex: 1,
      explanation: "3ずつ増えているので、13の次は16です。",
    },
    {
      id: "normal-proverb",
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
      id: "normal-shopping",
      category: "暮らし",
      prompt: "120円の品を3個買い、500円を出しました。おつりはいくらですか？",
      choices: ["120円", "140円", "160円"],
      correctIndex: 1,
      explanation: "120円×3個は360円なので、おつりは140円です。",
    },
    {
      id: "normal-word",
      category: "ことば",
      prompt: "仲間が違うものはどれですか？",
      choices: ["新聞", "雑誌", "冷蔵庫"],
      correctIndex: 2,
      explanation: "新聞と雑誌は読むものですが、冷蔵庫は家電です。",
    },
    {
      id: "normal-history-edo",
      category: "歴史",
      prompt: "江戸幕府を開いた人物は誰ですか？",
      choices: ["徳川家康", "豊臣秀吉", "織田信長"],
      correctIndex: 0,
      explanation: "徳川家康が江戸幕府を開きました。",
    },
    {
      id: "normal-history-era",
      category: "歴史",
      prompt: "江戸時代の次に始まった時代はどれですか？",
      choices: ["明治時代", "室町時代", "平安時代"],
      correctIndex: 0,
      explanation: "江戸時代の次は明治時代です。",
    },
    {
      id: "normal-history-kamakura",
      category: "歴史",
      prompt: "鎌倉幕府を開いた人物は誰ですか？",
      choices: ["源頼朝", "足利尊氏", "徳川家康"],
      correctIndex: 0,
      explanation: "源頼朝が鎌倉幕府を開きました。",
    },
    {
      id: "normal-history-kinkaku",
      category: "歴史",
      prompt: "金閣を建てたことで知られる人物は誰ですか？",
      choices: ["足利義満", "足利尊氏", "聖徳太子"],
      correctIndex: 0,
      explanation: "室町幕府3代将軍の足利義満が金閣を建てました。",
    },
    {
      id: "normal-history-meiji",
      category: "歴史",
      prompt: "明治時代に行われたものはどれですか？",
      choices: ["廃藩置県", "参勤交代", "大化の改新"],
      correctIndex: 0,
      explanation: "廃藩置県は明治時代に行われました。",
    },
    {
      id: "normal-difference",
      category: "間違い探し",
      prompt: "見本「春・夏・秋・冬」と一文字違うのはどれですか？",
      choices: ["春・夏・秋・冬", "春・夏・秌・冬", "春・夏・秋・冬"],
      correctIndex: 1,
      explanation: "2番だけ「秋」が「秌」になっています。",
    },
  ],
  challenge: [
    {
      id: "challenge-sequence",
      category: "注意",
      prompt: "1・2・4・7・11と続きます。次の数字はどれですか？",
      choices: ["15", "16", "17"],
      correctIndex: 1,
      explanation:
        "足す数が1、2、3、4と増えるため、次は5を足して16です。",
    },
    {
      id: "challenge-memory",
      category: "注意",
      prompt: "青・赤・黄・青・緑・赤。2回出てきた色の組み合わせはどれですか？",
      choices: ["青と赤", "赤と黄", "青と緑"],
      correctIndex: 0,
      explanation: "青と赤がそれぞれ2回ずつ出てきます。",
    },
    {
      id: "challenge-time",
      category: "暮らし",
      prompt: "午前9時45分から午前11時20分までは何時間何分ですか？",
      choices: ["1時間25分", "1時間35分", "1時間45分"],
      correctIndex: 1,
      explanation: "9時45分から10時45分で1時間、さらに35分です。",
    },
    {
      id: "challenge-shopping",
      category: "計算",
      prompt: "680円と240円の品を買い、1000円を出しました。おつりはいくらですか？",
      choices: ["60円", "80円", "120円"],
      correctIndex: 1,
      explanation: "合計は920円なので、おつりは80円です。",
    },
    {
      id: "challenge-history-order",
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
      id: "challenge-history-restoration",
      category: "歴史",
      prompt: "大政奉還を行った江戸幕府最後の将軍は誰ですか？",
      choices: ["徳川慶喜", "徳川家光", "徳川吉宗"],
      correctIndex: 0,
      explanation: "第15代将軍の徳川慶喜が大政奉還を行いました。",
    },
    {
      id: "challenge-difference",
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
      id: "challenge-history-period",
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
      id: "challenge-history-onin",
      category: "歴史",
      prompt: "応仁の乱が起きた時代はどれですか？",
      choices: ["室町時代", "鎌倉時代", "江戸時代"],
      correctIndex: 0,
      explanation: "応仁の乱は室町時代に起きました。",
    },
    {
      id: "challenge-history-reform",
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
}

const safetyBrainQuestionBank: BrainQuestion[] = [
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
  { id: "common-food", category: "一般常識", prompt: "冷凍食品を買った後の扱いで適切なのはどれですか？", choices: ["なるべく早く冷凍庫へ入れる", "長時間常温に置く", "暖かい場所に置く"], correctIndex: 0, explanation: "品質と安全を保つため、持ち帰ったら早めに冷凍庫へ入れます。" },
  { id: "common-password", category: "一般常識", prompt: "パスワード管理で安全なのはどれですか？", choices: ["他人に教えず使い回しを避ける", "全て同じにする", "玄関に貼る"], correctIndex: 0, explanation: "推測されにくいパスワードを使い、サービスごとの使い回しを避けます。" },
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

const shapeQuestionBank: Record<BrainDifficulty, BrainQuestion[]> = {
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
      explanation: "右列を三角と丸にすると、縦横で同じ図形が重なりません。",
    },
  ],
}

const differencePairs = {
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
} as const

function createDifferenceQuestion(
  difficulty: "normal" | "challenge",
  playIndex: number,
): BrainQuestion {
  const pairs = differencePairs[difficulty]
  const [original, changed] = pairs[playIndex % pairs.length]
  return {
    id: crypto.randomUUID(),
    category: "間違い探し",
    prompt: `見本「${original}」と一文字違うのはどれですか？`,
    choices: [original, changed, original],
    correctIndex: 1,
    explanation: `2番だけが見本の「${original}」と一文字違います。`,
  }
}

function createEasyAttentionQuestion(playIndex: number): BrainQuestion {
  const digits = ["1", "2", "3", "4", "5"]
  const target = digits[playIndex % digits.length]
  const length = 7 + (playIndex % 4)
  const sequence = Array.from(
    { length },
    (_, index) => digits[(index * 2 + playIndex) % digits.length],
  )
  const count = sequence.filter((digit) => digit === target).length
  return {
    id: crypto.randomUUID(),
    category: "注意",
    prompt: `次の並びに「${target}」はいくつありますか？ ${sequence.join("・")}`,
    choices: [
      `${Math.max(0, count - 1)}個`,
      `${count}個`,
      `${count + 1}個`,
    ],
    correctIndex: 1,
    explanation: `「${target}」は${count}個あります。`,
  }
}

function createShapeQuestion(
  difficulty: BrainDifficulty,
  playIndex: number,
): BrainQuestion {
  const symbols = ["○", "△", "□", "☆", "◇"]
  const target = symbols[playIndex % symbols.length]
  const length =
    difficulty === "challenge"
      ? 13 + (playIndex % 4)
      : difficulty === "normal"
        ? 9 + (playIndex % 3)
        : 6 + (playIndex % 3)
  const sequence = Array.from(
    { length },
    (_, index) =>
      symbols[
        (index *
            (difficulty === "challenge"
              ? 3
              : difficulty === "normal"
                ? 2
                : 1) +
          playIndex) %
          symbols.length
      ],
  )
  const count = sequence.filter((symbol) => symbol === target).length
  return {
    id: crypto.randomUUID(),
    category: "図形",
    prompt: `次の並びに「${target}」はいくつありますか？ ${sequence.join("・")}`,
    choices: [
      `${Math.max(0, count - 1)}個`,
      `${count}個`,
      `${count + 1}個`,
    ],
    correctIndex: 1,
    explanation: `左から確認すると「${target}」は${count}個あります。`,
  }
}

const supabase = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
let mediaBucketReady = false;

async function ensureMediaBucket() {
  if (mediaBucketReady) return;
  const client = supabase();
  const { data } = await client.storage.getBucket(mediaBucket);
  if (!data) {
    const { error } = await client.storage.createBucket(mediaBucket, {
      public: false,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: ["image/webp", "image/jpeg", "image/png", "video/mp4", "video/webm"],
    });
    if (error && !error.message.toLowerCase().includes("already exists")) {
      throw error;
    }
  }
  mediaBucketReady = true;
}

const initialMessages: Message[] = [
  {
    id: "seed-1",
    sender: "さくら",
    text: "土曜なら行けるよ！",
    createdAt: "2025-01-01T09:38:00+09:00",
    avatar: "mint",
  },
  {
    id: "seed-2",
    sender: "奈々",
    text: "私も土曜なら大丈夫！",
    createdAt: "2025-01-01T09:40:00+09:00",
    avatar: "peach",
  },
  {
    id: "seed-3",
    sender: "大輔",
    text: "土曜なら私も行くね。",
    createdAt: "2025-01-01T09:41:00+09:00",
    avatar: "sand",
  },
];

app.use("*", logger(console.log));
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Session-Token",
      "X-Group-Id",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

async function getSession(token?: string): Promise<Session | null> {
  if (!token) return null;
  const session = (await kv.get(`sawakai:session:${token}`)) as
    | Session
    | undefined;
  return session && session.expiresAt >= Date.now() ? session : null;
}

function dataKey(groupId: string, type: string): string {
  if (groupId === defaultGroupId) {
    const legacy: Record<string, string> = {
      messages: "sawakai:messages",
      members: "sawakai:members",
      analytics: "sawakai:analytics",
    };
    if (legacy[type]) return legacy[type];
  }
  return `sawakai:group:${groupId}:${type}`;
}

async function getGroups(): Promise<Group[]> {
  const stored = (await kv.get(groupsKey)) as Group[] | undefined;
  if (stored) {
    const migrated = stored.map((group) =>
      group.id === defaultGroupId &&
      (group.name === "週末のごはん会" ||
        group.name === "週末のご飯会" ||
        group.name === "茶話会チャット" ||
        group.name === "茶話会・みんなで能脳活" ||
        group.name === "茶話会・もんなで能活")
        ? { ...group, name: "茶話会・みんなで脳活" }
        : group,
    );
    if (migrated.some((group, index) => group.name !== stored[index].name)) {
      await kv.set(groupsKey, migrated);
    }
    return migrated;
  }
  const name =
    ((await kv.get("sawakai:group-name")) as string | undefined) ??
    "茶話会・みんなで脳活";
  const inviteCode =
    ((await kv.get("sawakai:invite-code")) as string | undefined) ??
    defaultInviteCode;
  const groups: Group[] = [
    {
      id: defaultGroupId,
      name,
      inviteCode,
      createdAt: new Date().toISOString(),
      adminNames: [],
      createdBy: undefined,
    },
  ];
  await kv.set(groupsKey, groups);
  return groups;
}

async function updateGroup(groupId: string, patch: Partial<Group>) {
  const groups = await getGroups();
  const next = groups.map((group) =>
    group.id === groupId ? { ...group, ...patch } : group,
  );
  await kv.set(groupsKey, next);
  return next.find((group) => group.id === groupId);
}

async function getWebPush() {
  const module = await import("npm:web-push@3.6.7");
  return module.default ?? module;
}

async function getVapidKeys(): Promise<VapidKeys> {
  const key = "sawakai:vapid-keys";
  const stored = (await kv.get(key)) as VapidKeys | undefined;
  if (stored?.publicKey && stored.privateKey) return stored;
  const webPush = await getWebPush();
  const generated = webPush.generateVAPIDKeys() as VapidKeys;
  await kv.set(key, generated);
  return generated;
}

async function getPushDevices(groupId: string): Promise<PushDevice[]> {
  return (
    ((await kv.get(dataKey(groupId, "push-devices"))) as
      | PushDevice[]
      | undefined) ?? []
  );
}

type PushNotificationOptions = {
  recipientNames?: Set<string>;
  title?: string;
  body?: string;
  tag?: string;
};

async function sendPushNotifications(
  groupId: string,
  sender: string,
  text: string,
  hasAttachment = false,
  options: PushNotificationOptions = {},
) {
  const devices = (await getPushDevices(groupId)).filter(
    (device) =>
      device.name !== sender &&
      (!options.recipientNames || options.recipientNames.has(device.name)),
  );
  if (!devices.length) return { notifiedCount: 0, deviceCount: 0 };
  const hourInJapan = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
  const activeDevices = devices.filter(
    (device) =>
      !device.quietHours || (hourInJapan >= 8 && hourInJapan < 20),
  );
  if (!activeDevices.length) return { notifiedCount: 0, deviceCount: 0 };
  const group = (await getGroups()).find((item) => item.id === groupId);
  const vapidKeys = await getVapidKeys();
  const webPush = await getWebPush();
  webPush.setVapidDetails(
    "mailto:notifications@ron-ai-systems.com",
    vapidKeys.publicKey,
    vapidKeys.privateKey,
  );
  const expired = new Set<string>();
  const notifiedNames = new Set<string>();
  await Promise.all(
    activeDevices.map(async (device) => {
      const body = device.preview
        ? options.body ??
          (hasAttachment
            ? `${sender}さんからファイルが届きました。`
            : `${sender}さん: ${text}`)
        : options.body
          ? "みんなの遊びへのお誘いが届きました。"
          : "新しいメッセージが届きました。";
      try {
        await webPush.sendNotification(
          {
            endpoint: device.endpoint,
            expirationTime: device.expirationTime,
            keys: device.keys,
          },
          JSON.stringify({
            title:
              options.title ?? group?.name ?? "茶話会・みんなで脳活",
            body,
            tag: options.tag ?? `group-${groupId}`,
            url: "./",
            appBadge: device.appBadge,
          }),
        );
        notifiedNames.add(device.name);
      } catch (reason) {
        const statusCode =
          typeof reason === "object" &&
          reason !== null &&
          "statusCode" in reason
            ? Number(reason.statusCode)
            : 0;
        if (statusCode === 404 || statusCode === 410) {
          expired.add(device.endpoint);
        } else {
          console.warn("Push notification could not be delivered");
        }
      }
    }),
  );
  if (expired.size) {
    await kv.set(
      dataKey(groupId, "push-devices"),
      devices.filter((device) => !expired.has(device.endpoint)),
    );
  }
  return {
    notifiedCount: notifiedNames.size,
    deviceCount: activeDevices.length - expired.size,
  };
}

async function getGroupWithImage(group: Group): Promise<Group> {
  if (!group.image?.path) return group;
  const refreshBefore = Date.now() + 60 * 60 * 1000;
  if (
    group.image.signedUrl &&
    group.image.signedUntil &&
    new Date(group.image.signedUntil).getTime() > refreshBefore
  ) {
    return group;
  }
  await ensureMediaBucket();
  const { data, error } = await supabase()
    .storage.from(mediaBucket)
    .createSignedUrl(group.image.path, 24 * 60 * 60);
  if (error || !data?.signedUrl) return group;
  const next = {
    ...group,
    image: {
      ...group.image,
      signedUrl: data.signedUrl,
      signedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };
  await updateGroup(group.id, { image: next.image });
  return next;
}

function sessionGroupIds(session: Session): string[] {
  return session.groupIds?.length ? session.groupIds : [defaultGroupId];
}

async function requestedGroupId(
  header: string | undefined,
  session: Session,
): Promise<string | null> {
  const groupId = header || sessionGroupIds(session)[0];
  if (!sessionGroupIds(session).includes(groupId)) return null;
  if (!(await getGroups()).some((group) => group.id === groupId)) return null;
  const members = await getMembers(groupId);
  return members.some((member) => member.name === session.name) ? groupId : null;
}

async function groupWithAdmin(groupId: string, name: string): Promise<Group | null> {
  const group = (await getGroups()).find((item) => item.id === groupId);
  if (!group) return null;
  if (!group.adminNames?.length || !group.createdBy) {
    return (
      (await updateGroup(groupId, {
        adminNames: group.adminNames?.length ? group.adminNames : [name],
        createdBy: group.createdBy ?? name,
      })) ?? null
    );
  }
  return group;
}

function isGroupAdmin(group: Group, name: string): boolean {
  return group.adminNames?.includes(name) ?? false;
}

async function getMessages(groupId: string): Promise<Message[]> {
  const key = dataKey(groupId, "messages");
  const messages = (await kv.get(key)) as Message[] | undefined;
  if (messages) return messages;
  const seed = groupId === defaultGroupId ? initialMessages : [];
  await kv.set(key, seed);
  return seed;
}

async function deleteMediaPaths(paths: string[]): Promise<boolean> {
  if (!paths.length) return true;
  try {
    await ensureMediaBucket();
    await supabase().storage.from(mediaBucket).remove(paths);
    return true;
  } catch {
    console.warn("Expired media cleanup could not be completed");
    return false;
  }
}

async function storeMessages(groupId: string, messages: Message[]) {
  const retained = messages.slice(-messageLimit);
  const removed = messages.slice(0, Math.max(0, messages.length - messageLimit));
  const mediaPaths = removed.flatMap((message) =>
    message.attachment?.path ? [message.attachment.path] : [],
  );
  const mediaDeleted = await deleteMediaPaths(mediaPaths);
  await kv.set(
    dataKey(groupId, "messages"),
    mediaDeleted ? retained : messages,
  );
}

async function cleanupGroupMessages(groupId: string, now: number) {
  const messages = await getMessages(groupId);
  const retainedByAge = messages.filter((message) => {
    const createdAt = new Date(message.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return true;
    const retention =
      message.kind === "system" || message.attachment
        ? shortRetentionMs
        : messageRetentionMs;
    return now - createdAt < retention;
  });
  const retained = retainedByAge.slice(-messageLimit);
  const retainedIds = new Set(retained.map((message) => message.id));
  const removed = messages.filter((message) => !retainedIds.has(message.id));
  const mediaPaths = removed.flatMap((message) =>
    message.attachment?.path ? [message.attachment.path] : [],
  );
  if (!(await deleteMediaPaths(mediaPaths))) return { messages: 0, media: 0 };
  if (removed.length) {
    await kv.set(dataKey(groupId, "messages"), retained);
  }
  return { messages: removed.length, media: mediaPaths.length };
}

async function runRetentionCleanup(force = false) {
  const now = Date.now();
  const lastCleanup =
    ((await kv.get(retentionCleanupKey)) as number | undefined) ?? 0;
  if (!force && now - lastCleanup < dayMs) {
    return { skipped: true, messages: 0, media: 0 };
  }
  let deletedMessages = 0;
  let deletedMedia = 0;
  for (const group of await getGroups()) {
    const deleted = await cleanupGroupMessages(group.id, now);
    deletedMessages += deleted.messages;
    deletedMedia += deleted.media;
  }
  await kv.set(retentionCleanupKey, now);
  return {
    skipped: false,
    messages: deletedMessages,
    media: deletedMedia,
  };
}

async function getMessagesWithMedia(
  groupId: string,
  sourceMessages?: Message[],
): Promise<Message[]> {
  const messages = sourceMessages ?? (await getMessages(groupId));
  const refreshBefore = Date.now() + 60 * 60 * 1000;
  const needsRefresh = messages.some(
    (message) =>
      message.attachment &&
      (!message.attachment.signedUntil ||
        new Date(message.attachment.signedUntil).getTime() < refreshBefore),
  );
  if (!needsRefresh) return messages;

  await ensureMediaBucket();
  const client = supabase();
  const next = await Promise.all(
    messages.map(async (message) => {
      if (!message.attachment) return message;
      const { data, error } = await client.storage
        .from(mediaBucket)
        .createSignedUrl(message.attachment.path, 24 * 60 * 60);
      if (error || !data?.signedUrl) return message;
      return {
        ...message,
        attachment: {
          ...message.attachment,
          signedUrl: data.signedUrl,
          signedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      };
    }),
  );
  if (!sourceMessages) {
    await kv.set(dataKey(groupId, "messages"), next);
  }
  return next;
}

async function getMembers(groupId: string): Promise<Member[]> {
  const key = dataKey(groupId, "members");
  const stored = (await kv.get(key)) as Member[] | undefined;
  if (stored) return stored;
  const now = new Date().toISOString();
  const members: Member[] =
    groupId === defaultGroupId
      ? ["さくら", "奈々", "大輔"].map((name) => ({
          name,
          joinedAt: now,
          lastSeenAt: now,
          avatar: avatarFor(name),
        }))
      : [];
  await kv.set(key, members);
  return members;
}

async function touchMember(groupId: string, name: string): Promise<Member[]> {
  const members = await getMembers(groupId);
  const now = new Date().toISOString();
  const existing = members.find((member) => member.name === name);
  const next = existing
    ? members.map((member) =>
        member.name === name ? { ...member, lastSeenAt: now } : member,
      )
    : [
        ...members,
        { name, joinedAt: now, lastSeenAt: now, avatar: avatarFor(name) },
      ];
  await kv.set(dataKey(groupId, "members"), next);
  return next;
}

async function getMembersWithImages(groupId: string): Promise<Member[]> {
  const members = await getMembers(groupId);
  if (!members.some((member) => member.avatarImage?.path)) return members;
  await ensureMediaBucket();
  const client = supabase();
  const refreshBefore = Date.now() + 60 * 60 * 1000;
  const next = await Promise.all(
    members.map(async (member) => {
      if (
        !member.avatarImage?.path ||
        (member.avatarImage.signedUrl &&
          member.avatarImage.signedUntil &&
          new Date(member.avatarImage.signedUntil).getTime() > refreshBefore)
      ) {
        return member;
      }
      const { data, error } = await client.storage
        .from(mediaBucket)
        .createSignedUrl(member.avatarImage.path, 24 * 60 * 60);
      if (error || !data?.signedUrl) return member;
      return {
        ...member,
        avatarImage: {
          ...member.avatarImage,
          signedUrl: data.signedUrl,
          signedUntil: new Date(
            Date.now() + 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      };
    }),
  );
  await kv.set(dataKey(groupId, "members"), next);
  return next;
}

function avatarFor(name: string): Message["avatar"] {
  const colors: Message["avatar"][] = ["mint", "peach", "sand"];
  const total = Array.from(name).reduce(
    (sum, character) => sum + (character.codePointAt(0) || 0),
    0,
  );
  return colors[total % colors.length];
}

function parseReplies(raw: unknown): string[] {
  if (typeof raw !== "string") return [];

  const parseObject = (value: string) => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed?.replies) ? parsed.replies : [];
    } catch {
      return [];
    }
  };

  let replies = parseObject(raw);
  if (!replies.length) {
    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (objectMatch) replies = parseObject(objectMatch[0]);
  }
  if (!replies.length) {
    replies = raw
      .replace(/```(?:json)?/gi, "")
      .split("\n")
      .map((line) =>
        line
          .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
          .replace(/^["']|["']$/g, "")
          .trim(),
      )
      .filter(
        (line) =>
          line.length > 0 &&
          line.length <= 40 &&
          !/^here (?:is|are)/i.test(line) &&
          !/^(?:replies|reply|json)\s*:/i.test(line),
      );
  }

  return replies
    .filter((reply: unknown) => typeof reply === "string")
    .map((reply: string) => reply.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 2);
}

async function getBrainRounds(groupId: string): Promise<BrainRound[]> {
  return (
    (await kv.get(
      dataKey(groupId, "brain-rounds"),
    )) as BrainRound[] | undefined ?? []
  )
}

function hasValidBrainQuestions(round: BrainRound): boolean {
  return (
    round.schemaVersion === 3 &&
    round.questions.length === 5 &&
    round.questions.every(
      (question) =>
        Array.isArray(question.choices) &&
        question.choices.length === 3 &&
        question.choices.every(
          (choice) => typeof choice === "string" && choice.trim().length > 0,
        ) &&
        Number.isInteger(question.correctIndex) &&
        question.correctIndex >= 0 &&
        question.correctIndex < 3,
    )
  )
}

function todayInJapan(value = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value)
}

async function getGroupActivities(groupId: string): Promise<GroupActivity[]> {
  return (
    (await kv.get(
      dataKey(groupId, "activities"),
    )) as GroupActivity[] | undefined ?? []
  )
}

function normalizeJapaneseWord(value: string): string {
  return value
    .trim()
    .replace(/[、。・\s！？!?]/g, "")
    .replace(/[ァ-ヶ]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0x60),
    )
    .replace(/[ゃゅょぁぃぅぇぉっ]/g, (character) => {
      const map: Record<string, string> = {
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
      return map[character] ?? character
    })
}

function lastShiritoriCharacter(value: string): string {
  const normalized = normalizeJapaneseWord(value)
  if (normalized.endsWith("ー") && normalized.length > 1) {
    return normalized.at(-2) ?? ""
  }
  return normalized.at(-1) ?? ""
}

function normalizeAssociationWord(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toLocaleLowerCase("ja")
}

function parseBrainQuestions(raw: unknown): BrainQuestion[] {
  if (typeof raw !== "string") return []
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match?.[0] ?? raw)
    if (!Array.isArray(parsed.questions)) return []
    return parsed.questions
      .filter(
        (question: Partial<BrainQuestion>) =>
          [
            "ことば",
            "計算",
            "注意",
            "暮らし",
            "図形",
            "歴史",
            "間違い探し",
            "一般常識",
            "防災",
            "健康",
            "防犯",
            "交通",
          ].includes(question.category ?? "") &&
          typeof question.prompt === "string" &&
          question.prompt.length >= 4 &&
          question.prompt.length <= 100 &&
          Array.isArray(question.choices) &&
          question.choices.length === 3 &&
          question.choices.every(
            (choice) => typeof choice === "string" && choice.length <= 40,
          ) &&
          Number.isInteger(question.correctIndex) &&
          Number(question.correctIndex) >= 0 &&
          Number(question.correctIndex) <= 2 &&
          typeof question.explanation === "string",
      )
      .slice(0, 5)
      .map((question: BrainQuestion) => ({
        ...question,
        id: crypto.randomUUID(),
        prompt: question.prompt.trim(),
        choices: question.choices.map((choice) => choice.trim()),
        explanation: question.explanation.trim().slice(0, 100),
      }))
  } catch {
    return []
  }
}

function fallbackBrainQuestions(
  usedPrompts: Set<string>,
  difficulty: BrainDifficulty,
  roundIndex = Math.floor(usedPrompts.size / 5),
): BrainQuestion[] {
  const playIndex = roundIndex
  const ranges = {
    easy: { first: 12, firstRange: 24, second: 4, secondRange: 15 },
    normal: { first: 25, firstRange: 45, second: 12, secondRange: 30 },
    challenge: { first: 6, firstRange: 7, second: 4, secondRange: 6 },
  }
  const range = ranges[difficulty]
  const firstStride = difficulty === "challenge" ? 3 : 7
  const secondStride = difficulty === "challenge" ? 5 : 11
  const first =
    range.first + ((playIndex * firstStride + 3) % range.firstRange)
  const second =
    range.second + ((playIndex * secondStride + 2) % range.secondRange)
  const total =
    difficulty === "challenge"
      ? first * second + first
      : difficulty === "normal"
        ? first + second - 10
        : first + second
  const difference =
    difficulty === "challenge" ? first : difficulty === "normal" ? 5 : 3
  const rawChoices = [
    total,
    total + difference,
    Math.max(1, total - difference),
  ]
  const choices = rawChoices
    .map((value) => ({ value: String(value), order: Math.random() }))
    .sort((a, b) => a.order - b.order)
    .map((item) => item.value)
  const calculation: BrainQuestion = {
    id: crypto.randomUUID(),
    category: "計算",
    prompt:
      difficulty === "challenge"
        ? `${first} × ${second} + ${first} はいくつですか？`
        : difficulty === "normal"
          ? `${first} + ${second} - 10 はいくつですか？`
          : `${first} + ${second} はいくつですか？`,
    choices,
    correctIndex: choices.indexOf(String(total)),
    explanation:
      difficulty === "challenge"
        ? `${first}×${second}を計算し、さらに${first}を足すと${total}です。`
        : difficulty === "normal"
          ? `${first}と${second}を足して10を引くと${total}です。`
          : `${first}に${second}を足すと${total}です。`,
  }
  const shape = createShapeQuestion(difficulty, playIndex)
  const historyQuestions = brainQuestionBank[difficulty].filter(
    (question) => question.category === "歴史",
  )
  const selected =
    difficulty === "easy"
      ? createEasyAttentionQuestion(playIndex)
      : playIndex % 2 === 0
      ? createDifferenceQuestion(difficulty, Math.floor(playIndex / 2))
      : historyQuestions.length
        ? historyQuestions[Math.floor(playIndex / 2) % historyQuestions.length]
        : brainQuestionBank[difficulty][
            playIndex % brainQuestionBank[difficulty].length
          ]
  const varied = [{ ...selected, id: crypto.randomUUID() }]
  const safetyQuestions = [
    safetyBrainQuestionBank[(playIndex * 2) % safetyBrainQuestionBank.length],
    safetyBrainQuestionBank[(playIndex * 2 + 5) % safetyBrainQuestionBank.length],
  ].map((question) => ({ ...question, id: crypto.randomUUID() }))
  return difficulty === "easy"
    ? [calculation, shape, ...varied, ...safetyQuestions]
    : [...varied, calculation, shape, ...safetyQuestions]
}

async function generateBrainQuestions(
  usedPrompts: Set<string>,
  difficulty: BrainDifficulty,
  roundIndex: number,
): Promise<{
  questions: BrainQuestion[];
  source: "gemini" | "fallback";
}> {
  const apiKey = Deno.env.get("GEMINI_API_KEY")
  const useAi = Deno.env.get("BRAIN_USE_AI") === "true"
  if (!apiKey || !useAi) {
    return {
      questions: fallbackBrainQuestions(usedPrompts, difficulty, roundIndex),
      source: "fallback",
    }
  }

  const recent = [...usedPrompts].slice(-50)
  const difficultyInstruction = {
    easy:
      "やさしい：答えがすぐ見えすぎない身近な題材を使い、2桁と1桁の計算や簡単な順序問題を含めてください。",
    normal:
      "ふつう：加減算を組み合わせた二段階計算、規則性、日本史の基礎、よく見比べる文字の間違い探しなど、少し考えごたえのある内容にしてください。",
    challenge:
      "チャレンジ：複合計算、時代や出来事の順序を問う日本史、長い文字列の間違い探し、複数条件を使う注意問題など、十分に考えごたえのある内容にしてください。",
  }[difficulty]
  const requestBody = {
    systemInstruction: {
      parts: [
        {
          text: "高齢者を含む大人が楽しく取り組める脳活クイズを作ります。医療効果や能力を判定する表現、なぞなぞ、ひっかけ、極端に専門的な知識、暗い話題、絵文字は避けてください。歴史は一般的な日本史の人物・時代・出来事から出題してください。間違い探しは画像を使わず、見本と文字列を見比べて一文字の違いを探す形式にしてください。日本語は短く明快にし、必ず正解が一つだけの3択にしてください。",
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
          text: `5問を作成してください。難しさは「${difficultyInstruction}」です。必ず1問は「図形」にし、2問は「一般常識・防災・健康・防犯・交通」から異なる題材を選んでください。オレオレ詐欺、災害時の行動、病気の緊急症状、交通ルールなど、日常の注意喚起に役立つ内容を含めてください。残り2問は、ことば・計算・注意・暮らし・歴史・間違い探しから混ぜてください。次の問題文とは重複させないでください。\n${recent.join("\n") || "（まだありません）"}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          questions: {
            type: "ARRAY",
            minItems: 5,
            maxItems: 5,
            items: {
              type: "OBJECT",
              properties: {
                category: {
                  type: "STRING",
                  enum: [
                    "ことば",
                    "計算",
                    "注意",
                    "暮らし",
                    "図形",
                    "歴史",
                    "間違い探し",
                    "一般常識",
                    "防災",
                    "健康",
                    "防犯",
                    "交通",
                  ],
                },
                prompt: { type: "STRING" },
                choices: {
                  type: "ARRAY",
                  minItems: 3,
                  maxItems: 3,
                  items: { type: "STRING" },
                },
                correctIndex: { type: "INTEGER" },
                explanation: { type: "STRING" },
              },
              required: [
                "category",
                "prompt",
                "choices",
                "correctIndex",
                "explanation",
              ],
            },
          },
        },
        required: ["questions"],
      },
    },
  }

  try {
    const configuredModel =
      Deno.env.get("GEMINI_MODEL") || "models/gemini-2.0-flash"
    const preferredModel = configuredModel.startsWith("models/")
      ? configuredModel
      : `models/${configuredModel}`
    const modelsResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    )
    const modelsResult = modelsResponse.ok
      ? await modelsResponse.json()
      : { models: [] }
    const availableModels = Array.isArray(modelsResult.models)
      ? modelsResult.models
          .filter(
            (model: {
              name?: string
              supportedGenerationMethods?: string[]
            }) =>
              typeof model.name === "string" &&
              model.name.includes("flash") &&
              !model.name.includes("image") &&
              !model.name.includes("live") &&
              !model.name.includes("tts") &&
              model.supportedGenerationMethods?.includes("generateContent"),
          )
          .map((model: { name: string }) => model.name)
      : []
    const candidates = [...new Set([preferredModel, ...availableModels])]

    for (const model of candidates) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        },
      )
      if (!response.ok) continue
      const result = await response.json()
      const questions = parseBrainQuestions(
        result?.candidates?.[0]?.content?.parts?.[0]?.text,
      )
      if (
        questions.length === 5 &&
        questions.some((question) => question.category === "図形") &&
        questions.filter((question) =>
          ["一般常識", "防災", "健康", "防犯", "交通"].includes(
            question.category,
          ),
        ).length >= 2 &&
        (difficulty === "easy" ||
          questions.some(
            (question) =>
              question.category === "歴史" ||
              question.category === "間違い探し",
          )) &&
        questions.every((question) => !usedPrompts.has(question.prompt))
      ) {
        const orderedQuestions =
          difficulty === "easy"
            ? questions
            : [...questions].sort((a, b) => {
                const aAdvanced =
                  a.category === "歴史" || a.category === "間違い探し"
                const bAdvanced =
                  b.category === "歴史" || b.category === "間違い探し"
                return Number(bAdvanced) - Number(aAdvanced)
              })
        return { questions: orderedQuestions, source: "gemini" }
      }
    }
  } catch {
    console.warn("Gemini unavailable; using fallback brain questions")
  }
  return {
    questions: fallbackBrainQuestions(usedPrompts, difficulty, roundIndex),
    source: "fallback",
  }
}

function publicRound(round: BrainRound, name: string) {
  return {
    id: round.id,
    schemaVersion: round.schemaVersion,
    mode: round.mode,
    difficulty: round.difficulty ?? "normal",
    createdAt: round.createdAt,
    createdBy: round.createdBy,
    status: round.status,
    answered: Boolean(round.responses[name]),
    questions: round.questions.map(
      ({
        correctIndex: _correctIndex,
        explanation: _explanation,
        ...question
      }) => question,
    ),
  }
}

app.get(`${root}/health`, (c) =>
  c.json({ status: "ok", version: 37, service: "sawakai" }),
);

app.post(`${root}/maintenance/cleanup`, async (c) => {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authorization = c.req.header("Authorization") ?? "";
  if (!serviceRoleKey || authorization !== `Bearer ${serviceRoleKey}`) {
    return c.json({ error: "この操作は許可されていません。" }, 403);
  }
  return c.json(await runRetentionCleanup(true));
});

app.post(`${root}/join`, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const code =
    typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";

  const group = (await getGroups()).find(
    (candidate) => candidate.inviteCode.toLowerCase() === code.toLowerCase(),
  );
  if (!group) {
    return c.json({ error: "招待コードが違います。" }, 403);
  }
  if (!name || name.length > 12) {
    return c.json({ error: "表示名は1〜12文字で入力してください。" }, 400);
  }

  const token = crypto.randomUUID();
  await kv.set(`sawakai:session:${token}`, {
    name,
    expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
    groupIds: [group.id],
  });
  await touchMember(group.id, name);
  return c.json({ token, user: { name }, activeGroupId: group.id });
});

app.post(`${root}/profile/image`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403);
  }
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "参加者画像を選んでください。" }, 400);
  }
  if (!["image/webp", "image/jpeg", "image/png"].includes(file.type)) {
    return c.json({ error: "JPEG、PNG、WebP画像を選んでください。" }, 415);
  }
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: "参加者画像は2MB以下にしてください。" }, 413);
  }
  await ensureMediaBucket();
  const extension =
    file.type === "image/webp" ? "webp" : file.type === "image/png" ? "png" : "jpg";
  const path = `${groupId}/profiles/${crypto.randomUUID()}.${extension}`;
  const client = supabase();
  const { error: uploadError } = await client.storage
    .from(mediaBucket)
    .upload(path, await file.arrayBuffer(), {
      contentType: file.type,
      cacheControl: "86400",
      upsert: false,
    });
  if (uploadError) {
    return c.json({ error: "参加者画像を保存できませんでした。" }, 502);
  }
  const members = await getMembers(groupId);
  const previous = members.find((member) => member.name === session.name);
  const { data: signed } = await client.storage
    .from(mediaBucket)
    .createSignedUrl(path, 24 * 60 * 60);
  const imageUrl = signed?.signedUrl;
  const next = members.map((member) =>
    member.name === session.name
      ? {
          ...member,
          avatarImage: {
            path,
            signedUrl: imageUrl,
            signedUntil: new Date(
              Date.now() + 24 * 60 * 60 * 1000,
            ).toISOString(),
          },
        }
      : member,
  );
  await kv.set(dataKey(groupId, "members"), next);
  if (previous?.avatarImage?.path) {
    await client.storage.from(mediaBucket).remove([previous.avatarImage.path]);
  }
  return c.json({ imageUrl });
});

app.post(`${root}/profile/image/delete`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403);
  }
  const members = await getMembers(groupId);
  const member = members.find((item) => item.name === session.name);
  await kv.set(
    dataKey(groupId, "members"),
    members.map((item) =>
      item.name === session.name ? { ...item, avatarImage: undefined } : item,
    ),
  );
  if (member?.avatarImage?.path) {
    await ensureMediaBucket();
    await supabase().storage.from(mediaBucket).remove([member.avatarImage.path]);
  }
  return c.json({ deleted: true });
});

app.get(`${root}/messages`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);
  await runRetentionCleanup().catch(() =>
    console.warn("Scheduled retention cleanup could not be completed"),
  );
  const allMessages = await getMessages(groupId);
  const requestedLimit = Number(c.req.query("limit") ?? 30);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(50, Math.max(1, requestedLimit))
    : 30;
  const before = c.req.query("before");
  const beforeIndex = before
    ? allMessages.findIndex((message) => message.id === before)
    : allMessages.length;
  const endIndex = beforeIndex >= 0 ? beforeIndex : allMessages.length;
  const startIndex = Math.max(0, endIndex - limit);
  const page = allMessages.slice(startIndex, endIndex);
  const member = (await getMembersWithImages(groupId)).find(
    (item) => item.name === session.name,
  );
  return c.json({
    messages: await getMessagesWithMedia(groupId, page),
    hasMore: startIndex > 0,
    nextCursor: page.at(0)?.id ?? null,
    user: { name: session.name, imageUrl: member?.avatarImage?.signedUrl },
  });
});

app.get(`${root}/group`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);
  const storedGroup = await groupWithAdmin(groupId, session.name);
  const group = storedGroup ? await getGroupWithImage(storedGroup) : null;
  if (!group) return c.json({ error: "グループが見つかりません。" }, 404);
  await touchMember(groupId, session.name);
  const members = await getMembersWithImages(groupId);
  return c.json({
    id: group.id,
    name: group.name,
    imageUrl: group.image?.signedUrl,
    inviteCode: group.inviteCode,
    isAdmin: isGroupAdmin(group, session.name),
    canDelete: isGroupAdmin(group, session.name),
    members: members.map((member) => ({
      name: member.name,
      joinedAt: member.joinedAt,
      lastSeenAt: member.lastSeenAt,
      avatar: member.avatar,
      imageUrl: member.avatarImage?.signedUrl,
      isAdmin: isGroupAdmin(group, member.name),
    })),
  });
});

app.post(`${root}/group/image`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403);
  }
  const group = await groupWithAdmin(groupId, session.name);
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが変更できます。" }, 403);
  }
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "茶話会画像を選んでください。" }, 400);
  }
  if (!["image/webp", "image/jpeg", "image/png"].includes(file.type)) {
    return c.json({ error: "JPEG、PNG、WebP画像を選んでください。" }, 415);
  }
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: "茶話会画像は2MB以下にしてください。" }, 413);
  }
  await ensureMediaBucket();
  const extension =
    file.type === "image/webp" ? "webp" : file.type === "image/png" ? "png" : "jpg";
  const path = `${groupId}/group/${crypto.randomUUID()}.${extension}`;
  const client = supabase();
  const { error: uploadError } = await client.storage
    .from(mediaBucket)
    .upload(path, await file.arrayBuffer(), {
      contentType: file.type,
      cacheControl: "86400",
      upsert: false,
    });
  if (uploadError) {
    return c.json({ error: "茶話会画像を保存できませんでした。" }, 502);
  }
  const { data: signed } = await client.storage
    .from(mediaBucket)
    .createSignedUrl(path, 24 * 60 * 60);
  const imageUrl = signed?.signedUrl;
  await updateGroup(groupId, {
    image: {
      path,
      signedUrl: imageUrl,
      signedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  if (group.image?.path) {
    await client.storage.from(mediaBucket).remove([group.image.path]);
  }
  return c.json({ imageUrl });
});

app.post(`${root}/group/image/delete`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403);
  }
  const group = await groupWithAdmin(groupId, session.name);
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが変更できます。" }, 403);
  }
  await updateGroup(groupId, { image: undefined });
  if (group.image?.path) {
    await ensureMediaBucket();
    await supabase().storage.from(mediaBucket).remove([group.image.path]);
  }
  return c.json({ deleted: true });
});

app.post(`${root}/group/name`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 20) {
    return c.json({ error: "グループ名は1〜20文字で入力してください。" }, 400);
  }
  const group = await groupWithAdmin(groupId, session.name);
  if (!group) return c.json({ error: "グループが見つかりません。" }, 404);
  if (!isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが変更できます。" }, 403);
  }
  const previousName = group.name;
  await updateGroup(groupId, { name });
  const message: Message = {
    id: crypto.randomUUID(),
    sender: session.name,
    text: `${session.name}さんがグループ名を「${name}」に変更しました。`,
    createdAt: new Date().toISOString(),
    avatar: avatarFor(session.name),
    kind: "system",
    groupName: name,
  };
  if (previousName !== name) {
    await storeMessages(groupId, [
      ...(await getMessages(groupId)),
      message,
    ]);
  }
  return c.json({ name, message: previousName !== name ? message : null });
});

app.post(`${root}/group/invite-code`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);
  const group = await groupWithAdmin(groupId, session.name);
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが変更できます。" }, 403);
  }

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const nextCode = Array.from(bytes)
    .map((value) => alphabet[value % alphabet.length])
    .join("");
  await updateGroup(groupId, { inviteCode: nextCode });
  return c.json({ inviteCode: nextCode });
});

app.post(`${root}/group/members/role`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);
  const group = await groupWithAdmin(groupId, session.name);
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが変更できます。" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const memberName = typeof body.name === "string" ? body.name.trim() : "";
  const makeAdmin = body.isAdmin === true;
  const members = await getMembers(groupId);
  if (!members.some((member) => member.name === memberName)) {
    return c.json({ error: "参加者が見つかりません。" }, 404);
  }
  const admins = group.adminNames ?? [];
  if (!makeAdmin && admins.includes(memberName) && admins.length === 1) {
    return c.json({ error: "最後の管理者は解除できません。" }, 400);
  }
  const nextAdmins = makeAdmin
    ? [...new Set([...admins, memberName])]
    : admins.filter((name) => name !== memberName);
  await updateGroup(groupId, { adminNames: nextAdmins });
  const message: Message = {
    id: crypto.randomUUID(),
    sender: session.name,
    text: makeAdmin
      ? `${memberName}さんが管理者になりました。`
      : `${memberName}さんが管理者ではなくなりました。`,
    createdAt: new Date().toISOString(),
    avatar: avatarFor(session.name),
    kind: "system",
  };
  await storeMessages(groupId, [...(await getMessages(groupId)), message]);
  return c.json({ adminNames: nextAdmins, message });
});

app.post(`${root}/group/members/remove`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);
  const group = await groupWithAdmin(groupId, session.name);
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが変更できます。" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const memberName = typeof body.name === "string" ? body.name.trim() : "";
  if (!memberName || memberName === session.name) {
    return c.json({ error: "自分自身は参加者管理から外せません。" }, 400);
  }
  const admins = group.adminNames ?? [];
  if (admins.includes(memberName) && admins.length === 1) {
    return c.json({ error: "最後の管理者は外せません。" }, 400);
  }
  const currentMembers = await getMembers(groupId);
  const removedMember = currentMembers.find(
    (member) => member.name === memberName,
  );
  if (!removedMember) {
    return c.json({ error: "参加者が見つかりません。" }, 404);
  }
  const members = currentMembers.filter(
    (member) => member.name !== memberName,
  );
  await kv.set(dataKey(groupId, "members"), members);
  await updateGroup(groupId, {
    adminNames: admins.filter((name) => name !== memberName),
  });
  if (removedMember.avatarImage?.path) {
    await ensureMediaBucket();
    await supabase()
      .storage.from(mediaBucket)
      .remove([removedMember.avatarImage.path]);
  }
  const pushDevices = await getPushDevices(groupId);
  await kv.set(
    dataKey(groupId, "push-devices"),
    pushDevices.filter((device) => device.name !== memberName),
  );
  return c.json({ removed: true, removedName: memberName });
});

app.post(`${root}/group/delete`, async (c) => {
  const token = c.req.header("X-Session-Token");
  const session = await getSession(token);
  if (!session || !token) {
    return c.json({ error: "もう一度参加してください。" }, 401);
  }
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);
  const group = await groupWithAdmin(groupId, session.name);
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけがグループを削除できます。" }, 403);
  }

  await kv.set(
    groupsKey,
    (await getGroups()).filter((item) => item.id !== groupId),
  );
  await kv.set(`sawakai:session:${token}`, {
    ...session,
    groupIds: sessionGroupIds(session).filter((id) => id !== groupId),
  });
  await Promise.all([
    kv.del(dataKey(groupId, "messages")),
    kv.del(dataKey(groupId, "members")),
    kv.del(dataKey(groupId, "analytics")),
    kv.del(dataKey(groupId, "brain-rounds")),
    kv.del(dataKey(groupId, "push-devices")),
  ]);
  try {
    await ensureMediaBucket();
    const client = supabase();
    const { data: files } = await client.storage.from(mediaBucket).list(groupId);
    if (files?.length) {
      await client.storage
        .from(mediaBucket)
        .remove(files.map((file) => `${groupId}/${file.name}`));
    }
  } catch {
    console.warn("Media cleanup could not be completed");
  }
  if (groupId === defaultGroupId) {
    await Promise.all([
      kv.del("sawakai:group-name"),
      kv.del("sawakai:invite-code"),
    ]);
  }

  const remainingGroups = (await getGroups()).filter((item) =>
    sessionGroupIds(session).includes(item.id),
  );
  return c.json({ deleted: true, remainingGroups });
});

app.get(`${root}/groups`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const allowed = new Set(sessionGroupIds(session));
  const groups: (Group & {
    imageUrl?: string;
    unreadCount: number;
    latestMessage?: {
      sender: string;
      text: string;
      createdAt: string;
      hasAttachment: boolean;
      kind?: "message" | "system";
    };
  })[] = [];
  for (const storedGroup of await getGroups()) {
    const group = await getGroupWithImage(storedGroup);
    if (
      allowed.has(group.id) &&
      (await getMembers(group.id)).some(
        (member) => member.name === session.name,
      )
    ) {
      const messages = await getMessages(group.id);
      const readAt = new Date(
        session.readAt?.[group.id] ?? "1970-01-01T00:00:00.000Z",
      ).getTime();
      const unreadCount = messages.filter(
        (message) =>
          message.sender !== session.name &&
          new Date(message.createdAt).getTime() > readAt,
      ).length;
      const latest = messages.at(-1);
      groups.push({
        ...group,
        imageUrl: group.image?.signedUrl,
        unreadCount,
        latestMessage: latest
          ? {
              sender: latest.sender,
              text: latest.text,
              createdAt: latest.createdAt,
              hasAttachment: Boolean(latest.attachment),
              kind: latest.kind,
            }
          : undefined,
      });
    }
  }
  return c.json({ groups });
});

app.post(`${root}/groups/read`, async (c) => {
  const token = c.req.header("X-Session-Token");
  const session = await getSession(token);
  if (!session || !token) {
    return c.json({ error: "もう一度参加してください。" }, 401);
  }
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);
  await kv.set(`sawakai:session:${token}`, {
    ...session,
    readAt: {
      ...(session.readAt ?? {}),
      [groupId]: new Date().toISOString(),
    },
  });
  return c.json({ read: true });
});

app.post(`${root}/groups`, async (c) => {
  const token = c.req.header("X-Session-Token");
  const session = await getSession(token);
  if (!session || !token) {
    return c.json({ error: "もう一度参加してください。" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 20) {
    return c.json({ error: "グループ名は1〜20文字で入力してください。" }, 400);
  }

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const inviteCode = Array.from(bytes)
    .map((value) => alphabet[value % alphabet.length])
    .join("");
  const group: Group = {
    id: crypto.randomUUID(),
    name,
    inviteCode,
    createdAt: new Date().toISOString(),
    adminNames: [session.name],
    createdBy: session.name,
  };
  await kv.set(groupsKey, [...(await getGroups()), group]);
  const nextSession = {
    ...session,
    groupIds: [...new Set([...sessionGroupIds(session), group.id])],
  };
  await kv.set(`sawakai:session:${token}`, nextSession);
  await touchMember(group.id, session.name);
  return c.json({ group });
});

app.post(`${root}/groups/join`, async (c) => {
  const token = c.req.header("X-Session-Token");
  const session = await getSession(token);
  if (!session || !token) {
    return c.json({ error: "もう一度参加してください。" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const code =
    typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
  const group = (await getGroups()).find(
    (candidate) => candidate.inviteCode.toLowerCase() === code.toLowerCase(),
  );
  if (!group) return c.json({ error: "招待コードが違います。" }, 403);

  await kv.set(`sawakai:session:${token}`, {
    ...session,
    groupIds: [...new Set([...sessionGroupIds(session), group.id])],
  });
  await touchMember(group.id, session.name);
  return c.json({ group });
});

app.get(`${root}/activities/latest`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }
  const latest = (await getGroupActivities(groupId)).at(-1) ?? null
  return c.json({ activity: latest })
})

app.post(`${root}/activities/invite`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }
  const group = await groupWithAdmin(groupId, session.name)
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが通知を送れます。" }, 403)
  }
  const body = await c.req.json().catch(() => ({}))
  const memberNames = new Set(
    (await getMembers(groupId)).map((member) => member.name),
  )
  const recipientNames = new Set<string>(
    Array.isArray(body.participants)
      ? body.participants.filter(
          (name: unknown): name is string =>
            typeof name === "string" &&
            name !== session.name &&
            memberNames.has(name),
        )
      : [],
  )
  if (!recipientNames.size) {
    return c.json(
      { error: "通知する参加者を1人以上選んでください。" },
      400,
    )
  }
  const gameNames: Record<GroupActivityKind, string> = {
    shiritori: "しりとり",
    association: "連想リレー",
    memory: "思い出お題",
  }
  const kind: GroupActivityKind = [
    "shiritori",
    "association",
    "memory",
  ].includes(body.kind)
    ? body.kind
    : "shiritori"
  const result = await sendPushNotifications(
    groupId,
    session.name,
    "",
    false,
    {
      recipientNames,
      title: "みんなの遊びのお誘い",
      body: `${session.name}さんから「${gameNames[kind]}」のお誘いです。アプリを開いて参加しましょう。`,
      tag: `activity-invite-${groupId}`,
    },
  )
  return c.json({
    notifiedCount: result.notifiedCount,
    selectedCount: recipientNames.size,
  })
})

app.post(`${root}/activities`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }
  const group = await groupWithAdmin(groupId, session.name)
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者が遊びを開始できます。" }, 403)
  }
  const body = await c.req.json().catch(() => ({}))
  const kind: GroupActivityKind = [
    "shiritori",
    "association",
    "memory",
  ].includes(body.kind)
    ? body.kind
    : "shiritori"
  const memberNames = new Set(
    (await getMembers(groupId)).map((item) => item.name),
  )
  const participants: string[] = Array.isArray(body.participants)
    ? [
        ...new Set<string>(
          body.participants.filter(
            (name: unknown): name is string =>
              typeof name === "string" && memberNames.has(name),
          ),
        ),
      ]
    : []
  if (participants.length < 2) {
    return c.json({ error: "参加者を2人以上選んでください。" }, 400)
  }
  const memoryPrompts = [
    "子どものころ好きだった遊び",
    "昔よく食べた懐かしい料理",
    "春になると思い出すこと",
    "行ってみたい日本の場所",
    "好きだった歌や音楽",
    "学校で楽しかった思い出",
    "家族と出かけた思い出",
    "昔使っていた懐かしい道具",
  ]
  const activity: GroupActivity = {
    id: crypto.randomUUID(),
    kind,
    participants,
    turnIndex: 0,
    status: "active",
    createdAt: new Date().toISOString(),
    createdBy: session.name,
    prompt:
      kind === "association"
        ? "バナナ"
        : kind === "memory"
          ? memoryPrompts[Math.floor(Math.random() * memoryPrompts.length)]
          : "",
    entries: [],
  }
  const current = (await getGroupActivities(groupId)).map((item) =>
    item.status === "active" ? { ...item, status: "finished" as const } : item,
  )
  await kv.set(
    dataKey(groupId, "activities"),
    [...current, activity].slice(-30),
  )
  return c.json({ activity })
})

app.post(`${root}/activities/:activityId/answer`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }
  const activities = await getGroupActivities(groupId)
  const index = activities.findIndex(
    (item) => item.id === c.req.param("activityId"),
  )
  if (index < 0) return c.json({ error: "この遊びが見つかりません。" }, 404)
  const activity = activities[index]
  if (activity.status !== "active") {
    return c.json({ error: "この遊びは終了しています。" }, 409)
  }
  const currentName =
    activity.participants[activity.turnIndex % activity.participants.length]
  if (currentName !== session.name) {
    return c.json({ error: `今は${currentName}さんの番です。` }, 409)
  }
  const body = await c.req.json().catch(() => ({}))
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text || text.length > 40) {
    return c.json({ error: "1〜40文字で入力してください。" }, 400)
  }
  if (activity.kind === "shiritori") {
    const normalized = normalizeJapaneseWord(text)
    if (!normalized || normalized.endsWith("ん")) {
      return c.json(
        { error: "「ん」で終わらない言葉を入力してください。" },
        400,
      )
    }
    const previous = activity.entries.at(-1)?.text
    const required = previous ? lastShiritoriCharacter(previous) : ""
    if (required && !normalized.startsWith(required)) {
      return c.json(
        { error: `「${required}」から始まる言葉を入力してください。` },
        400,
      )
    }
    if (
      activity.entries.some(
        (entry) => normalizeJapaneseWord(entry.text) === normalized,
      )
    ) {
      return c.json({ error: "その言葉は一度使われています。" }, 400)
    }
  } else if (activity.kind === "association") {
    // Associations are subjective, so only objective relay rules are enforced.
    const normalized = normalizeAssociationWord(text)
    if (normalized === normalizeAssociationWord(activity.prompt)) {
      return c.json(
        { error: "前の言葉とは違う、思い浮かんだ言葉を入力してください。" },
        400,
      )
    }
    if (
      activity.entries.some(
        (entry) => normalizeAssociationWord(entry.text) === normalized,
      )
    ) {
      return c.json(
        { error: "その言葉は一度使われています。別の言葉を考えてみましょう。" },
        400,
      )
    }
  }
  const entry: GroupActivityEntry = {
    name: session.name,
    text,
    createdAt: new Date().toISOString(),
  }
  const next: GroupActivity = {
    ...activity,
    entries: [...activity.entries, entry],
    turnIndex: (activity.turnIndex + 1) % activity.participants.length,
    prompt: activity.kind === "association" ? text : activity.prompt,
  }
  const updated = [...activities]
  updated[index] = next
  await kv.set(dataKey(groupId, "activities"), updated)
  return c.json({ activity: next })
})

app.post(`${root}/activities/:activityId/skip`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }
  const group = await groupWithAdmin(groupId, session.name)
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが順番を送れます。" }, 403)
  }
  const activities = await getGroupActivities(groupId)
  const index = activities.findIndex(
    (item) => item.id === c.req.param("activityId"),
  )
  if (index < 0) return c.json({ error: "この遊びが見つかりません。" }, 404)
  const activity = activities[index]
  const next = {
    ...activity,
    turnIndex: (activity.turnIndex + 1) % activity.participants.length,
  }
  activities[index] = next
  await kv.set(dataKey(groupId, "activities"), activities)
  return c.json({ activity: next })
})

app.post(`${root}/activities/:activityId/finish`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }
  const group = await groupWithAdmin(groupId, session.name)
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが終了できます。" }, 403)
  }
  const activities = await getGroupActivities(groupId)
  const index = activities.findIndex(
    (item) => item.id === c.req.param("activityId"),
  )
  if (index < 0) return c.json({ error: "この遊びが見つかりません。" }, 404)
  activities[index] = { ...activities[index], status: "finished" }
  await kv.set(dataKey(groupId, "activities"), activities)
  return c.json({ activity: activities[index] })
})

app.get(`${root}/brain/rounds`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }

  const mode = c.req.query("mode") === "practice" ? "practice" : "group"
  const rounds = await getBrainRounds(groupId)
  const visibleRounds = rounds.filter(
    (round) =>
      round.mode === mode &&
      (round.mode === "group" || round.createdBy === session.name) &&
      hasValidBrainQuestions(round) &&
      (round.difficulty === "easy" ||
        round.questions.some(
          (question) =>
            question.category === "歴史" ||
            question.category === "間違い探し",
        )),
  )
  const latest = visibleRounds.at(-1)
  const today = todayInJapan()
  const todayGroupRounds = rounds.filter(
    (round) =>
      round.mode === "group" &&
      todayInJapan(new Date(round.createdAt)) === today,
  )
  const bestByName = new Map<string, number>()
  for (const round of todayGroupRounds) {
    for (const response of Object.values(round.responses)) {
      bestByName.set(
        response.name,
        Math.max(bestByName.get(response.name) ?? 0, response.score),
      )
    }
  }
  const todayBest = [...bestByName.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"))
  const myTodayPlays = todayGroupRounds.filter(
    (round) => round.responses[session.name],
  ).length
  const leaderboard = latest
    ? Object.values(latest.responses)
        .sort(
          (a, b) =>
            b.score - a.score ||
            new Date(a.submittedAt).getTime() -
              new Date(b.submittedAt).getTime(),
        )
        .map((response, index) => ({
          rank: index + 1,
          name: response.name,
          score: response.score,
        }))
    : []
  const mine = latest?.responses[session.name]

  return c.json({
    round: latest ? publicRound(latest, session.name) : null,
    result:
      latest && mine
        ? {
            score: mine.score,
            answers: mine.answers,
            questions: latest.questions,
          }
        : null,
    leaderboard,
    todayBest,
    myTodayBest: bestByName.get(session.name) ?? 0,
    myTodayPlays,
  })
})

app.post(`${root}/brain/rounds`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }
  const body = await c.req.json().catch(() => ({}))
  const mode: BrainRound["mode"] =
    body.mode === "practice" ? "practice" : "group"
  const difficulty: BrainDifficulty = ["easy", "normal", "challenge"].includes(
    body.difficulty,
  )
    ? body.difficulty
    : "normal"
  if (mode === "group") {
    const group = await groupWithAdmin(groupId, session.name)
    if (!group || !isGroupAdmin(group, session.name)) {
      return c.json({ error: "みんなの回は管理者が開始できます。" }, 403)
    }
  }

  const rounds = await getBrainRounds(groupId)
  const today = todayInJapan()
  const todayRounds = rounds.filter(
    (round) => todayInJapan(new Date(round.createdAt)) === today,
  )
  const usedPrompts = new Set(
    todayRounds.flatMap((round) =>
      round.questions.map((question) => question.prompt),
    ),
  )
  const generated = await generateBrainQuestions(
    usedPrompts,
    difficulty,
    todayRounds.length,
  )
  const nextRounds = rounds.map((round) =>
    round.status === "active" &&
    round.mode === mode &&
    (mode === "group" || round.createdBy === session.name)
      ? { ...round, status: "finished" as const }
      : round,
  )
  const round: BrainRound = {
    id: crypto.randomUUID(),
    schemaVersion: 3,
    mode,
    difficulty,
    createdAt: new Date().toISOString(),
    createdBy: session.name,
    status: "active",
    questions: generated.questions,
    responses: {},
  }
  await kv.set(
    dataKey(groupId, "brain-rounds"),
    [...nextRounds, round].slice(-80),
  )
  return c.json({
    round: publicRound(round, session.name),
    source: generated.source,
  })
})

app.post(`${root}/brain/rounds/:roundId/submit`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"))
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401)
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session)
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403)
  }
  const body = await c.req.json().catch(() => ({}))
  const answers = Array.isArray(body.answers)
    ? body.answers.map((answer: unknown) => Number(answer))
    : []
  if (
    answers.length !== 5 ||
    answers.some(
      (answer: number) => !Number.isInteger(answer) || answer < 0 || answer > 2,
    )
  ) {
    return c.json({ error: "5問すべてに答えてください。" }, 400)
  }

  const rounds = await getBrainRounds(groupId)
  const index = rounds.findIndex((round) => round.id === c.req.param("roundId"))
  if (index < 0) return c.json({ error: "この回が見つかりません。" }, 404)
  const round = rounds[index]
  if (!hasValidBrainQuestions(round)) {
    return c.json(
      { error: "古い形式の問題です。新しい5問を開始してください。" },
      409,
    )
  }
  if (round.mode === "practice" && round.createdBy !== session.name) {
    return c.json({ error: "この練習には参加できません。" }, 403)
  }
  if (round.responses[session.name]) {
    return c.json({ error: "この回は回答済みです。" }, 409)
  }
  const score = round.questions.reduce(
    (total, question, questionIndex) =>
      total + (question.correctIndex === answers[questionIndex] ? 1 : 0),
    0,
  )
  const response: BrainResponse = {
    name: session.name,
    answers,
    score,
    submittedAt: new Date().toISOString(),
  }
  const updated: BrainRound = {
    ...round,
    responses: { ...round.responses, [session.name]: response },
  }
  const nextRounds = [...rounds]
  nextRounds[index] = updated
  await kv.set(dataKey(groupId, "brain-rounds"), nextRounds)

  const leaderboard = Object.values(updated.responses)
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime(),
    )
    .map((item, itemIndex) => ({
      rank: itemIndex + 1,
      name: item.name,
      score: item.score,
    }))
  return c.json({
    result: { score, answers, questions: updated.questions },
    leaderboard,
  })
})

app.get(`${root}/push/public-key`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const keys = await getVapidKeys();
  return c.json({ publicKey: keys.publicKey });
});

app.post(`${root}/push/subscribe`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const subscription = body.subscription;
  const endpoint =
    typeof subscription?.endpoint === "string" ? subscription.endpoint : "";
  const p256dh =
    typeof subscription?.keys?.p256dh === "string"
      ? subscription.keys.p256dh
      : "";
  const auth =
    typeof subscription?.keys?.auth === "string"
      ? subscription.keys.auth
      : "";
  if (!endpoint.startsWith("https://") || !p256dh || !auth) {
    return c.json({ error: "通知端末を登録できませんでした。" }, 400);
  }
  const device: PushDevice = {
    name: session.name,
    endpoint,
    expirationTime:
      typeof subscription.expirationTime === "number"
        ? subscription.expirationTime
        : null,
    keys: { p256dh, auth },
    preview: body.preview !== false,
    quietHours: body.quietHours === true,
    appBadge: body.appBadge !== false,
    updatedAt: new Date().toISOString(),
  };
  let registeredGroups = 0;
  for (const groupId of sessionGroupIds(session)) {
    const isMember = (await getMembers(groupId)).some(
      (member) => member.name === session.name,
    );
    if (!isMember) continue;
    const devices = await getPushDevices(groupId);
    await kv.set(dataKey(groupId, "push-devices"), [
      ...devices.filter((item) => item.endpoint !== endpoint),
      device,
    ]);
    registeredGroups += 1;
  }
  return c.json({ subscribed: true, registeredGroups });
});

app.post(`${root}/push/unsubscribe`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return c.json({ unsubscribed: true });
  for (const groupId of sessionGroupIds(session)) {
    const devices = await getPushDevices(groupId);
    await kv.set(
      dataKey(groupId, "push-devices"),
      devices.filter((device) => device.endpoint !== endpoint),
    );
  }
  return c.json({ unsubscribed: true });
});

app.post(`${root}/analytics/events`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const event = typeof body.event === "string" ? body.event : "";
  if (!allowedAnalyticsEvents.has(event)) {
    return c.json({ error: "記録できない操作です。" }, 400);
  }

  const analyticsKey = dataKey(groupId, "analytics");
  const current = ((await kv.get(analyticsKey)) as Analytics | undefined) ?? {
    counts: {},
    updatedAt: new Date().toISOString(),
  };
  const next: Analytics = {
    counts: {
      ...current.counts,
      [event]: (current.counts[event] ?? 0) + 1,
    },
    updatedAt: new Date().toISOString(),
  };
  await kv.set(analyticsKey, next);
  return c.json({ recorded: true });
});

app.get(`${root}/analytics/summary`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);
  const group = await groupWithAdmin(groupId, session.name);
  if (!group || !isGroupAdmin(group, session.name)) {
    return c.json({ error: "管理者だけが確認できます。" }, 403);
  }

  const analyticsKey = dataKey(groupId, "analytics");
  const summary = ((await kv.get(analyticsKey)) as Analytics | undefined) ?? {
    counts: {},
    updatedAt: null,
  };
  return c.json(summary);
});

app.post(`${root}/messages`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 500) {
    return c.json({ error: "返事は1〜500文字で入力してください。" }, 400);
  }

  const message: Message = {
    id: crypto.randomUUID(),
    sender: session.name,
    text,
    createdAt: new Date().toISOString(),
    avatar: avatarFor(session.name),
  };
  await storeMessages(groupId, [...(await getMessages(groupId)), message]);
  try {
    await sendPushNotifications(groupId, session.name, message.text);
  } catch {
    console.warn("Push notification processing failed");
  }
  return c.json({ message });
});

app.post(`${root}/messages/media`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);

  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "画像または動画を選んでください。" }, 400);
  }
  const isImage = ["image/webp", "image/jpeg", "image/png"].includes(file.type);
  const isVideo = ["video/mp4", "video/webm"].includes(file.type);
  if (!isImage && !isVideo) {
    return c.json({ error: "送信できるのは画像、MP4、WebMです。" }, 400);
  }
  const limit = isImage ? 2 * 1024 * 1024 : 9 * 1024 * 1024;
  if (file.size > limit) {
    return c.json(
      {
        error: isImage
          ? "画像は2MB以下にしてください。"
          : "動画は9MB以下にしてください。",
      },
      400,
    );
  }

  await ensureMediaBucket();
  const extension =
    file.type === "image/webp"
      ? "webp"
      : file.type === "image/png"
        ? "png"
        : file.type === "image/jpeg"
          ? "jpg"
          : file.type === "video/webm"
            ? "webm"
            : "mp4";
  const path = `${groupId}/${crypto.randomUUID()}.${extension}`;
  const client = supabase();
  const { error: uploadError } = await client.storage
    .from(mediaBucket)
    .upload(path, await file.arrayBuffer(), {
      contentType: file.type,
      cacheControl: "86400",
      upsert: false,
    });
  if (uploadError) {
    console.error("Media upload failed", uploadError.message);
    return c.json({ error: "ファイルを送信できませんでした。" }, 502);
  }
  const { data: signed } = await client.storage
    .from(mediaBucket)
    .createSignedUrl(path, 24 * 60 * 60);
  const message: Message = {
    id: crypto.randomUUID(),
    sender: session.name,
    text: isImage ? "画像を送信しました。" : "動画を送信しました。",
    createdAt: new Date().toISOString(),
    avatar: avatarFor(session.name),
    attachment: {
      path,
      kind: isImage ? "image" : "video",
      mimeType: file.type,
      size: file.size,
      fileName: file.name.slice(0, 100),
      signedUrl: signed?.signedUrl,
      signedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };
  await storeMessages(groupId, [...(await getMessages(groupId)), message]);
  try {
    await sendPushNotifications(groupId, session.name, message.text, true);
  } catch {
    console.warn("Push notification processing failed");
  }
  return c.json({ message });
});

app.get(`${root}/suggestions`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) return c.json({ error: "このグループには参加していません。" }, 403);

  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  const messages = await getMessages(groupId);
  const latestText = messages.at(-1)?.text || "";
  const fallback = latestText.includes("土曜")
    ? ["土曜でいいね", "何時ごろにしますか？"]
    : latestText.includes("？") || latestText.includes("?")
      ? ["はい、そうしましょう", "教えてくれてありがとう"]
      : ["そうですね", "ありがとうございます"];

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return c.json({ suggestions: fallback, source: "fallback" });
  }

  const conversation = messages
    .filter((message) => message.kind !== "system")
    .slice(-6)
    .map((message) => `${message.sender}: ${message.text}`)
    .join("\n");

  try {
    const modelsResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    );
    const modelsResult = modelsResponse.ok
      ? await modelsResponse.json()
      : { models: [] };
    const availableModels = Array.isArray(modelsResult.models)
      ? modelsResult.models.filter(
          (model: {
            name?: string;
            supportedGenerationMethods?: string[];
          }) =>
            typeof model.name === "string" &&
            model.supportedGenerationMethods?.includes("generateContent"),
        )
      : [];
    const configuredModel = Deno.env.get("GEMINI_MODEL");
    const preferredNames = [
      configuredModel,
    ].filter(Boolean);
    const flashModels = availableModels.filter(
      (candidate: { name: string }) =>
        candidate.name.includes("flash") &&
        !candidate.name.includes("image") &&
        !candidate.name.includes("live") &&
        !candidate.name.includes("tts"),
    );
    const versionedModels = flashModels.filter(
      (candidate: { name: string }) =>
        /-\d{3}$/.test(candidate.name) ||
        candidate.name.includes("preview") ||
        candidate.name.includes("experimental"),
    );
    const candidates = [
      ...preferredNames
        .map((name) =>
          flashModels.find(
            (candidate: { name: string }) => candidate.name === name,
          ),
        )
        .filter(Boolean),
      ...versionedModels,
      ...flashModels,
    ].filter(
      (
        candidate: { name: string } | undefined,
        index: number,
        list: ({ name: string } | undefined)[],
      ) =>
        candidate &&
        list.findIndex((item) => item?.name === candidate.name) === index,
    ) as { name: string }[];

    if (!candidates.length) {
      console.error("No Gemini generateContent model is available");
      return c.json({ suggestions: fallback, source: "fallback" });
    }

    const requestBody = JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: "高齢者向けグループチャットの返信支援です。会話に自然に続く、簡単で親しみのある日本語の返信案を1〜2件作ってください。各案は40文字以内とし、難しい言葉、絵文字、断定的な助言、会話にない個人情報を含めないでください。",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: `次の会話への返信案：\n${conversation}` }],
        },
      ],
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 160,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            replies: {
              type: "ARRAY",
              minItems: 1,
              maxItems: 2,
              items: { type: "STRING" },
            },
          },
          required: ["replies"],
        },
      },
    });

    for (const candidate of candidates) {
      const candidateResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${candidate.name}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
      );

      if (!candidateResponse.ok) continue;

      const result = await candidateResponse.json().catch(() => null);
      const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      const suggestions = parseReplies(raw);
      if (suggestions.length) {
        return c.json({ suggestions, source: "gemini" });
      }
    }

    return c.json({ suggestions: fallback, source: "fallback" });
  } catch (error) {
    console.warn("Gemini unavailable; using fallback replies");
    return c.json({ suggestions: fallback, source: "fallback" });
  }
});


app.get(`${root}/nine-puzzles/latest`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  const activity =
    (await getPuzzleSessions(context.groupId)).at(-1) ?? null;
  return c.json({ activity });
});

app.post(`${root}/nine-puzzles`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者が遊びを開始できます。" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const members =
    ((await kv.get(memberDataKey(context.groupId))) as
      | Array<{ name: string }>
      | undefined) ?? [];
  const memberNames = new Set(members.map((member) => member.name));
  const participants: string[] = Array.isArray(body.participants)
    ? [
        ...new Set<string>(
          body.participants.filter(
            (name: unknown): name is string =>
              typeof name === "string" && memberNames.has(name),
          ),
        ),
      ]
    : [];
  if (participants.length < 2) {
    return c.json({ error: "参加者を2人以上選んでください。" }, 400);
  }
  const previous = (await getPuzzleSessions(context.groupId)).map((activity) =>
    activity.status === "active"
      ? { ...activity, status: "finished" as const }
      : activity,
  );
  const activity: PuzzleSession = {
    id: crypto.randomUUID(),
    kind: "nine-puzzle",
    participants,
    turnIndex: 0,
    status: "active",
    createdAt: new Date().toISOString(),
    createdBy: context.session.name,
    prompt: "1から9までを順番に並べましょう",
    entries: [],
    board: shuffledPuzzleBoard(),
    moves: 0,
  };
  await kv.set(
    puzzleDataKey(context.groupId),
    [...previous, activity].slice(-30),
  );
  return c.json({ activity });
});

app.post(`${root}/nine-puzzles/invite`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが通知を送れます。" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const members =
    ((await kv.get(memberDataKey(context.groupId))) as
      | Array<{ name: string }>
      | undefined) ?? [];
  const memberNames = new Set(members.map((member) => member.name));
  const recipientNames = new Set<string>(
    Array.isArray(body.participants)
      ? body.participants.filter(
          (name: unknown): name is string =>
            typeof name === "string" &&
            name !== context.session.name &&
            memberNames.has(name),
        )
      : [],
  );
  if (!recipientNames.size) {
    return c.json(
      { error: "通知する参加者を1人以上選んでください。" },
      400,
    );
  }
  const notifiedCount = await sendPuzzleInvitations(
    context.groupId,
    context.session.name,
    recipientNames,
  );
  return c.json({ notifiedCount, selectedCount: recipientNames.size });
});

app.post(`${root}/nine-puzzles/:puzzleId/move`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  const activities = await getPuzzleSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("puzzleId"),
  );
  if (index < 0) {
    return c.json({ error: "このパズルが見つかりません。" }, 404);
  }
  const activity = activities[index];
  if (activity.status !== "active") {
    return c.json({ error: "このパズルは終了しています。" }, 409);
  }
  const currentName =
    activity.participants[activity.turnIndex % activity.participants.length];
  if (currentName !== context.session.name) {
    return c.json({ error: `今は${currentName}さんの番です。` }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const first = Number(body.first);
  const second = Number(body.second);
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(second) ||
    first < 0 ||
    first > 8 ||
    second < 0 ||
    second > 8 ||
    first === second
  ) {
    return c.json({ error: "入れ替える2枚を選んでください。" }, 400);
  }
  const board = [...activity.board];
  [board[first], board[second]] = [board[second], board[first]];
  const complete = puzzleComplete(board);
  const next: PuzzleSession = {
    ...activity,
    board,
    moves: activity.moves + 1,
    status: complete ? "finished" : "active",
    turnIndex: complete
      ? activity.turnIndex
      : (activity.turnIndex + 1) % activity.participants.length,
  };
  activities[index] = next;
  await kv.set(puzzleDataKey(context.groupId), activities);
  return c.json({ activity: next, complete });
});

app.post(`${root}/nine-puzzles/:puzzleId/skip`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが順番を送れます。" }, 403);
  }
  const activities = await getPuzzleSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("puzzleId"),
  );
  if (index < 0) {
    return c.json({ error: "このパズルが見つかりません。" }, 404);
  }
  const activity = activities[index];
  const next = {
    ...activity,
    turnIndex: (activity.turnIndex + 1) % activity.participants.length,
  };
  activities[index] = next;
  await kv.set(puzzleDataKey(context.groupId), activities);
  return c.json({ activity: next });
});

app.post(`${root}/nine-puzzles/:puzzleId/finish`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが終了できます。" }, 403);
  }
  const activities = await getPuzzleSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("puzzleId"),
  );
  if (index < 0) {
    return c.json({ error: "このパズルが見つかりません。" }, 404);
  }
  activities[index] = { ...activities[index], status: "finished" };
  await kv.set(puzzleDataKey(context.groupId), activities);
  return c.json({ activity: activities[index] });
});

app.get(`${root}/proverb-puzzles/latest`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  const activity =
    (await getProverbPuzzleSessions(context.groupId)).at(-1) ?? null;
  return c.json({ activity });
});

app.post(`${root}/proverb-puzzles`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者が遊びを開始できます。" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const members =
    ((await kv.get(memberDataKey(context.groupId))) as
      | Array<{ name: string }>
      | undefined) ?? [];
  const memberNames = new Set(members.map((member) => member.name));
  const participants: string[] = Array.isArray(body.participants)
    ? [
        ...new Set<string>(
          body.participants.filter(
            (name: unknown): name is string =>
              typeof name === "string" && memberNames.has(name),
          ),
        ),
      ]
    : [];
  if (participants.length < 2) {
    return c.json({ error: "参加者を2人以上選んでください。" }, 400);
  }
  const previous = (await getProverbPuzzleSessions(context.groupId)).map(
    (activity) =>
      activity.status === "active"
        ? { ...activity, status: "finished" as const }
        : activity,
  );
  const questions = shuffledItems(proverbQuestionBank).slice(0, 10);
  const activity: ProverbPuzzleSession = {
    id: crypto.randomUUID(),
    kind: "proverb-puzzle",
    participants,
    turnIndex: 0,
    status: "active",
    createdAt: new Date().toISOString(),
    createdBy: context.session.name,
    prompt: "語句を正しい順番に並べて、ことわざを完成させましょう",
    entries: [],
    questions,
    questionIndex: 0,
    wordBoard: shuffledProverbBoard(questions[0]),
    solvedCount: 0,
    moves: 0,
  };
  await kv.set(
    proverbPuzzleDataKey(context.groupId),
    [...previous, activity].slice(-30),
  );
  return c.json({ activity });
});

app.post(`${root}/proverb-puzzles/invite`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが通知を送れます。" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const members =
    ((await kv.get(memberDataKey(context.groupId))) as
      | Array<{ name: string }>
      | undefined) ?? [];
  const memberNames = new Set(members.map((member) => member.name));
  const recipientNames = new Set<string>(
    Array.isArray(body.participants)
      ? body.participants.filter(
          (name: unknown): name is string =>
            typeof name === "string" &&
            name !== context.session.name &&
            memberNames.has(name),
        )
      : [],
  );
  if (!recipientNames.size) {
    return c.json(
      { error: "通知する参加者を1人以上選んでください。" },
      400,
    );
  }
  const notifiedCount = await sendPuzzleInvitations(
    context.groupId,
    context.session.name,
    recipientNames,
    "proverb",
  );
  return c.json({ notifiedCount, selectedCount: recipientNames.size });
});

app.post(`${root}/proverb-puzzles/:puzzleId/move`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  const activities = await getProverbPuzzleSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("puzzleId"),
  );
  if (index < 0) {
    return c.json({ error: "この問題が見つかりません。" }, 404);
  }
  const activity = activities[index];
  if (activity.status !== "active") {
    return c.json({ error: "この遊びは終了しています。" }, 409);
  }
  if (activity.nextQuestionAt) {
    return c.json({ error: "次の問題を準備しています。" }, 409);
  }
  const currentName =
    activity.participants[activity.turnIndex % activity.participants.length];
  if (currentName !== context.session.name) {
    return c.json({ error: `今は${currentName}さんの番です。` }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const first = Number(body.first);
  const second = Number(body.second);
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(second) ||
    first < 0 ||
    second < 0 ||
    first >= activity.wordBoard.length ||
    second >= activity.wordBoard.length ||
    first === second
  ) {
    return c.json({ error: "入れ替える2枚を選んでください。" }, 400);
  }
  const wordBoard = [...activity.wordBoard];
  [wordBoard[first], wordBoard[second]] = [wordBoard[second], wordBoard[first]];
  const question = activity.questions[activity.questionIndex];
  const solved = proverbComplete(wordBoard, question);
  const nextQuestionIndex = solved
    ? activity.questionIndex + 1
    : activity.questionIndex;
  const allComplete = nextQuestionIndex >= activity.questions.length;
  const next: ProverbPuzzleSession = {
    ...activity,
    wordBoard,
    questionIndex: activity.questionIndex,
    solvedCount: activity.solvedCount + (solved ? 1 : 0),
    moves: activity.moves + 1,
    nextQuestionAt: solved ? new Date().toISOString() : undefined,
    pendingQuestionIndex: solved ? nextQuestionIndex : undefined,
    pendingTurnIndex: solved
      ? (activity.turnIndex + 1) % activity.participants.length
      : undefined,
    turnIndex: solved
      ? activity.turnIndex
      : (activity.turnIndex + 1) % activity.participants.length,
  };
  activities[index] = next;
  await kv.set(proverbPuzzleDataKey(context.groupId), activities);
  return c.json({ activity: next, solved, allComplete });
});

app.post(`${root}/proverb-puzzles/:puzzleId/advance`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  const activities = await getProverbPuzzleSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("puzzleId"),
  );
  if (index < 0) {
    return c.json({ error: "この問題が見つかりません。" }, 404);
  }
  const activity = activities[index];
  const currentQuestion = activity.questions[activity.questionIndex];
  const solvedBoard = proverbComplete(activity.wordBoard, currentQuestion);
  if (!activity.nextQuestionAt && !solvedBoard) {
    return c.json({ activity });
  }
  const canAdvance =
    activity.participants.includes(context.session.name) ||
    (await puzzleIsAdmin(context.groupId, context.session.name));
  if (!canAdvance) {
    return c.json({ error: "ゲーム参加者または管理者が次へ進めます。" }, 403);
  }
  const nextQuestionIndex =
    activity.pendingQuestionIndex ?? activity.questionIndex + 1;
  const complete = nextQuestionIndex >= activity.questions.length;
  const next: ProverbPuzzleSession = {
    ...activity,
    questionIndex: nextQuestionIndex,
    wordBoard: complete
      ? activity.wordBoard
      : shuffledProverbBoard(activity.questions[nextQuestionIndex]),
    status: complete ? "finished" : "active",
    turnIndex:
      activity.pendingTurnIndex ??
      (activity.turnIndex + 1) % activity.participants.length,
    nextQuestionAt: undefined,
    pendingQuestionIndex: undefined,
    pendingTurnIndex: undefined,
  };
  activities[index] = next;
  await kv.set(proverbPuzzleDataKey(context.groupId), activities);
  return c.json({ activity: next });
});

app.post(`${root}/proverb-puzzles/:puzzleId/skip`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが順番を送れます。" }, 403);
  }
  const activities = await getProverbPuzzleSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("puzzleId"),
  );
  if (index < 0) {
    return c.json({ error: "この問題が見つかりません。" }, 404);
  }
  const activity = activities[index];
  activities[index] = {
    ...activity,
    nextQuestionAt: undefined,
    pendingQuestionIndex: undefined,
    pendingTurnIndex: undefined,
    turnIndex: (activity.turnIndex + 1) % activity.participants.length,
  };
  await kv.set(proverbPuzzleDataKey(context.groupId), activities);
  return c.json({ activity: activities[index] });
});

app.post(`${root}/proverb-puzzles/:puzzleId/finish`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) {
    return c.json({ error: context.error }, context.status);
  }
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが終了できます。" }, 403);
  }
  const activities = await getProverbPuzzleSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("puzzleId"),
  );
  if (index < 0) {
    return c.json({ error: "この問題が見つかりません。" }, 404);
  }
  activities[index] = { ...activities[index], status: "finished" };
  await kv.set(proverbPuzzleDataKey(context.groupId), activities);
  return c.json({ activity: activities[index] });
});

app.get(`${root}/memory-matches/latest`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const activity = (await getMemoryMatchSessions(context.groupId)).at(-1) ?? null;
  return c.json({ activity });
});

app.post(`${root}/memory-matches`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者が遊びを開始できます。" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const members =
    ((await kv.get(memberDataKey(context.groupId))) as
      | Array<{ name: string }>
      | undefined) ?? [];
  const memberNames = new Set(members.map((member) => member.name));
  const participants: string[] = Array.isArray(body.participants)
    ? [...new Set<string>(body.participants.filter(
        (name: unknown): name is string =>
          typeof name === "string" && memberNames.has(name),
      ))]
    : [];
  if (participants.length < 2) {
    return c.json({ error: "参加者を2人以上選んでください。" }, 400);
  }
  const previous = (await getMemoryMatchSessions(context.groupId)).map(
    (activity) =>
      activity.status === "active"
        ? { ...activity, status: "finished" as const }
        : activity,
  );
  const activity: MemoryMatchSession = {
    id: crypto.randomUUID(),
    kind: "memory-match",
    participants,
    turnIndex: 0,
    status: "active",
    createdAt: new Date().toISOString(),
    createdBy: context.session.name,
    prompt: "同じ言葉のカードを2枚見つけましょう",
    entries: [],
    cards: createMemoryCards(),
    revealedIds: [],
    matchedIds: [],
    lastMismatchIds: [],
    nextTurnAt: undefined,
    pendingTurnIndex: undefined,
    matchesByName: Object.fromEntries(participants.map((name) => [name, 0])),
    attempts: 0,
  };
  await kv.set(
    memoryMatchDataKey(context.groupId),
    [...previous, activity].slice(-30),
  );
  return c.json({ activity });
});

app.post(`${root}/memory-matches/invite`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが通知を送れます。" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const members =
    ((await kv.get(memberDataKey(context.groupId))) as
      | Array<{ name: string }>
      | undefined) ?? [];
  const memberNames = new Set(members.map((member) => member.name));
  const recipientNames = new Set<string>(
    Array.isArray(body.participants)
      ? body.participants.filter(
          (name: unknown): name is string =>
            typeof name === "string" &&
            name !== context.session.name &&
            memberNames.has(name),
        )
      : [],
  );
  if (!recipientNames.size) {
    return c.json({ error: "通知する参加者を1人以上選んでください。" }, 400);
  }
  const notifiedCount = await sendPuzzleInvitations(
    context.groupId,
    context.session.name,
    recipientNames,
    "memory-match",
  );
  return c.json({ notifiedCount, selectedCount: recipientNames.size });
});

app.post(`${root}/memory-matches/:matchId/flip`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const activities = await getMemoryMatchSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("matchId"),
  );
  if (index < 0) return c.json({ error: "このゲームが見つかりません。" }, 404);
  const activity = activities[index];
  if (activity.status !== "active") {
    return c.json({ error: "このゲームは終了しています。" }, 409);
  }
  const currentName =
    activity.participants[activity.turnIndex % activity.participants.length];
  if (currentName !== context.session.name) {
    return c.json({ error: `今は${currentName}さんの番です。` }, 409);
  }
  if (activity.nextTurnAt) {
    return c.json({ error: "カウントダウンが終わるまでお待ちください。" }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const cardId = typeof body.cardId === "string" ? body.cardId : "";
  const card = activity.cards.find((item) => item.id === cardId);
  if (!card || activity.matchedIds.includes(cardId)) {
    return c.json({ error: "別のカードを選んでください。" }, 400);
  }
  const firstId = activity.revealedIds[0];
  if (firstId === cardId) {
    return c.json({ error: "もう1枚のカードを選んでください。" }, 400);
  }
  let next: MemoryMatchSession;
  if (!firstId) {
    next = {
      ...activity,
      revealedIds: [cardId],
      lastMismatchIds: [],
      lastMismatchAt: undefined,
      nextTurnAt: undefined,
      pendingTurnIndex: undefined,
    };
  } else {
    const first = activity.cards.find((item) => item.id === firstId)!;
    const matched = first.label === card.label;
    const matchedIds = matched
      ? [...activity.matchedIds, firstId, cardId]
      : activity.matchedIds;
    const complete = matchedIds.length === activity.cards.length;
    next = {
      ...activity,
      revealedIds: [],
      matchedIds,
      lastMismatchIds: [firstId, cardId],
      lastMismatchAt: new Date().toISOString(),
      matchesByName: matched
        ? {
            ...activity.matchesByName,
            [context.session.name]:
              (activity.matchesByName[context.session.name] ?? 0) + 1,
          }
        : activity.matchesByName,
      attempts: activity.attempts + 1,
      status: complete ? "finished" : "active",
      nextTurnAt: complete
        ? undefined
        : new Date(Date.now() + 5000).toISOString(),
      pendingTurnIndex: complete
        ? undefined
        : (activity.turnIndex + 1) % activity.participants.length,
    };
  }
  activities[index] = next;
  await kv.set(memoryMatchDataKey(context.groupId), activities);
  return c.json({ activity: next });
});

app.post(`${root}/memory-matches/:matchId/advance`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const activities = await getMemoryMatchSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("matchId"),
  );
  if (index < 0) return c.json({ error: "このゲームが見つかりません。" }, 404);
  const activity = activities[index];
  if (
    !activity.nextTurnAt ||
    Date.now() < new Date(activity.nextTurnAt).getTime()
  ) {
    return c.json({ activity });
  }
  const next: MemoryMatchSession = {
    ...activity,
    turnIndex:
      activity.pendingTurnIndex ??
      (activity.turnIndex + 1) % activity.participants.length,
    revealedIds: [],
    lastMismatchIds: [],
    lastMismatchAt: undefined,
    nextTurnAt: undefined,
    pendingTurnIndex: undefined,
  };
  activities[index] = next;
  await kv.set(memoryMatchDataKey(context.groupId), activities);
  return c.json({ activity: next });
});

app.post(`${root}/memory-matches/:matchId/skip`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが順番を送れます。" }, 403);
  }
  const activities = await getMemoryMatchSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("matchId"),
  );
  if (index < 0) return c.json({ error: "このゲームが見つかりません。" }, 404);
  const activity = activities[index];
  activities[index] = {
    ...activity,
    revealedIds: [],
    lastMismatchIds: [],
    lastMismatchAt: undefined,
    nextTurnAt: undefined,
    pendingTurnIndex: undefined,
    turnIndex: (activity.turnIndex + 1) % activity.participants.length,
  };
  await kv.set(memoryMatchDataKey(context.groupId), activities);
  return c.json({ activity: activities[index] });
});

app.post(`${root}/memory-matches/:matchId/finish`, async (c) => {
  const context = await puzzleRequestContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  if (!(await puzzleIsAdmin(context.groupId, context.session.name))) {
    return c.json({ error: "管理者だけが終了できます。" }, 403);
  }
  const activities = await getMemoryMatchSessions(context.groupId);
  const index = activities.findIndex(
    (activity) => activity.id === c.req.param("matchId"),
  );
  if (index < 0) return c.json({ error: "このゲームが見つかりません。" }, 404);
  activities[index] = { ...activities[index], status: "finished" };
  await kv.set(memoryMatchDataKey(context.groupId), activities);
  return c.json({ activity: activities[index] });
});
app.post(`${root}/voice/token`, async (c) => {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return c.json({ error: "もう一度参加してください。" }, 401);
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) {
    return c.json({ error: "このグループには参加していません。" }, 403);
  }
  const url = Deno.env.get("LIVEKIT_URL");
  const apiKey = Deno.env.get("LIVEKIT_API_KEY");
  const apiSecret = Deno.env.get("LIVEKIT_API_SECRET");
  if (!url || !apiKey || !apiSecret) {
    return c.json({ error: "音声通話の設定が完了していません。" }, 503);
  }
  const { AccessToken, RoomServiceClient } = await import(
    "npm:livekit-server-sdk@2"
  );
  try {
    const roomClient = new RoomServiceClient(
      url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
      apiKey,
      apiSecret,
    );
    const members = await roomClient.listParticipants(`sawakai-${groupId}`);
    const alreadyIn = members.some(
      (member) => member.identity === `${groupId}:${session.name}`,
    );
    if (!alreadyIn && members.length >= voiceMaxMembers) {
      return c.json(
        { error: `通話は${voiceMaxMembers}人までです。満員のため参加できません。` },
        409,
      );
    }
  } catch (error) {
    console.log("voice participant check skipped", error);
  }
  const token = new AccessToken(apiKey, apiSecret, {
    identity: `${groupId}:${session.name}`,
    name: session.name,
    ttl: 60 * 60,
  });
  token.addGrant({
    room: `sawakai-${groupId}`,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  return c.json({ token: await token.toJwt(), url });
});

const voiceMaxMembers = 6;
const voiceGameQuestionCount = 5;
const voiceGameSeconds = 30;
type VoiceGameState = {
  id: string;
  status: "playing" | "finished";
  phase: "question" | "reveal";
  startedBy: string;
  index: number;
  questionStartedAt: number;
  questions: BrainQuestion[];
  answers: Record<string, number>;
  scores: Record<string, number>;
  updatedAt: number;
};
const voiceGameKey = (groupId: string) => `sawakai:voice-game:${groupId}`;

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickVoiceGameQuestions(): BrainQuestion[] {
  const pool = [
    ...safetyBrainQuestionBank,
    ...Object.values(brainQuestionBank).flat(),
  ].filter((question) => question.choices.length >= 2);
  return shuffled(pool)
    .slice(0, voiceGameQuestionCount)
    .map((question) => {
      const order = shuffled(question.choices.map((_, index) => index));
      return {
        ...question,
        choices: order.map((index) => question.choices[index]),
        correctIndex: order.indexOf(question.correctIndex),
      };
    });
}

// 時間切れなら自動で答え合わせの状態へ進める
function settleVoiceGame(state: VoiceGameState): VoiceGameState {
  if (
    state.status === "playing" &&
    state.phase === "question" &&
    Date.now() - state.questionStartedAt >= (voiceGameSeconds + 2) * 1000
  ) {
    return revealVoiceGame(state);
  }
  return state;
}

function revealVoiceGame(state: VoiceGameState): VoiceGameState {
  if (state.phase === "reveal") return state;
  const correct = state.questions[state.index].correctIndex;
  const scores = { ...state.scores };
  for (const [name, choice] of Object.entries(state.answers)) {
    if (choice === correct) scores[name] = (scores[name] ?? 0) + 1;
  }
  return { ...state, phase: "reveal", scores, updatedAt: Date.now() };
}

function publicVoiceGame(state: VoiceGameState) {
  const hide = state.status === "playing" && state.phase === "question";
  return {
    ...state,
    seconds: voiceGameSeconds,
    serverNow: Date.now(),
    questions: state.questions.map((question, index) =>
      hide && index === state.index
        ? { ...question, correctIndex: -1, explanation: "" }
        : index > state.index
          ? { ...question, correctIndex: -1, explanation: "" }
          : question,
    ),
  };
}

async function voiceGameContext(c: any) {
  const session = await getSession(c.req.header("X-Session-Token"));
  if (!session) return { error: "もう一度参加してください。", status: 401 as const };
  const groupId = await requestedGroupId(c.req.header("X-Group-Id"), session);
  if (!groupId) {
    return { error: "このグループには参加していません。", status: 403 as const };
  }
  return { session, groupId };
}

async function loadVoiceGame(groupId: string): Promise<VoiceGameState | null> {
  const stored = (await kv.get(voiceGameKey(groupId))) as VoiceGameState | null;
  if (!stored) return null;
  const settled = settleVoiceGame(stored);
  if (settled !== stored) await kv.set(voiceGameKey(groupId), settled);
  return settled;
}

app.get(`${root}/voice/game`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const state = await loadVoiceGame(context.groupId);
  return c.json({ game: state ? publicVoiceGame(state) : null });
});

app.post(`${root}/voice/game/start`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const current = await loadVoiceGame(context.groupId);
  if (current && current.status === "playing") {
    return c.json({ game: publicVoiceGame(current) });
  }
  const state: VoiceGameState = {
    id: crypto.randomUUID(),
    status: "playing",
    phase: "question",
    startedBy: context.session.name,
    index: 0,
    questionStartedAt: Date.now(),
    questions: pickVoiceGameQuestions(),
    answers: {},
    scores: {},
    updatedAt: Date.now(),
  };
  await kv.set(voiceGameKey(context.groupId), state);
  return c.json({ game: publicVoiceGame(state) });
});

app.post(`${root}/voice/game/answer`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const body = await c.req.json().catch(() => ({}));
  const state = await loadVoiceGame(context.groupId);
  if (!state || state.status !== "playing" || state.phase !== "question") {
    return c.json({ game: state ? publicVoiceGame(state) : null });
  }
  const choice = Number(body.choice);
  const question = state.questions[state.index];
  const name = context.session.name;
  if (
    body.index === state.index &&
    Number.isInteger(choice) &&
    choice >= 0 &&
    choice < question.choices.length &&
    state.answers[name] === undefined
  ) {
    state.answers = { ...state.answers, [name]: choice };
    state.updatedAt = Date.now();
    await kv.set(voiceGameKey(context.groupId), state);
  }
  return c.json({ game: publicVoiceGame(state) });
});

app.post(`${root}/voice/game/reveal`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const body = await c.req.json().catch(() => ({}));
  const state = await loadVoiceGame(context.groupId);
  if (!state) return c.json({ game: null });
  if (
    state.status === "playing" &&
    state.phase === "question" &&
    body.index === state.index
  ) {
    const next = revealVoiceGame(state);
    await kv.set(voiceGameKey(context.groupId), next);
    return c.json({ game: publicVoiceGame(next) });
  }
  return c.json({ game: publicVoiceGame(state) });
});

app.post(`${root}/voice/game/next`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const body = await c.req.json().catch(() => ({}));
  const state = await loadVoiceGame(context.groupId);
  if (!state) return c.json({ game: null });
  if (
    state.status === "playing" &&
    state.phase === "reveal" &&
    body.index === state.index
  ) {
    const last = state.index + 1 >= state.questions.length;
    const next: VoiceGameState = last
      ? { ...state, status: "finished", updatedAt: Date.now() }
      : {
          ...state,
          index: state.index + 1,
          phase: "question",
          answers: {},
          questionStartedAt: Date.now(),
          updatedAt: Date.now(),
        };
    await kv.set(voiceGameKey(context.groupId), next);
    return c.json({ game: publicVoiceGame(next) });
  }
  return c.json({ game: publicVoiceGame(state) });
});

app.post(`${root}/voice/game/end`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  await kv.del(voiceGameKey(context.groupId));
  return c.json({ game: null });
});

const voiceWordRounds = 6;
const voiceWordBank: { category: string; words: string[] }[] = [
  { category: "食べ物", words: ["おにぎり", "カレーライス", "天ぷら", "すき焼き", "たい焼き", "みそ汁", "納豆", "ラーメン", "おでん", "どら焼き"] },
  { category: "動物", words: ["ぞう", "きりん", "ペンギン", "うさぎ", "たぬき", "カメ", "ひつじ", "イルカ", "ふくろう", "パンダ"] },
  { category: "季節・行事", words: ["お正月", "桜", "花火", "紅葉", "七夕", "こたつ", "ひなまつり", "お月見", "すいか", "雪だるま"] },
  { category: "暮らしの道具", words: ["傘", "電子レンジ", "ほうき", "やかん", "めがね", "くつ下", "せんたく機", "ハサミ", "座布団", "こたつ"] },
  { category: "乗り物・場所", words: ["新幹線", "自転車", "東京タワー", "富士山", "温泉", "動物園", "駅", "郵便局", "公園", "病院"] },
];
type VoiceWordState = {
  id: string;
  status: "playing" | "finished";
  host: string;
  round: number;
  word: string;
  category: string;
  usedWords: string[];
  scores: Record<string, number>;
  updatedAt: number;
};
const voiceWordKey = (groupId: string) => `sawakai:voice-word:${groupId}`;

function pickVoiceWord(used: string[]) {
  const all = voiceWordBank.flatMap((entry) =>
    entry.words.map((word) => ({ category: entry.category, word })),
  );
  const fresh = all.filter((entry) => !used.includes(entry.word));
  const pool = fresh.length > 0 ? fresh : all;
  return pool[Math.floor(Math.random() * pool.length)];
}

function publicVoiceWord(state: VoiceWordState, name: string) {
  const isHost = state.host === name;
  return {
    id: state.id,
    status: state.status,
    host: state.host,
    round: state.round,
    maxRounds: voiceWordRounds,
    category: state.category,
    word: isHost && state.status === "playing" ? state.word : undefined,
    scores: state.scores,
    updatedAt: state.updatedAt,
  };
}

function cleanVoiceNames(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string"))].slice(0, voiceMaxMembers)
    : [];
}

app.get(`${root}/voice/word`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const state = (await kv.get(voiceWordKey(context.groupId))) as VoiceWordState | null;
  return c.json({ game: state ? publicVoiceWord(state, context.session.name) : null });
});

app.post(`${root}/voice/word/start`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const key = voiceWordKey(context.groupId);
  const current = (await kv.get(key)) as VoiceWordState | null;
  if (current && current.status === "playing") {
    return c.json({ game: publicVoiceWord(current, context.session.name) });
  }
  const picked = pickVoiceWord([]);
  const state: VoiceWordState = {
    id: crypto.randomUUID(),
    status: "playing",
    host: context.session.name,
    round: 1,
    word: picked.word,
    category: picked.category,
    usedWords: [picked.word],
    scores: {},
    updatedAt: Date.now(),
  };
  await kv.set(key, state);
  return c.json({ game: publicVoiceWord(state, context.session.name) });
});

// 出題者の操作: correct=正解した人を選ぶ / pass=お題を変える / skip=出題者を交代
app.post(`${root}/voice/word/action`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  const me = context.session.name;
  const key = voiceWordKey(context.groupId);
  const state = (await kv.get(key)) as VoiceWordState | null;
  if (!state || state.status !== "playing") return c.json({ game: null });
  if (state.host !== me) {
    return c.json({ game: publicVoiceWord(state, me) });
  }
  const body = await c.req.json().catch(() => ({}));
  const names = cleanVoiceNames(body.names);
  const scores = { ...state.scores };
  let next: VoiceWordState = { ...state, updatedAt: Date.now() };

  if (body.action === "pass") {
    const picked = pickVoiceWord(state.usedWords);
    next = { ...next, word: picked.word, category: picked.category, usedWords: [...state.usedWords, picked.word] };
  } else if (body.action === "correct" || body.action === "skip") {
    if (body.action === "correct") {
      const winner = typeof body.winner === "string" ? body.winner : "";
      if (!winner || winner === me || !names.includes(winner)) {
        return c.json({ game: publicVoiceWord(state, me) });
      }
      scores[winner] = (scores[winner] ?? 0) + 1;
      scores[me] = (scores[me] ?? 0) + 1;
    }
    if (state.round >= voiceWordRounds) {
      next = { ...next, scores, status: "finished" };
    } else {
      const order = names.includes(me) ? names : [me, ...names];
      const nextHost = order[(order.indexOf(me) + 1) % order.length];
      const picked = pickVoiceWord(state.usedWords);
      next = {
        ...next,
        scores,
        host: nextHost,
        round: state.round + 1,
        word: picked.word,
        category: picked.category,
        usedWords: [...state.usedWords, picked.word],
      };
    }
  }
  await kv.set(key, next);
  return c.json({ game: publicVoiceWord(next, me) });
});

app.post(`${root}/voice/word/end`, async (c) => {
  const context = await voiceGameContext(c);
  if ("error" in context) return c.json({ error: context.error }, context.status);
  await kv.del(voiceWordKey(context.groupId));
  return c.json({ game: null });
});

Deno.serve(app.fetch);
