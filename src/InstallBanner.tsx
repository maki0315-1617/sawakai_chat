import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const dismissedKey = "sawakai-install-banner-dismissed-at";
const hideDays = 3;

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIos = () => /iPad|iPhone|iPod/i.test(navigator.userAgent);

const recentlyDismissed = () => {
  const at = Number(localStorage.getItem(dismissedKey));
  return at > 0 && Date.now() - at < hideDays * 24 * 60 * 60 * 1000;
};

export default function InstallBanner() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(
    () => isStandalone() || recentlyDismissed(),
  );
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    const early = (window as unknown as { __installPrompt?: Event })
      .__installPrompt;
    if (early) setPrompt(early as InstallPromptEvent);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setPrompt(null);
      setHidden(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden) return null;

  const install = async () => {
    if (!prompt) {
      setShowGuide(true);
      return;
    }
    await prompt.prompt();
    const choice = await prompt.userChoice;
    setPrompt(null);
    if (choice.outcome === "accepted") setHidden(true);
  };

  const dismiss = () => {
    localStorage.setItem(dismissedKey, String(Date.now()));
    setHidden(true);
  };

  return (
    <section aria-label="アプリのインストール" className="install-banner">
      <div className="install-banner__main">
        <p className="install-banner__text">
          <strong>スマホにアプリを入れると、ワンタッチで開けます</strong>
        </p>
        <button
          className="install-banner__button"
          onClick={() => void install()}
          type="button"
        >
          {prompt ? "📲 アプリを入れる" : "📲 入れ方を見る"}
        </button>
        <button
          className="install-banner__later"
          onClick={dismiss}
          type="button"
        >
          あとで
        </button>
      </div>
      {showGuide && (
        <ol className="install-banner__guide">
          {isIos() ? (
            <>
              <li>画面の下（または上）にある「共有」ボタン（□に↑）を押す</li>
              <li>「ホーム画面に追加」を押す</li>
              <li>右上の「追加」を押す</li>
            </>
          ) : (
            <>
              <li>ブラウザ右上の「⋮」（メニュー）を押す</li>
              <li>「アプリをインストール」または「ホーム画面に追加」を押す</li>
              <li>「インストール」または「追加」を押す</li>
            </>
          )}
        </ol>
      )}
    </section>
  );
}
