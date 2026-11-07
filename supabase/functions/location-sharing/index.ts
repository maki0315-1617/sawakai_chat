import { createClient } from "jsr:@supabase/supabase-js@2.49.8";

const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-session-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

type Session = { name: string; expiresAt: number; groupIds?: string[] };
type Group = { id: string };
type Member = { name: string };
type Share = {
  member_name: string;
  latitude: number | null;
  longitude: number | null;
  updated_at: string | null;
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getValue(key: string): Promise<unknown> {
  const { data, error } = await client
    .from("kv_store_8e9e0c0c")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data?.value;
}

async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tokyoDay(timestamp: number): string {
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isClosedMinute(timestamp: number): boolean {
  const date = new Date(timestamp + 9 * 60 * 60 * 1000);
  return date.getUTCHours() === 23 && date.getUTCMinutes() === 59;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "操作が許可されていません。" }, 405);

  try {
    const token = request.headers.get("X-Session-Token");
    if (!token) return respond({ error: "もう一度参加してください。" }, 401);
    const session = await getValue(`sawakai:session:${token}`) as Session | undefined;
    if (!session || session.expiresAt < Date.now()) {
      return respond({ error: "参加情報の期限が切れました。" }, 401);
    }

    const input: unknown = await request.json();
    if (typeof input !== "object" || input === null || !("action" in input) || typeof input.action !== "string") {
      return respond({ error: "操作を確認できませんでした。" }, 400);
    }
    const sessionHash = await hashToken(token);
    const table = () => client.from("sawakai_location_shares");
    if (input.action === "stop-all") {
      const { error } = await table().delete().eq("session_hash", sessionHash);
      if (error) throw error;
      return respond({ stopped: true });
    }

    const groups = await getValue("sawakai:groups") as Group[] | undefined;
    const groupIds = session.groupIds?.length ? session.groupIds : ["weekend-meal"];
    if (input.action === "settings") {
      const { data, error } = await table().select("group_id,enabled")
        .eq("session_hash", sessionHash).eq("enabled", true).in("group_id", groupIds);
      if (error) throw error;
      return respond({ groups: data.map((item) => item.group_id) });
    }

    if (!("groupId" in input) || typeof input.groupId !== "string") {
      return respond({ error: "グループを確認できませんでした。" }, 400);
    }
    const groupId = input.groupId;
    if (!groupIds.includes(groupId) || !groups?.some((group) => group.id === groupId)) {
      return respond({ error: "このグループには参加していません。" }, 403);
    }
    const memberKey = groupId === "weekend-meal" ? "sawakai:members" : `sawakai:group:${groupId}:members`;
    const members = await getValue(memberKey) as Member[] | undefined;
    if (!members?.some((member) => member.name === session.name)) {
      return respond({ error: "このグループには参加していません。" }, 403);
    }

    if (input.action === "stop") {
      const { error } = await table().delete().eq("session_hash", sessionHash).eq("group_id", groupId);
      if (error) throw error;
      return respond({ stopped: true });
    }

    if (input.action === "enable" || input.action === "update") {
      if (!("latitude" in input) || !("longitude" in input) ||
        typeof input.latitude !== "number" || !Number.isFinite(input.latitude) ||
        typeof input.longitude !== "number" || !Number.isFinite(input.longitude) ||
        Math.abs(input.latitude) > 90 || Math.abs(input.longitude) > 180) {
        return respond({ error: "位置情報を確認できませんでした。" }, 400);
      }
      const now = Date.now();
      if (isClosedMinute(now)) {
        return respond({ error: "位置情報の削除時間です。翌日になってから更新します。" }, 409);
      }
      const values = {
        latitude: input.latitude,
        longitude: input.longitude,
        updated_at: new Date(now).toISOString(),
      };
      if (input.action === "enable") {
        const { error } = await table().upsert({
          session_hash: sessionHash, group_id: groupId, member_name: session.name, enabled: true, ...values,
        });
        if (error) throw error;
      } else {
        const { data, error } = await table().update(values)
          .eq("session_hash", sessionHash).eq("group_id", groupId).eq("enabled", true)
          .select("group_id").maybeSingle();
        if (error) throw error;
        if (!data) return respond({ error: "位置共有はオフになっています。" }, 409);
      }
      return respond({ updatedAt: values.updated_at });
    }

    if (input.action === "list") {
      const { data: own, error: ownError } = await table().select("enabled")
        .eq("session_hash", sessionHash).eq("group_id", groupId).maybeSingle();
      if (ownError) throw ownError;
      if (!own?.enabled) return respond({ enabled: false, locations: [] });
      const { data, error } = await client.rpc("sawakai_visible_locations", {
        requester: sessionHash, requested_group: groupId,
      });
      if (error) throw error;
      const now = Date.now();
      const locations = (data as Share[]).filter((share) =>
        !isClosedMinute(now) && share.updated_at !== null &&
        tokyoDay(Date.parse(share.updated_at)) === tokyoDay(now) &&
        members.some((member) => member.name === share.member_name)
      ).map((share) => ({
        name: share.member_name,
        latitude: share.latitude,
        longitude: share.longitude,
        updatedAt: share.updated_at,
      }));
      return respond({ enabled: true, locations });
    }
    return respond({ error: "操作を確認できませんでした。" }, 400);
  } catch (error) {
    console.error("位置共有処理に失敗しました", error instanceof Error ? error.message : "unknown error");
    return respond({ error: "位置共有の処理に失敗しました。時間をおいてお試しください。" }, 500);
  }
});
