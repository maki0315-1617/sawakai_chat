import { useState } from "react";
import { createPortal } from "react-dom";

type Section = {
  heading: string;
  paragraphs?: string[];
  items?: string[];
  rows?: [string, string][];
};
type Doc = { id: string; tab: string; title: string; lead: string; sections: Section[] };

const contact: Section = {
  heading: "お問い合わせ先",
  rows: [
    ["会社名", "ロンAIシステムズ"],
    ["メール", "ronron201907@gmail.com"],
    ["Webサイト", "https://ron-home-app.vercel.app/"],
    ["受付時間", "10:00～17:00"],
  ],
};

const games: [string, string][] = [
  ["脳活クイズ", "ことば・計算・注意・暮らし・図形・歴史・間違い探し・一般常識・防災・健康・防犯・交通など。やさしい／ふつう／チャレンジから選べます。"],
  ["しりとり", "前の言葉の最後の文字から、順番につなぎます。"],
  ["連想リレー", "前の言葉から思い浮かぶものを、順番に答えます。"],
  ["思い出お題", "懐かしいお題について、一人ずつ思い出を話します。"],
  ["みんなで9マス", "2枚を選んで入れ替え、1から9まで順番に並べます。"],
  ["ことわざ並べ替え", "語句を入れ替えて、ことわざ10問を完成させます。"],
  ["みんなで神経衰弱", "18枚のカードから、同じ言葉の9組を見つけます。"],
];

const docs: Doc[] = [
  {
    id: "guide",
    tab: "ご利用ガイド",
    title: "茶話会・みんなで脳活 ご利用ガイド",
    lead: "はじめての方にもわかる使い方です。",
    sections: [
      {
        heading: "1. 参加のしかた",
        items: [
          "お知らせされたURLを開きます。",
          "お名前と招待コードを入力して「参加」を押します。",
          "ブラウザのメニューから「ホーム画面に追加」を選ぶと、アプリのように使えます。",
        ],
      },
      {
        heading: "2. 画面上部のボタン",
        rows: [
          ["グループ通話", "参加者みんなで声で会話します。"],
          ["1対1", "特定の人に電話をかけます。通話履歴も見られます。"],
          ["脳活", "クイズやゲームを始めます。"],
          ["参加者", "参加者一覧、招待コード、ご自身の画像設定を開きます。"],
          ["退出", "この端末での参加を終了します（会話内容は削除されません）。"],
        ],
      },
      {
        heading: "3. 会話する",
        items: [
          "返信を選ぶ：AIが返事の候補を表示します。タップして送信できます。",
          "自由入力：ご自分の言葉で入力できます。送信前に確認画面が出ます。",
          "音声入力：マイクボタンで話した言葉を文字にできます。",
          "読み上げ：届いたメッセージを声で読み上げられます。",
          "写真・動画：添付ボタンから選んで送ります。",
          "送信の取り消し：送ってすぐなら取り消せます。",
        ],
      },
      {
        heading: "4. 参加者一覧の見かた",
        paragraphs: ["「参加者」ボタンを押すと、メンバーが1人につき2段で表示されます。"],
        rows: [
          ["参加中", "本人が「参加中」を選んでいます。"],
          ["不参加", "本人が「不参加」を選んでいます。"],
          ["未回答", "まだ選んでいません。"],
          ["通話可能", "アプリを開いていて、今すぐ電話を受けられます。"],
          ["通話中", "ほかの通話をしています。"],
          ["応答待機なし", "アプリを開いておらず、電話を受けられません。"],
        ],
      },
      {
        heading: "5. 電話をかける・受ける",
        items: [
          "「参加者」を開き、相手の行の緑の電話マークを押します（相手が「通話可能」のときだけ押せます）。",
          "通話中は、その相手の行が赤い切るマークに変わります。押すと通話を終了できます。",
          "着信すると画面いっぱいに表示され、着信音が鳴ります。「出る」「出ない」を選びます。",
          "通話中はマイクのオン／オフと、相手の声の大きさを調整できます。声が響くときはイヤホンが便利です。",
          "出られなかった電話は、不在着信として残ります。1対1ボタンの通話履歴からかけ直せます。",
        ],
      },
      {
        heading: "6. グループ通話",
        items: [
          "「グループ通話」を押し、「通話に参加する」を選びます。",
          "同時に参加できるのは6人までです。",
          "マイクの許可が必要です。ブラウザの確認が出たら「許可」を選んでください。",
        ],
      },
      { heading: "7. みんなで脳活", rows: games },
      {
        heading: "8. 管理者の機能",
        items: [
          "招待コードの確認・再発行（再発行すると古いコードでは入れなくなります）",
          "グループ名・画像の変更",
          "メンバーを管理者にする／解除する",
          "「外す」でメンバーをグループから外す",
          "グループの削除（会話などの関連データも削除され、取り消せません）",
        ],
      },
      {
        heading: "9. 困ったときは",
        rows: [
          ["「通話可能」にならない", "相手がアプリを開いているか確認してください。"],
          ["音が聞こえない", "端末の音量・マイクの許可、イヤホンの接続を確認してください。"],
          ["着信に気づけない", "通知を許可し、「退出」していないか確認してください。"],
          ["画面が古い", "ブラウザを再読み込みしてください。"],
        ],
      },
      {
        heading: "10. 保存期間について",
        items: [
          "通常の会話は90日間保存します。",
          "画像・動画とシステムのお知らせは30日間保存します。",
          "会話が500件を超えた場合は、古いものから削除します。",
          "グループを削除した場合は、関連データも削除します。",
        ],
      },
      contact,
    ],
  },
  {
    id: "pr",
    tab: "PR資料",
    title: "茶話会・みんなで脳活",
    lead: "会話と脳活を、いつものメンバーで。招待制のやさしいグループチャットです。",
    sections: [
      {
        heading: "こんなお悩みはありませんか？",
        items: [
          "離れて暮らす家族や友人と、気軽におしゃべりしたい",
          "文字を打つのが大変で、メッセージが続かない",
          "楽しみながら頭を使う習慣をつくりたい",
          "知らない人が入ってくる場は不安",
        ],
      },
      {
        heading: "できること",
        rows: [
          ["かんたん会話", "AIが返信の候補を提案。選ぶだけで返事ができ、音声入力や読み上げにも対応します。"],
          ["写真・動画を共有", "思い出の写真や動画を、グループのみんなに送れます。"],
          ["声で話せる", "グループ通話と1対1の電話に対応。参加者一覧の電話マークを押すだけで発信できます。"],
          ["みんなで脳活", "クイズや、しりとり・ことわざ並べ替え・神経衰弱など、みんなで楽しめます。"],
          ["安心の招待制", "招待コードを知る人だけが参加でき、管理者がメンバーを管理します。"],
          ["今の状況がわかる", "参加者一覧で「参加中／不参加」と「通話可能／通話中」を確認できます。"],
        ],
      },
      { heading: "みんなで脳活", rows: games },
      {
        heading: "やさしさと安心へのこだわり",
        items: [
          "大きな文字とわかりやすいボタン配置。テーマカラーも選べます",
          "着信音とバイブレーション、不在着信のお知らせ",
          "招待コードを知る人だけが参加でき、管理者がメンバー管理を行えます",
          "1対1の通話は同じグループのメンバーとだけ。会話は90日間、画像・動画は30日間保存します",
        ],
      },
      {
        heading: "はじめかた",
        items: [
          "お知らせしたURLを開く",
          "お名前と招待コードを入力して参加",
          "「ホーム画面に追加」で次回からすぐ開けます",
        ],
      },
      contact,
    ],
  },
];

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function toHtmlFile(doc: Doc) {
  const body = doc.sections
    .map(
      (s) =>
        `<h2>${escapeHtml(s.heading)}</h2>` +
        (s.paragraphs ?? []).map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
        (s.items ? `<ul>${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : "") +
        (s.rows
          ? `<table>${s.rows.map(([a, b]) => `<tr><th>${escapeHtml(a)}</th><td>${escapeHtml(b)}</td></tr>`).join("")}</table>`
          : ""),
    )
    .join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(doc.title)}</title><style>body{max-width:760px;margin:0 auto;padding:24px;font-family:sans-serif;line-height:1.8;color:#263b38}h1{color:#287c70}h2{color:#287c70;border-bottom:2px solid #e8f2ef;padding-bottom:4px;margin-top:28px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #c8d6d1;padding:8px;text-align:left;vertical-align:top}th{background:#e8f2ef;width:11em}</style></head><body><h1>${escapeHtml(doc.title)}</h1><p>${escapeHtml(doc.lead)}</p>${body}</body></html>`;
}

export default function DocumentsViewer({ onClose }: { onClose: () => void }) {
  const [docId, setDocId] = useState("guide");
  const doc = docs.find((item) => item.id === docId) ?? docs[0];

  const saveFile = () => {
    const url = URL.createObjectURL(
      new Blob([toHtmlFile(doc)], { type: "text/html;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `sawakai-${doc.id}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const print = () => {
    document.body.classList.add("is-printing-docs");
    const cleanup = () => {
      document.body.classList.remove("is-printing-docs");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  };

  return createPortal(
    <div className="docs-backdrop">
      <section aria-labelledby="docs-title" aria-modal="true" className="docs-panel" role="dialog">
        <div className="docs-toolbar">
          <div className="docs-tabs" role="tablist">
            {docs.map((item) => (
              <button
                aria-selected={item.id === doc.id}
                className={item.id === doc.id ? "is-selected" : ""}
                key={item.id}
                onClick={() => setDocId(item.id)}
                role="tab"
              >
                {item.tab}
              </button>
            ))}
          </div>
          <button aria-label="資料を閉じる" className="docs-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="docs-actions">
          <button onClick={print}>PDFで保存・印刷</button>
          <button onClick={saveFile}>ファイルで保存</button>
        </div>
        <article className="docs-sheet">
          <h1 id="docs-title">{doc.title}</h1>
          <p>{doc.lead}</p>
          {doc.sections.map((section) => (
            <section key={section.heading}>
              <h2>{section.heading}</h2>
              {section.paragraphs?.map((p) => <p key={p}>{p}</p>)}
              {section.items && (
                <ul>
                  {section.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
              {section.rows && (
                <table>
                  <tbody>
                    {section.rows.map(([a, b]) => (
                      <tr key={a}>
                        <th>{a}</th>
                        <td>{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </article>
      </section>
    </div>,
    document.body,
  );
}
