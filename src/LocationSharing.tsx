import { useCallback, useEffect, useRef, useState } from "react";
import { projectId, publicAnonKey } from "../utils/supabase/info";
import "./LocationSharing.css";

type Location = {
  name: string;
  latitude: number;
  longitude: number;
  updatedAt: string;
};

const endpoint = `https://${projectId}.supabase.co/functions/v1/location-sharing`;
const hour = 60 * 60 * 1000;

async function request(token: string, body: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${publicAnonKey}`,
        "X-Session-Token": token,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "位置共有を利用できませんでした。");
    return result;
  } finally {
    window.clearTimeout(timeout);
  }
}

function currentPosition(): Promise<GeolocationPosition> {
  if (!navigator.geolocation) {
    return Promise.reject(new Error("この端末では位置情報を利用できません。"));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: 0,
      timeout: 15000,
    });
  });
}

function errorMessage(error: unknown) {
  if (error instanceof TypeError) return "サーバーに接続できません。通信環境をご確認ください。";
  if (error instanceof DOMException && error.name === "AbortError") return "通信に時間がかかっています。もう一度お試しください。";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
    return "位置情報が許可されていません。端末やブラウザーの設定をご確認ください。";
  }
  return "現在地を取得できませんでした。位置情報と通信の設定をご確認ください。";
}

export function useLocationSharing(token: string, groupId: string, isOpen: boolean) {
  const [enabledGroups, setEnabledGroups] = useState<string[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const enabledRef = useRef<string[]>([]);
  const lastAttempt = useRef(0);
  const lastAttemptDay = useRef("");
  const working = useRef(false);
  const pendingEnable = useRef<Promise<void> | null>(null);
  const settingsLoaded = useRef(false);
  const identity = useRef("");
  const currentToken = useRef(token);
  const currentView = useRef({ groupId, isOpen });
  identity.current = `${token}:${groupId}`;
  currentToken.current = token;
  currentView.current = { groupId, isOpen };

  const loadSettings = useCallback(async () => {
    const result = await request(token, { action: "settings" });
    const groups: string[] = result.groups;
    if (currentToken.current !== token) return [];
    settingsLoaded.current = true;
    setSettingsReady(true);
    enabledRef.current = groups;
    setEnabledGroups(groups);
    return groups;
  }, [token]);

  const refreshList = useCallback(async () => {
    const expected = `${token}:${groupId}`;
    const result = await request(token, { action: "list", groupId });
    if (identity.current !== expected) return;
    setLocations(result.locations);
    if (!result.enabled) {
      enabledRef.current = enabledRef.current.filter((id) => id !== groupId);
      setEnabledGroups(enabledRef.current);
    }
  }, [token, groupId]);

  const updateGroups = useCallback(async (groups: string[]) => {
    if (!groups.length || working.current || document.visibilityState !== "visible") return;
    working.current = true;
    lastAttempt.current = Date.now();
    lastAttemptDay.current = new Date(Date.now() + 9 * hour).toISOString().slice(0, 10);
    try {
      const position = await currentPosition();
      const outcomes = await Promise.allSettled(groups.map((id) => request(token, {
        action: "update",
        groupId: id,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      })));
      const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failed) throw failed.reason;
      setError("");
      const view = currentView.current;
      if (view.isOpen && groups.includes(view.groupId)) {
        const result = await request(token, { action: "list", groupId: view.groupId });
        if (identity.current === `${token}:${view.groupId}`) setLocations(result.locations);
      }
    } catch (reason) {
      setError(`位置を更新できませんでした。${errorMessage(reason)}`);
    } finally {
      working.current = false;
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      enabledRef.current = [];
      settingsLoaded.current = false;
      setSettingsReady(false);
      setEnabledGroups([]);
      setLocations([]);
      return;
    }
    let active = true;
    settingsLoaded.current = false;
    setSettingsReady(false);
    lastAttempt.current = 0;
    void loadSettings().then((groups) => {
      if (active) void updateGroups(groups);
    }).catch((reason) => {
      if (active) setError(`位置共有の設定を確認できませんでした。${errorMessage(reason)}`);
    });
    const tick = () => {
      const today = new Date(Date.now() + 9 * hour).toISOString().slice(0, 10);
      if (Date.now() - lastAttempt.current >= hour || today !== lastAttemptDay.current) {
        void updateGroups(enabledRef.current);
      }
    };
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [token, loadSettings, updateGroups]);

  useEffect(() => {
    setLocations([]);
    if (!token || !isOpen) return;
    void refreshList().catch((reason) => setError(errorMessage(reason)));
    const timer = window.setInterval(() => {
      void refreshList().catch((reason) => setError(errorMessage(reason)));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [token, groupId, isOpen, refreshList]);

  const enable = async () => {
    if (!window.confirm(
      "このグループで位置共有をオンにしますか？\n\n共有をオンにした参加者だけが位置を見られます。招待コードを知る人が別の名前を使うこともでき、本人確認はありません。アプリを開いている間は約1時間ごとに更新し、翌日も再開します。\n\n位置は日本時間23時59分に非表示とし、定期削除します。障害やバックアップ、外部地図側の情報は完全削除を保証できません。緊急時の居場所確認には使えません。",
    )) return;
    const operation = (async () => {
      setBusy(true);
      setError("");
      try {
        const position = await currentPosition();
        try {
          await request(token, {
            action: "enable", groupId,
            latitude: position.coords.latitude, longitude: position.coords.longitude,
          });
        } catch (reason) {
          try {
            await loadSettings();
          } catch {
            throw new Error("共有状態を確認できません。位置が共有された可能性があります。通信を回復して確認してください。");
          }
          throw reason;
        }
        await loadSettings();
        lastAttempt.current = Date.now();
        lastAttemptDay.current = new Date(Date.now() + 9 * hour).toISOString().slice(0, 10);
        await refreshList();
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    })();
    pendingEnable.current = operation;
    await operation;
    if (pendingEnable.current === operation) pendingEnable.current = null;
  };

  const disable = async () => {
    setBusy(true);
    setError("");
    try {
      await request(token, { action: "stop", groupId });
      enabledRef.current = enabledRef.current.filter((id) => id !== groupId);
      setEnabledGroups(enabledRef.current);
      setLocations([]);
    } catch (reason) {
      setError(`共有を停止できませんでした。${errorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const stopAll = async () => {
    await pendingEnable.current;
    if (settingsLoaded.current && enabledRef.current.length === 0) return;
    await request(token, { action: "stop-all" });
    enabledRef.current = [];
    setEnabledGroups([]);
    setLocations([]);
  };

  return {
    enabled: enabledGroups.includes(groupId), locations, error, busy, settingsReady,
    enable, disable, stopAll,
    retrySettings: () => void loadSettings().then(() => setError("")).catch((reason) => setError(errorMessage(reason))),
    refresh: () => void updateGroups([groupId]),
  };
}

export default function LocationSharingPanel({
  sharing,
}: {
  sharing: ReturnType<typeof useLocationSharing>;
}) {
  return (
    <section className="location-sharing" aria-labelledby="location-sharing-title">
      <h3 id="location-sharing-title">ここにいます</h3>
      <p>位置共有をオンにした仲間同士で、このグループの位置を一人ずつ確認できます。</p>
      <p>アプリを開いている間、約1時間ごとに更新します。閉じている間は更新できない場合があります。</p>
      <p>共有位置は日本時間23時59分に非表示・削除予定です。翌日はアプリを開くと自動再開します。</p>
      <p>招待コードを知る人による名前のなりすましは防げません。緊急時の居場所確認には使えません。</p>
      <p>障害やバックアップ、外部地図に渡った情報の完全削除は保証できません。</p>
      <p role="status">位置共有：<strong>{sharing.settingsReady ? (sharing.enabled ? "オン" : "オフ") : "確認できていません"}</strong></p>
      {sharing.settingsReady ? (
        <button type="button" disabled={sharing.busy} onClick={() => void (sharing.enabled ? sharing.disable() : sharing.enable())}>
          {sharing.enabled ? "位置共有をオフにする" : "ここにいます（位置共有をオン）"}
        </button>
      ) : (
        <button type="button" onClick={sharing.retrySettings}>共有状態をもう一度確認</button>
      )}
      {sharing.settingsReady && sharing.enabled && (
        <>
          <button type="button" disabled={sharing.busy} onClick={sharing.refresh}>今の位置を更新</button>
          <p>位置は現在地と異なる場合があります。地図を開くと選択した人の位置が外部サービスへ送られます。</p>
          {sharing.locations.length ? (
            <ul>
              {sharing.locations.map((location, index) => (
                <li key={`${location.name}-${index}`}>
                  <strong>{location.name}</strong>
                  <span>更新：{new Intl.DateTimeFormat("ja-JP", {
                    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  }).format(new Date(location.updatedAt))}（日本時間）</span>
                  {Date.now() - new Date(location.updatedAt).getTime() >= 2 * hour && <span>古い情報です。現在の位置とは限りません。</span>}
                  <a href={`https://www.google.com/maps/search/?api=1&query=${location.latitude}%2C${location.longitude}`} target="_blank" rel="noreferrer">Google マップで見る</a>
                  <a href={`https://maps.apple.com/?ll=${location.latitude}%2C${location.longitude}&q=${encodeURIComponent("共有された位置")}`} target="_blank" rel="noreferrer">Apple マップで見る</a>
                </li>
              ))}
            </ul>
          ) : <p>表示できる位置はまだありません。</p>}
        </>
      )}
      {sharing.error && <p className="location-sharing__error" role="alert">{sharing.error}</p>}
    </section>
  );
}
