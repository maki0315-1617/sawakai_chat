import { useEffect, useRef, useState } from "react"

import "./WalkingApp.css"
import {
  canShareWalkBySystem,
  copyWalkText,
  createWalkShareImage,
  downloadWalkImage,
  saveWalkForDesktopLine,
  sendPhoneMailWithImage,
  sharePreparedWalk,
  shareWalkBySystem,
  usesDesktopMail,
  walkMailDraftHref,
  walkShareSubject,
  walkShareText,
} from "./walkShare"
import { isDesktopDevice, isIphoneDevice } from "./voiceJoin"

type Weather = "sunny" | "cloudy" | "rain" | "hot" | "windy" | "snow"

type Condition = "good" | "tired" | "unwell"

type Position = {
  latitude: number
  longitude: number
  recordedAt: string
  breakBefore?: boolean
}

type OSMGeometryPoint = {
  lat: number
  lon: number
}
type OSMWay = {
  nodes: number[]
  geometry: OSMGeometryPoint[]
  tags: Record<string, string>
}
type RoadEdge = {
  to: number
  meters: number
  cost: number
}
type QueueEntry = {
  id: number
  cost: number
}

type WalkRecord = {
  id: string

  date: string

  kind: "walk" | "charge"

  durationMinutes: number

  review: string

  createdAt: string

  route: Position[]
  distanceMeters?: number | null
  distanceStatus?: "approximate" | "partial" | "unavailable"
  durationSeconds?: number
  plannedRoute?: Position[]
  destination?: { latitude: number; longitude: number }
  plannedDistanceMeters?: number
  plannedDurationSeconds?: number
}

type Coordinate = Pick<Position, "latitude" | "longitude">

type Recognition = {
  lang: string

  continuous: boolean

  interimResults: boolean

  onresult: ((event: {
    resultIndex: number
    results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
  }) => void) | null

  onerror: ((event: { error: string }) => void) | null

  onend: (() => void) | null

  start: () => void

  stop: () => void
}

type RecognitionWindow = Window & {
  SpeechRecognition?: new () => Recognition

  webkitSpeechRecognition?: new () => Recognition
}

const recordsStorageKey = "sawakai-walking-records-v1"

const routeRetentionMs = 7 * 24 * 60 * 60 * 1000
const maxPositionGapMs = 2 * 60 * 1000

const tileSize = 256

const mapZoom = 15
const overpassEndpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
]

const weatherLabels: Record<Weather, string> = {
  sunny: "晴れ",

  cloudy: "くもり",

  rain: "雨",

  hot: "暑い",

  windy: "風が強い",

  snow: "雪",
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear()

  const month = `${date.getMonth() + 1}`.padStart(2, "0")

  const day = `${date.getDate()}`.padStart(2, "0")

  return `${year}-${month}-${day}`
}

function cleanExpiredRoutes(records: WalkRecord[], now = Date.now()) {
  return records.map((record) => {
    const withDistance =
      record.kind === "walk" && record.distanceStatus === undefined
        ? { ...record, ...summarizeRoute(record.route, true) }
        : record
    const routesExpired =
      now - new Date(withDistance.createdAt).getTime() >= routeRetentionMs
    return routesExpired &&
      (withDistance.route.length > 0 ||
        (withDistance.plannedRoute?.length ?? 0) > 0 ||
        withDistance.destination)
      ? { ...withDistance, route: [], plannedRoute: [], destination: undefined }
      : withDistance
  })
}

function isStoredPosition(point: unknown): point is Position {
  return (
    typeof point === "object" &&
    point !== null &&
    "latitude" in point &&
    typeof point.latitude === "number" &&
    "longitude" in point &&
    typeof point.longitude === "number" &&
    "recordedAt" in point &&
    typeof point.recordedAt === "string" &&
    (!("breakBefore" in point) || typeof point.breakBefore === "boolean")
  )
}

function isCoordinate(value: unknown): value is Coordinate {
  return (
    typeof value === "object" &&
    value !== null &&
    "latitude" in value &&
    typeof value.latitude === "number" &&
    "longitude" in value &&
    typeof value.longitude === "number"
  )
}

function loadRecords(): WalkRecord[] {
  const stored = localStorage.getItem(recordsStorageKey)

  if (!stored) return []

  const parsed: unknown = JSON.parse(stored)

  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        "id" in record &&
        typeof record.id === "string" &&
        "date" in record &&
        typeof record.date === "string" &&
        "kind" in record &&
        (record.kind === "walk" || record.kind === "charge") &&
        "durationMinutes" in record &&
        typeof record.durationMinutes === "number" &&
        (!("durationSeconds" in record) ||
          (typeof record.durationSeconds === "number" &&
            Number.isFinite(record.durationSeconds) &&
            record.durationSeconds >= 0)) &&
        "createdAt" in record &&
        typeof record.createdAt === "string" &&
        "review" in record &&
        typeof record.review === "string" &&
        "route" in record &&
        Array.isArray(record.route) &&
        (!("distanceMeters" in record) ||
          record.distanceMeters === null ||
          (typeof record.distanceMeters === "number" &&
            Number.isFinite(record.distanceMeters) &&
            record.distanceMeters >= 0)) &&
        (!("distanceStatus" in record) ||
          record.distanceStatus === "approximate" ||
          record.distanceStatus === "partial" ||
          record.distanceStatus === "unavailable") &&
        (!("durationSeconds" in record) ||
          (typeof record.durationSeconds === "number" &&
            Number.isFinite(record.durationSeconds) &&
            record.durationSeconds >= 0)) &&
        (!("plannedRoute" in record) ||
          (Array.isArray(record.plannedRoute) &&
            record.plannedRoute.every(isStoredPosition))) &&
        (!("destination" in record) ||
          record.destination === undefined || isCoordinate(record.destination)) &&
        (!("plannedDistanceMeters" in record) ||
          (typeof record.plannedDistanceMeters === "number" &&
            Number.isFinite(record.plannedDistanceMeters) &&
            record.plannedDistanceMeters >= 0)) &&
        (!("plannedDurationSeconds" in record) ||
          (typeof record.plannedDurationSeconds === "number" &&
            Number.isFinite(record.plannedDurationSeconds) &&
            record.plannedDurationSeconds >= 0)) &&
        record.route.every(isStoredPosition),
    )
  ) {
    throw new Error("散歩の記録を読み取れませんでした。")
  }

  return cleanExpiredRoutes(parsed as WalkRecord[])
}

function projectToWorld(latitude: number, longitude: number, zoom = mapZoom) {
  const scale = tileSize * 2 ** zoom

  const x = ((longitude + 180) / 360) * scale

  const sinLatitude = Math.sin((latitude * Math.PI) / 180)

  const y =
    (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) *
    scale

  return { x, y }
}

function distanceMeters(
  first: Pick<Position, "latitude" | "longitude">,
  second: Pick<Position, "latitude" | "longitude">,
) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const latitudeDifference = radians(second.latitude - first.latitude)
  const longitudeDifference = radians(second.longitude - first.longitude)
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(radians(first.latitude)) *
      Math.cos(radians(second.latitude)) *
      Math.sin(longitudeDifference / 2) ** 2
  return (
    6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  )
}

function isRouteGap(first: Position, second: Position) {
  const gap = Date.parse(second.recordedAt) - Date.parse(first.recordedAt)
  return (
    second.breakBefore === true ||
    !Number.isFinite(gap) ||
    gap <= 0 ||
    gap > maxPositionGapMs ||
    distanceMeters(first, second) > (gap / 1000) * 4 + 50
  )
}

function summarizeRoute(route: Position[], partial: boolean): {
  distanceMeters: number | null
  distanceStatus: "approximate" | "partial" | "unavailable"
} {
  let distance = 0
  let segments = 0
  for (let index = 1; index < route.length; index += 1) {
    if (isRouteGap(route[index - 1], route[index])) {
      partial = true
    } else {
      distance += distanceMeters(route[index - 1], route[index])
      segments += 1
    }
  }
  return segments === 0
    ? { distanceMeters: null, distanceStatus: "unavailable" }
    : {
        distanceMeters: distance,
        distanceStatus: partial ? "partial" : "approximate",
      }
}

function distanceText(
  record: Pick<WalkRecord, "distanceMeters" | "distanceStatus">,
) {
  if (record.distanceMeters == null || record.distanceStatus === "unavailable") {
    return "距離：記録なし"
  }
  const distance =
    record.distanceMeters < 1000
      ? `約${Math.round(record.distanceMeters / 10) * 10} m`
      : `約${(record.distanceMeters / 1000).toFixed(1)} km`
  return `距離：${distance}${record.distanceStatus === "partial" ? "（一部のみ記録）" : "（目安）"}`
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remainingSeconds = safeSeconds % 60
  return `${hours > 0 ? `${hours}時間` : ""}${minutes > 0 ? `${minutes}分` : ""}${remainingSeconds > 0 || safeSeconds === 0 ? `${remainingSeconds}秒` : ""}`
}

function roadPriority(tags: Record<string, string>) {
  const highway = tags.highway
  const hasSidewalk = ["yes", "both", "left", "right"].includes(
    tags.sidewalk ?? "",
  )
  if (
    !highway ||
    ["no", "private"].includes(tags.access ?? "") ||
    ["no", "private"].includes(tags.foot ?? "") ||
    tags.footway === "no" ||
    tags.construction ||
    tags.sac_scale
  ) {
    return 0
  }
  if (["footway", "pedestrian", "path"].includes(highway)) {
    return tags.surface === "mud" || tags.surface === "sand" ? 2 : 3.5
  }
  if (["primary", "secondary", "tertiary"].includes(highway)) {
    if (!hasSidewalk && tags.foot !== "yes") return 0
    return highway === "primary" ? 5 : highway === "secondary" ? 4 : 3
  }
  if (["residential", "living_street"].includes(highway)) return 2
  if (["unclassified", "service"].includes(highway)) {
    return hasSidewalk || tags.foot === "yes" ? 1 : 0
  }
  return 0
}

function parseOSMWays(value: unknown): OSMWay[] {
  if (typeof value !== "object" || value === null || !("elements" in value)) {
    throw new Error("地図データの形式を確認できませんでした。")
  }
  const elements = value.elements
  if (!Array.isArray(elements)) {
    throw new Error("近くの道を読み取れませんでした。")
  }
  return elements.filter((element): element is OSMWay => {
    if (typeof element !== "object" || element === null) return false
    if (!("nodes" in element) || !Array.isArray(element.nodes)) return false
    if (!("geometry" in element) || !Array.isArray(element.geometry))
      return false
    if (
      !("tags" in element) ||
      typeof element.tags !== "object" ||
      element.tags === null
    ) {
      return false
    }
    return (
      typeof element.tags.highway === "string" &&
      element.nodes.length === element.geometry.length &&
      element.nodes.every((node: unknown) => typeof node === "number") &&
      element.geometry.every(
        (point: unknown) =>
          typeof point === "object" &&
          point !== null &&
          "lat" in point &&
          typeof point.lat === "number" &&
          "lon" in point &&
          typeof point.lon === "number",
      )
    )
  })
}

async function fetchOSMWays(query: string): Promise<OSMWay[]> {
  const controllers = overpassEndpoints.map(() => new AbortController())
  const failures: unknown[] = []
  let remaining = overpassEndpoints.length

  try {
    return await new Promise<OSMWay[]>((resolve, reject) => {
      overpassEndpoints.forEach((endpoint, index) => {
        const controller = controllers[index]
        const timeout = window.setTimeout(() => controller.abort(), 8000)

        fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`地図サーバーの応答: ${response.status}`)
            }
            return response.json()
          })
          .then((value) => {
            const ways = parseOSMWays(value)
            if (ways.length === 0) {
              throw new Error("近くの道が見つかりませんでした。")
            }
            return ways
          })
          .then(resolve)
          .catch((error: unknown) => {
            failures.push(error)
            remaining -= 1
            if (remaining === 0) reject(failures)
          })
          .finally(() => window.clearTimeout(timeout))
      })
    })
  } catch {
    if (
      failures.length > 0 &&
      failures.every(
        (error) => error instanceof DOMException && error.name === "AbortError",
      )
    ) {
      throw new Error(
        "地図データのサーバーから時間内に応答がありませんでした。通信環境を確認してください。下のボタンから現在地周辺の地図を開いて、歩道のある道をご確認いただけます。",
      )
    }

    const networkFailure = failures.find(
      (error) => error instanceof TypeError,
    )
    if (networkFailure) {
      throw new Error(
        "地図データのサーバーに接続できませんでした。通信環境をご確認ください。下のボタンから現在地周辺の地図を開けます。",
      )
    }

    throw new Error(
      "近くの道の地図データを取得できませんでした。下の地図で周辺の道をご確認ください。",
    )
  } finally {
    controllers.forEach((controller) => controller.abort())
  }
}

function pushQueue(queue: QueueEntry[], entry: QueueEntry) {
  queue.push(entry)
  let index = queue.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (queue[parent].cost <= queue[index].cost) break
    ;[queue[parent], queue[index]] = [queue[index], queue[parent]]
    index = parent
  }
}

function popQueue(queue: QueueEntry[]) {
  const first = queue[0]
  const last = queue.pop()
  if (!last || queue.length === 0) return first
  queue[0] = last
  let index = 0
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index
    if (left < queue.length && queue[left].cost < queue[smallest].cost) {
      smallest = left
    }
    if (right < queue.length && queue[right].cost < queue[smallest].cost) {
      smallest = right
    }
    if (smallest === index) break
    ;[queue[index], queue[smallest]] = [queue[smallest], queue[index]]
    index = smallest
  }
  return first
}

function buildSuggestedRoute(
  ways: OSMWay[],
  start: Pick<Position, "latitude" | "longitude">,
  targetMeters: number,
  random = Math.random,
) {
  const pointsById = new Map<number, OSMGeometryPoint>()
  const graph = new Map<number, RoadEdge[]>()
  for (const way of ways) {
    const priority = roadPriority(way.tags)
    if (!priority) continue
    way.nodes.forEach((id, index) => {
      const point = way.geometry[index]
      pointsById.set(id, point)
      if (!graph.has(id)) graph.set(id, [])
      if (index === 0) return
      const previousId = way.nodes[index - 1]
      const previous = way.geometry[index - 1]
      const meters = distanceMeters(
        { latitude: previous.lat, longitude: previous.lon },
        { latitude: point.lat, longitude: point.lon },
      )
      if (meters <= 0 || meters > 250) return
      const cost = meters / priority
      graph.get(previousId)?.push({ to: id, meters, cost })
      graph.get(id)?.push({ to: previousId, meters, cost })
    })
  }

  if (graph.size === 0) {
    throw new Error("近くに歩行者道や歩道の情報が見つかりませんでした。")
  }

  let startNode = -1
  let closestDistance = Number.POSITIVE_INFINITY
  for (const [id, point] of pointsById) {
    if (!graph.has(id)) continue
    const distance = distanceMeters(start, {
      latitude: point.lat,
      longitude: point.lon,
    })
    if (distance < closestDistance) {
      closestDistance = distance
      startNode = id
    }
  }
  if (startNode < 0 || closestDistance > 120) {
    throw new Error(
      "現在地の近くに散歩コースを作れる道が見つかりませんでした。",
    )
  }

  const costs = new Map<number, number>([[startNode, 0]])
  const metersFromStart = new Map<number, number>([[startNode, 0]])
  const previousNode = new Map<number, number>()
  const queue: QueueEntry[] = []
  pushQueue(queue, { id: startNode, cost: 0 })
  while (queue.length) {
    const current = popQueue(queue)
    if (!current) break
    if (current.cost !== costs.get(current.id)) continue
    for (const edge of graph.get(current.id) ?? []) {
      const nextCost = current.cost + edge.cost
      if (nextCost >= (costs.get(edge.to) ?? Number.POSITIVE_INFINITY)) continue
      costs.set(edge.to, nextCost)
      metersFromStart.set(
        edge.to,
        (metersFromStart.get(current.id) ?? 0) + edge.meters,
      )
      previousNode.set(edge.to, current.id)
      pushQueue(queue, { id: edge.to, cost: nextCost })
    }
  }

  const candidates = [...metersFromStart.entries()]
    .filter(
      ([id, meters]) =>
        id !== startNode &&
        meters >= targetMeters * 0.68 &&
        meters <= targetMeters * 1.32,
    )
    .sort(
      (first, second) =>
        Math.abs(first[1] - targetMeters) - Math.abs(second[1] - targetMeters),
    )
  if (candidates.length === 0) {
    throw new Error(
      "選んだ時間に近いコースが見つかりませんでした。時間を長めにするか、近くの道を確認してください。",
    )
  }

  const bestDifference = Math.abs(candidates[0][1] - targetMeters)
  const nearbyCandidates = candidates.filter(
    ([, meters]) =>
      Math.abs(meters - targetMeters) <= bestDifference + targetMeters * 0.12,
  )
  const [destination] =
    nearbyCandidates[Math.floor(random() * nearbyCandidates.length)]
  const pathIds = [destination]
  while (pathIds[pathIds.length - 1] !== startNode) {
    const parent = previousNode.get(pathIds[pathIds.length - 1])
    if (parent === undefined) {
      throw new Error(
        "散歩コースを作成できませんでした。もう一度お試しください。",
      )
    }
    pathIds.push(parent)
  }
  pathIds.reverse()
  const now = new Date().toISOString()
  return pathIds.map((id) => {
    const point = pointsById.get(id)
    if (!point) {
      throw new Error("散歩コースの位置を読み取れませんでした。")
    }
    return {
      latitude: point.lat,
      longitude: point.lon,
      recordedAt: now,
    }
  })
}

async function fetchPedestrianRoute(
    start: Coordinate,
    destination: Coordinate,
  ): Promise<{ route: Position[]; distanceMeters: number; durationSeconds: number }> {
    const coordinates = `${start.longitude},${start.latitude};${destination.longitude},${destination.latitude}`
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch(
        `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`,
        { signal: controller.signal },
      )
      if (!response.ok) throw new Error("徒歩経路を取得できませんでした。")
      const result = (await response.json()) as {
        code?: string
        routes?: Array<{
          distance?: number
          duration?: number
          geometry?: { coordinates?: number[][] }
        }>
      }
      const selected = result.routes?.[0]
      const points = selected?.geometry?.coordinates
      if (
        result.code !== "Ok" ||
        !selected ||
        !Number.isFinite(selected.distance) ||
        !Number.isFinite(selected.duration) ||
        !points ||
        points.length < 2 ||
        points.some(
          (point) =>
            point.length < 2 ||
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]),
        )
      ) {
        throw new Error("徒歩経路が見つかりませんでした。地図上の別の地点を選んでください。")
      }
      const recordedAt = new Date().toISOString()
      return {
        route: points.map(([longitude, latitude]) => ({
          latitude,
          longitude,
          recordedAt,
        })),
        distanceMeters: selected.distance!,
        durationSeconds: selected.duration!,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("徒歩経路の検索に時間がかかっています。もう一度お試しください。")
      }
      if (error instanceof TypeError) {
        throw new Error("徒歩経路サービスに接続できません。通信状況をご確認ください。")
      }
      throw error
    } finally {
      window.clearTimeout(timeout)
    }
  }

function getSafetyMessage(
  condition: Condition,
  weather: Weather,
  hour: number,
) {
  if (condition === "unwell") {
    return {
      title: "今日は無理をせず、充電日にしませんか",

      message: "体調を大切にすることも、続けるための大切な一歩です。",

      rest: true,
    }
  }

  if (weather === "snow") {
    return {
      title: "雪の日は、無理をせず充電日もおすすめです",

      message:
        "道が凍って滑りやすいことがあります。路面の様子を確認し、心配な場合は今日はお休みしましょう。",

      rest: true,
    }
  }

  if (weather === "hot" || weather === "rain" || weather === "windy") {
    return {
      title: "今日は短めにするか、お休みもおすすめです",

      message: `${weatherLabels[weather]}のため、外の様子を確認して無理のない選択をしましょう。`,

      rest: true,
    }
  }

  if (hour < 6 || hour >= 18) {
    return {
      title: "明るい時間のお散歩がおすすめです",

      message:
        "暗い時間帯は足元や周りに気をつけてください。今日は充電日も選べます。",

      rest: true,
    }
  }

  if (condition === "tired") {
    return {
      title: "今日は10分くらいのゆっくり散歩はいかがですか",

      message: "途中で疲れたら、いつでも休んで大丈夫です。",

      rest: false,
    }
  }

  return {
    title: "気持ちよく歩けそうですね",

    message: "まずは15分を目安に、ご自分のペースで楽しみましょう。",

    rest: false,
  }
}

function MapPreview({
  position,

  route,
  plannedRoute = [],
}: {
  position: Position | null

  route: Position[]
  plannedRoute?: Position[]
}) {
  if (!position) {
    return (
      <div className="walk-map walk-map--empty">
        <div className="walk-map__placeholder" aria-hidden="true">
          <span className="walk-map__road walk-map__road--one" />
          <span className="walk-map__road walk-map__road--two" />
          <span className="walk-map__park">公園</span>
          <span className="walk-map__pin">●</span>
        </div>
        <p>位置情報を使わない場合、地図は表示せず時間のみ記録します。</p>
      </div>
    )
  }

  const center = projectToWorld(position.latitude, position.longitude)

  const centerTileX = Math.floor(center.x / tileSize)

  const centerTileY = Math.floor(center.y / tileSize)

  const startX = centerTileX - 1

  const startY = centerTileY - 1

  const mapWidth = tileSize * 3

  const mapHeight = tileSize * 2

  const xOffset = center.x - startX * tileSize

  const yOffset = center.y - startY * tileSize

  const routePoints = route.map((point) => {
    const projected = projectToWorld(point.latitude, point.longitude)
    return {
      x: projected.x - startX * tileSize,
      y: projected.y - startY * tileSize,
    }
  })

  const plannedLine = plannedRoute
    .map((point) => {
      const projected = projectToWorld(point.latitude, point.longitude)
      return `${projected.x - startX * tileSize},${projected.y - startY * tileSize}`
    })
    .join(" ")

  return (
    <div className="walk-map" aria-label="現在地と歩いた経路の地図">
      <svg
        className="walk-map__tiles"
        viewBox={`0 0 ${mapWidth} ${mapHeight}`}
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label="OpenStreetMapの地図"
      >
        {[-1, 0, 1].flatMap((column) =>
          [-1, 0].map((row) => {
            const x = centerTileX + column

            const y = centerTileY + row

            const tileX = x - startX

            const tileY = y - startY

            return (
              <image
                key={`${x}-${y}`}
                href={`https://tile.openstreetmap.org/${mapZoom}/${x}/${y}.png`}
                x={tileX * tileSize}
                y={tileY * tileSize}
                width={tileSize}
                height={tileSize}
              />
            )
          }),
        )}
        {routePoints.slice(1).map((point, index) =>
          isRouteGap(route[index], route[index + 1]) ? null : (
            <line
              key={index}
              x1={routePoints[index].x}
              y1={routePoints[index].y}
              x2={point.x}
              y2={point.y}
              stroke="#2f7d67"
              strokeWidth="7"
              strokeLinecap="round"
            />
          ),
        )}
        {plannedRoute.length > 1 && (
          <polyline
            points={plannedLine}
            fill="none"
            stroke="#bd7734"
            strokeWidth="7"
            strokeDasharray="12 8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        <circle
          cx={xOffset}
          cy={yOffset}
          r="17"
          fill="#ffffff"
          stroke="#246b59"
          strokeWidth="6"
        />
        <circle cx={xOffset} cy={yOffset} r="7" fill="#246b59" />
      </svg>
      <span className="walk-map__attribution">
        © OpenStreetMap contributors
      </span>
      <span className="walk-map__marker-label">現在地</span>
    </div>
  )
}

function DestinationMap({
    position,
    destination,
    route,
    onSelect,
  }: {
    position: Coordinate
    destination: Coordinate | null
    route: Position[]
    onSelect: (coordinate: Coordinate) => void
  }) {
    const [zoom, setZoom] = useState(15)
    const [pan, setPan] = useState({ x: 0, y: 0 })
    const dragRef = useRef<{
      pointerId: number
      clientX: number
      clientY: number
      panX: number
      panY: number
    } | null>(null)
    const didDragRef = useRef(false)
    const mapWidth = 768
    const mapHeight = 427
    const center = projectToWorld(position.latitude, position.longitude, zoom)
    const left = center.x - mapWidth / 2 - pan.x
    const top = center.y - mapHeight / 2 - pan.y
    const tileCount = 2 ** zoom
    const tiles = []
    for (
      let x = Math.floor(left / tileSize);
      x <= Math.floor((left + mapWidth) / tileSize);
      x += 1
    ) {
      for (
        let y = Math.floor(top / tileSize);
        y <= Math.floor((top + mapHeight) / tileSize);
        y += 1
      ) {
        if (y < 0 || y >= tileCount) continue
        tiles.push(
          <image
            key={`${x}-${y}`}
            href={`https://tile.openstreetmap.org/${zoom}/${((x % tileCount) + tileCount) % tileCount}/${y}.png`}
            x={x * tileSize - left}
            y={y * tileSize - top}
            width={tileSize}
            height={tileSize}
          />,
        )
      }
    }
    const toMapPoint = (coordinate: Coordinate) => {
      const point = projectToWorld(coordinate.latitude, coordinate.longitude, zoom)
      return { x: point.x - left, y: point.y - top }
    }
    const originPoint = toMapPoint(position)
    const routePoints = route.map(toMapPoint)
    const destinationPoint = destination ? toMapPoint(destination) : null

    return (
      <div className="walk-destination-map">
        <div className="walk-map">
          <svg
            className="walk-map__tiles walk-destination-map__tiles"
            viewBox={`0 0 ${mapWidth} ${mapHeight}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="地図。ドラッグして移動し、タップして目的地を選択"
            onPointerDown={(event) => {
              dragRef.current = {
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                panX: pan.x,
                panY: pan.y,
              }
              didDragRef.current = false
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.pointerId !== event.pointerId) return
              const deltaX = event.clientX - drag.clientX
              const deltaY = event.clientY - drag.clientY
              if (Math.abs(deltaX) + Math.abs(deltaY) > 6) {
                didDragRef.current = true
                setPan({ x: drag.panX + deltaX, y: drag.panY + deltaY })
              }
            }}
            onPointerUp={() => {
              dragRef.current = null
            }}
            onPointerCancel={() => {
              dragRef.current = null
            }}
            onClick={(event) => {
              if (didDragRef.current) {
                didDragRef.current = false
                return
              }
              const bounds = event.currentTarget.getBoundingClientRect()
              const worldX = left + ((event.clientX - bounds.left) / bounds.width) * mapWidth
              const worldY = top + ((event.clientY - bounds.top) / bounds.height) * mapHeight
              const scale = tileSize * 2 ** zoom
              const rawLongitude = (worldX / scale) * 360 - 180
              const latitude =
                (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * worldY) / scale)) *
                  180) /
                Math.PI
              onSelect({
                latitude: Math.max(-85.0511, Math.min(85.0511, latitude)),
                longitude: ((rawLongitude + 180) % 360 + 360) % 360 - 180,
              })
            }}
          >
            {tiles}
            {routePoints.length > 1 && (
              <polyline
                points={routePoints.map((point) => `${point.x},${point.y}`).join(" ")}
                fill="none"
                stroke="#c15b38"
                strokeWidth="7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            <circle
              cx={originPoint.x}
              cy={originPoint.y}
              r="14"
              fill="#fff"
              stroke="#246b59"
              strokeWidth="5"
            />
            <circle cx={originPoint.x} cy={originPoint.y} r="5" fill="#246b59" />
            <text
              x={originPoint.x}
              y={originPoint.y - 20}
              fill="#245f4c"
              stroke="#fff"
              strokeWidth="4"
              paintOrder="stroke"
              textAnchor="middle"
              fontSize="16"
              fontWeight="700"
            >
              現在地
            </text>
            {destinationPoint && (
              <g pointerEvents="none">
                <circle
                  cx={destinationPoint.x}
                  cy={destinationPoint.y}
                  r="15"
                  fill="#c15b38"
                  stroke="#fff"
                  strokeWidth="4"
                />
                <circle cx={destinationPoint.x} cy={destinationPoint.y} r="4" fill="#fff" />
              </g>
            )}
          </svg>
          <span className="walk-map__attribution">© OpenStreetMap contributors</span>
        </div>
        <div className="walk-map-controls" role="group" aria-label="目的地選択地図の拡大縮小">
          <button type="button" aria-label="地図を拡大" disabled={zoom >= 18} onClick={() => { setZoom((value) => Math.min(18, value + 1)); setPan({ x: 0, y: 0 }) }}>＋</button>
          <button type="button" aria-label="地図を縮小" disabled={zoom <= 12} onClick={() => { setZoom((value) => Math.max(12, value - 1)); setPan({ x: 0, y: 0 }) }}>−</button>
        </div>
        <p className="walk-map-pick-hint">地図をドラッグして移動し、タップして目的地を選択します</p>
      </div>
    )
  }

function SavedRouteMap({
    route,
    plannedRoute = [],
  }: {
    route: Position[]
    plannedRoute?: Position[]
  }) {
  const [zoomOffset, setZoomOffset] = useState(0)
  const [tileError, setTileError] = useState(false)
  const [tileAttempt, setTileAttempt] = useState(0)
  const allPoints = [...route, ...plannedRoute]
  const atBaseZoom = allPoints.map((point) =>
    projectToWorld(point.latitude, point.longitude, 16),
  )
  const minX = Math.min(...atBaseZoom.map((point) => point.x))
  const maxX = Math.max(...atBaseZoom.map((point) => point.x))
  const minY = Math.min(...atBaseZoom.map((point) => point.y))
  const maxY = Math.max(...atBaseZoom.map((point) => point.y))
  const span = Math.max((maxX - minX) / 600, (maxY - minY) / 400, 1)
  const fitZoom = Math.max(2, Math.min(16, 16 - Math.ceil(Math.log2(span))))
  const zoom = Math.max(2, Math.min(18, fitZoom + zoomOffset))
  const scale = 2 ** (zoom - 16)
  const left = ((minX + maxX) / 2) * scale - 384
  const top = ((minY + maxY) / 2) * scale - 256
  const tileCount = 2 ** zoom
  const tiles = []
  for (
    let x = Math.floor(left / tileSize);
    x <= Math.floor((left + 768) / tileSize);
    x += 1
  ) {
    for (
      let y = Math.floor(top / tileSize);
      y <= Math.floor((top + 512) / tileSize);
      y += 1
    ) {
      if (y < 0 || y >= tileCount) continue
      tiles.push(
        <image
          key={`${tileAttempt}-${x}-${y}`}
          href={`https://tile.openstreetmap.org/${zoom}/${((x % tileCount) + tileCount) % tileCount}/${y}.png`}
          onError={() => setTileError(true)}
          x={x * tileSize - left}
          y={y * tileSize - top}
          width={tileSize}
          height={tileSize}
        />,
      )
    }
  }
  const points = route.map((point) => {
    const projected = projectToWorld(point.latitude, point.longitude, zoom)
    return { x: projected.x - left, y: projected.y - top }
  })
  const plannedPoints = plannedRoute.map((point) => {
    const projected = projectToWorld(point.latitude, point.longitude, zoom)
    return { x: projected.x - left, y: projected.y - top }
  })

  return (
    <div className="walk-saved-route">
      <div className="walk-map">
        <svg
          className="walk-map__tiles"
          viewBox="0 0 768 512"
          role="img"
          aria-label="記録された散歩経路の地図"
        >
          {tiles}
          {points.slice(1).map((point, index) =>
            isRouteGap(route[index], route[index + 1]) ? null : (
              <line
                key={index}
                x1={points[index].x}
                y1={points[index].y}
                x2={point.x}
                y2={point.y}
                stroke="#2f7d67"
                strokeWidth="7"
                strokeLinecap="round"
              />
            ),
          )}
          {plannedPoints.length > 1 && (
            <polyline
              points={plannedPoints
                .map((point) => `${point.x},${point.y}`)
                .join(" ")}
              fill="none"
              stroke="#c15b38"
              strokeWidth="6"
              strokeDasharray="12 8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {points.map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r="4" fill="#2f7d67" />
          ))}
        </svg>
        <a className="walk-map__attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          © OpenStreetMap contributors
        </a>
      </div>
      <div className="walk-map-controls" role="group" aria-label="記録した経路の地図操作">
        <button type="button" disabled={zoom >= 18} onClick={() => setZoomOffset(zoom - fitZoom + 1)}>拡大する ＋</button>
        <button type="button" disabled={zoom <= 2} onClick={() => setZoomOffset(zoom - fitZoom - 1)}>小さくする −</button>
        <button type="button" onClick={() => setZoomOffset(0)}>経路を全体表示</button>
      </div>
      {tileError && (
        <div role="status">
          <p>地図画像を読み込めませんでした。通信環境を確認してください。</p>
          <button
            className="walk-view-route-button"
            type="button"
            onClick={() => {
              setTileError(false)
              setTileAttempt((attempt) => attempt + 1)
            }}
          >
            地図を再読み込み
          </button>
        </div>
      )}
      <p>線が途切れた場所は、位置を続けて記録できなかった区間です。地図画像の取得時に経路周辺の位置が地図サービスに送信されます。</p>
    </div>
  )
}

function formatMonth(date = new Date()) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`
}

function walkWhenLabel(record: WalkRecord) {
  const [, month, day] = record.date.split("-")
  const savedAt = new Date(record.createdAt)
  const time = Number.isNaN(savedAt.getTime())
    ? ""
    : savedAt.toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
      })
  return `${Number(month)}月${Number(day)}日${time ? ` ${time}` : ""}`
}

function shareMapKind(record: WalkRecord) {
  if (record.kind !== "walk") return "none" as const
  const walked = record.route.length > 0
  const planned = (record.plannedRoute?.length ?? 0) > 0
  if (walked && planned) return "both" as const
  if (walked) return "walked" as const
  if (planned) return "planned" as const
  return "none" as const
}

export type WalkShareGroup = { id: string; name: string }

export default function WalkingApp({
  onBack,
  onSentToGroup,
  shareGroups = [],
  defaultShareGroupId = "",
  onShareToGroup,
}: {
  onBack: () => void
  onSentToGroup?: () => void
  shareGroups?: WalkShareGroup[]
  defaultShareGroupId?: string
  onShareToGroup?: (input: {
    groupId: string
    text: string
    image?: Blob
  }) => Promise<void>
}) {
  const [initialRecords] = useState(() => {
    try {
      return { records: loadRecords(), error: "" }
    } catch (error) {
      console.error("散歩の記録を読み込めませんでした", error)
      return {
        records: [] as WalkRecord[],
        error:
          "保存済みの記録を読み込めませんでした。データは上書きせず、そのまま残しています。",
      }
    }
  })
  const [records, setRecords] = useState<WalkRecord[]>(initialRecords.records)
  const [storageError, setStorageError] = useState(initialRecords.error)

  const [screen, setScreen] = useState<"home" | "month" | "review">("home")
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [calendarOpen, setCalendarOpen] = useState(false)
  const calendarDialogRef = useRef<HTMLDialogElement>(null)
  const [expandedRouteId, setExpandedRouteId] = useState<string | null>(null)

  const [condition, setCondition] = useState<Condition>("good")

  const [weather, setWeather] = useState<Weather>("sunny")

  const [returnToStart, setReturnToStart] = useState(true)

  const [isWalking, setIsWalking] = useState(false)
  const [isReturning, setIsReturning] = useState(false)
  const [showArrivalChoices, setShowArrivalChoices] = useState(false)
  const [extendingRoute, setExtendingRoute] = useState(false)
  const [extraPlannedRoute, setExtraPlannedRoute] = useState<Position[]>([])
  const [extraDistanceMeters, setExtraDistanceMeters] = useState(0)
  const [extraDurationSeconds, setExtraDurationSeconds] = useState(0)
  const legBeforeExtend = useRef<Position[] | null>(null)
  const destinationBeforeExtend = useRef<Coordinate | null>(null)
  const distanceBeforeExtend = useRef<number | null>(null)
  const durationBeforeExtend = useRef<number | null>(null)

  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const [locationEnabled, setLocationEnabled] = useState(false)
  const [saveRoute, setSaveRoute] = useState(false)

  const [locationError, setLocationError] = useState("")

  const [currentPosition, setCurrentPosition] = useState<Position | null>(null)

  const [route, setRoute] = useState<Position[]>([])
  const [isFindingRoute, setIsFindingRoute] = useState(false)
  const [destinationMapOpen, setDestinationMapOpen] = useState(false)
  const [selectedDestination, setSelectedDestination] = useState<Coordinate | null>(null)
  const [destinationRoute, setDestinationRoute] = useState<Position[]>([])
  const [destinationDistanceMeters, setDestinationDistanceMeters] = useState<number | null>(null)
  const [destinationDurationSeconds, setDestinationDurationSeconds] = useState<number | null>(null)
  const [destinationError, setDestinationError] = useState("")

  const [review, setReview] = useState("")

  const [pendingKind, setPendingKind] = useState<"walk" | "charge">("walk")

  const [deleteTarget, setDeleteTarget] = useState<WalkRecord | null>(null)
  const [shareRequest, setShareRequest] = useState<{
    record: WalkRecord
    channel: "external" | "group"
  } | null>(null)
  const [savedForShare, setSavedForShare] = useState<WalkRecord | null>(null)
  const [shareGroupId, setShareGroupId] = useState(defaultShareGroupId)
  const [includeReview, setIncludeReview] = useState(true)
  const [shareError, setShareError] = useState("")
  const [shareNotice, setShareNotice] = useState("")
  const [isSharing, setIsSharing] = useState(false)
  const [shareImageUrl, setShareImageUrl] = useState<string | null>(null)
  const [shareImageReady, setShareImageReady] = useState(true)
  const [shareMapNote, setShareMapNote] = useState("")
  const [desktopGuide, setDesktopGuide] = useState<
    null | "mail" | "phone-mail" | "line" | "system-share"
  >(null)
  const [lineTextCopied, setLineTextCopied] = useState(false)
  const [shareAction, setShareAction] = useState<
    "sheet" | "line" | "mail" | null
  >(null)

  const [isListening, setIsListening] = useState(false)
  const [isStoppingVoice, setIsStoppingVoice] = useState(false)

  const [voiceError, setVoiceError] = useState("")
  const [voiceStatus, setVoiceStatus] = useState("")

  const [showLocationNotice, setShowLocationNotice] = useState(false)
  const [showReturnPrompt, setShowReturnPrompt] = useState(false)

  const watchId = useRef<number | null>(null)

  const startedAt = useRef<number | null>(null)

  const routeRef = useRef<Position[]>([])

  const lastRecordedAt = useRef(0)
  const trackingStartedAt = useRef(0)
  const routePartial = useRef(false)
  const breakNextPoint = useRef(false)

  const recognitionRef = useRef<Recognition | null>(null)
  const reviewInputRef = useRef<HTMLTextAreaElement>(null)
  const shareImageFile = useRef<File | null>(null)
  const sharePreviewUrl = useRef<string | null>(null)
  const voiceActiveRef = useRef(false)
  const voiceRestartTimer = useRef<number | null>(null)
  const voiceStatusAfterStop = useRef<string | null>(null)

  const stoppedVoiceStatus = () => {
    const next = voiceStatusAfterStop.current
    voiceStatusAfterStop.current = null
    return next ?? "音声入力を終了しました。"
  }

  const stopVoiceReview = () => {
    voiceActiveRef.current = false
    setVoiceStatus("音声入力を終了しています…")
    if (voiceRestartTimer.current !== null) {
      window.clearTimeout(voiceRestartTimer.current)
      voiceRestartTimer.current = null
    }
    if (recognitionRef.current) {
      setIsStoppingVoice(true)
      try {
        recognitionRef.current.stop()
      } catch {
        recognitionRef.current = null
        setIsListening(false)
        setIsStoppingVoice(false)
        setVoiceStatus(stoppedVoiceStatus())
      }
    } else {
      setIsListening(false)
      setIsStoppingVoice(false)
      setVoiceStatus(stoppedVoiceStatus())
    }
  }

  const openKeyboardMicrophone = () => {
    const guide =
      "キーボードに出たマイクを押してお話しください。話した文字は、上の欄に入ります。"
    setVoiceError("")
    const listening = voiceActiveRef.current || recognitionRef.current !== null
    if (listening) {
      voiceStatusAfterStop.current = guide
      stopVoiceReview()
    } else {
      setVoiceStatus(guide)
    }
    reviewInputRef.current?.focus()
  }

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  useEffect(() => {
    if (calendarOpen && calendarDialogRef.current && !calendarDialogRef.current.open) {
      calendarDialogRef.current.showModal()
    }
  }, [calendarOpen])

  useEffect(() => {
    if (initialRecords.error) return
    try {
      localStorage.setItem(recordsStorageKey, JSON.stringify(records))

      setStorageError("")
    } catch (error) {
      console.error("散歩の記録を保存できませんでした", error)

      setStorageError(
        "記録を保存できませんでした。端末の空き容量をご確認ください。",
      )
    }
  }, [initialRecords.error, records])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRecords((current) => {
        const cleaned = cleanExpiredRoutes(current)
        return cleaned.some((record, index) => record !== current[index])
          ? cleaned
          : current
      })
    }, 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const releasePreview = () => {
      if (!sharePreviewUrl.current) return
      URL.revokeObjectURL(sharePreviewUrl.current)
      sharePreviewUrl.current = null
    }
    if (!shareRequest || shareMapKind(shareRequest.record) === "none") {
      releasePreview()
      shareImageFile.current = null
      setShareImageUrl(null)
      setShareImageReady(true)
      setShareMapNote("")
      return
    }
    let cancelled = false
    setShareImageReady(false)
    setShareMapNote("道の図を作っています。できあがってから送ってください。")
    setShareImageUrl(null)
    shareImageFile.current = null
    const record = shareRequest.record
    createWalkShareImage(
      record.route,
      [
        walkWhenLabel(record),
        formatDuration(record.durationSeconds ?? record.durationMinutes * 60),
        distanceText(record).replace(/^距離：/, ""),
      ],
      isRouteGap,
      record.plannedRoute ?? [],
    )
      .then((result) => {
        if (cancelled) return
        releasePreview()
        const file = new File([result.blob], "osanpo.jpg", {
          type: "image/jpeg",
        })
        shareImageFile.current = file
        sharePreviewUrl.current = URL.createObjectURL(file)
        setShareImageUrl(sharePreviewUrl.current)
        setShareImageReady(true)
        setShareMapNote(
          shareMapKind(record) === "planned"
            ? "予定した道の図です。送る前に、図を見てください。"
            : result.showsStreetNames
              ? "道の名前が入った地図です。送る前に、図を見てください。"
              : "道の名前が出せなかったため、線だけの図です。送る前に、図を見てください。",
        )
      })
      .catch((error) => {
        console.error("道の図を作れませんでした", error)
        if (cancelled) return
        shareImageFile.current = null
        setShareImageReady(true)
        setShareMapNote("道の図は作れませんでした。文章だけ送れます。")
      })
    return () => {
      cancelled = true
      releasePreview()
    }
  }, [shareRequest])

  useEffect(() => {
    if (!isWalking) return

    const interval = window.setInterval(() => {
      if (startedAt.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - startedAt.current) / 1000))
      }
    }, 1000)

    return () => window.clearInterval(interval)
  }, [isWalking])

  useEffect(
    () => () => {
      if (watchId.current !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(watchId.current)
      }

      voiceActiveRef.current = false
      if (voiceRestartTimer.current !== null) {
        window.clearTimeout(voiceRestartTimer.current)
      }
      recognitionRef.current?.stop()
    },

    [],
  )

  const monthKey = localDateKey(selectedMonth).slice(0, 7)
  const currentMonthKey = localDateKey().slice(0, 7)

  const monthRecords = records.filter((record) =>
    record.date.startsWith(monthKey),
  )

  const walkingDates = new Set(
    monthRecords
      .filter((record) => record.kind === "walk")
      .map((record) => record.date),
  )

  const chargeDates = new Set(
    monthRecords

      .filter((record) => record.kind === "charge")

      .map((record) => record.date),
  )

  const walkingDays = walkingDates.size
  const chargeDays = chargeDates.size
  const totalDays = new Set(monthRecords.map((record) => record.date)).size
  const firstWeekday = selectedMonth.getDay()
  const daysInMonth = new Date(
    selectedMonth.getFullYear(),
    selectedMonth.getMonth() + 1,
    0,
  ).getDate()
  const calendarWeeks = Array.from(
    { length: Math.ceil((firstWeekday + daysInMonth) / 7) },
    (_, week) => Array.from({ length: 7 }, (_, weekday) => week * 7 + weekday - firstWeekday + 1),
  )

  const totalSeconds = monthRecords

    .filter((record) => record.kind === "walk")

    .reduce(
      (sum, record) =>
        sum + (record.durationSeconds ?? record.durationMinutes * 60),
      0,
    )

  const suggestion = getSafetyMessage(condition, weather, new Date().getHours())
  const currentPlannedRoute =
    !extendingRoute && returnToStart && destinationRoute.length > 1
      ? [...destinationRoute, ...destinationRoute.slice(0, -1).reverse()]
      : destinationRoute
  const plannedRoute = [
    ...extraPlannedRoute,
    ...(extendingRoute ? (legBeforeExtend.current ?? []) : []),
    ...currentPlannedRoute,
  ]
  const currentPlannedDistance =
    destinationDistanceMeters === null
      ? 0
      : destinationDistanceMeters * (!extendingRoute && returnToStart ? 2 : 1)
  const currentPlannedDuration =
    destinationDurationSeconds === null
      ? 0
      : destinationDurationSeconds * (!extendingRoute && returnToStart ? 2 : 1)
  const heldDistance = extendingRoute ? (distanceBeforeExtend.current ?? 0) : 0
  const heldDuration = extendingRoute ? (durationBeforeExtend.current ?? 0) : 0
  const plannedDistanceMeters =
    extraDistanceMeters + heldDistance + currentPlannedDistance > 0
      ? extraDistanceMeters + heldDistance + currentPlannedDistance
      : null
  const plannedDurationSeconds =
    extraDurationSeconds + heldDuration + currentPlannedDuration > 0
      ? extraDurationSeconds + heldDuration + currentPlannedDuration
      : null
  const actualDistanceMeters =
    summarizeRoute(route, routePartial.current).distanceMeters
  const todayWalkCount = records.filter(
    (record) => record.date === localDateKey() && record.kind === "walk",
  ).length

  const todayHasCharge = records.some(
    (record) => record.date === localDateKey() && record.kind === "charge",
  )

  const dateLabel = new Intl.DateTimeFormat("ja-JP", {
    month: "long",

    day: "numeric",

    weekday: "long",
  }).format(new Date())

  const addPosition = (latitude: number, longitude: number, accuracy: number) => {
    const point: Position = {
      latitude,

      longitude,

      recordedAt: new Date().toISOString(),
    }

    setCurrentPosition(point)
    setLocationError("")

    if (!saveRoute || Date.now() - lastRecordedAt.current < 12000) return

    if (!Number.isFinite(accuracy) || accuracy > 100) {
      routePartial.current = true
      breakNextPoint.current = true
      return
    }

    const previous = routeRef.current[routeRef.current.length - 1]
    if (!previous && Date.now() - trackingStartedAt.current > maxPositionGapMs) {
      routePartial.current = true
    }
    if (previous && (breakNextPoint.current || isRouteGap(previous, point))) {
      routePartial.current = true
      point.breakBefore = true
    }
    breakNextPoint.current = false
    lastRecordedAt.current = Date.now()

    routeRef.current = [...routeRef.current, point]

    setRoute(routeRef.current)
  }

  const openDestinationMap = async () => {
    if (destinationMapOpen) {
      setDestinationMapOpen(false)
      return
    }
    if (!navigator.geolocation) {
      setDestinationError("この端末では現在地を確認できません。位置情報に対応した端末でお試しください。")
      return
    }
    setIsFindingRoute(true)
    setDestinationError("")
    try {
      const location = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 15000,
        })
      })
      setCurrentPosition({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        recordedAt: new Date().toISOString(),
      })
      setLocationEnabled(true)
      setSaveRoute(true)
      setSelectedDestination(null)
      setDestinationRoute([])
      setDestinationDistanceMeters(null)
      setDestinationDurationSeconds(null)
      setDestinationMapOpen(true)
    } catch (error) {
      setDestinationError(
        typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === 1
          ? "目的地を選ぶには位置情報の許可が必要です。Safariの設定をご確認ください。"
          : "現在地を取得できませんでした。位置情報と通信状況をご確認ください。",
      )
    } finally {
      setIsFindingRoute(false)
    }
  }

  const selectDestination = async (coordinate: Coordinate) => {
    if (!currentPosition) return
    setSelectedDestination(coordinate)
    setDestinationRoute([])
    setDestinationDistanceMeters(null)
    setDestinationDurationSeconds(null)
    setDestinationError("")
    setIsFindingRoute(true)
    try {
      const result = await fetchPedestrianRoute(currentPosition, coordinate)
      setDestinationRoute(result.route)
      setDestinationDistanceMeters(result.distanceMeters)
      setDestinationDurationSeconds(result.durationSeconds)
    } catch (error) {
      setDestinationError(
        error instanceof Error
          ? error.message
          : "徒歩経路を取得できませんでした。別の地点を選んでください。",
      )
    } finally {
      setIsFindingRoute(false)
    }
  }

  const startTimer = (withLocation: boolean) => {
    setLocationError("")
    setIsReturning(false)
    routeRef.current = []
    setRoute([])
    if (!withLocation) setCurrentPosition(null)

    lastRecordedAt.current = 0
    trackingStartedAt.current = Date.now()
    routePartial.current = false
    breakNextPoint.current = false
    startedAt.current = Date.now()
    setExtraPlannedRoute([])
    setExtraDistanceMeters(0)
    setExtraDurationSeconds(0)
    setShowArrivalChoices(false)
    setExtendingRoute(false)

    setElapsedSeconds(0)
    setLocationEnabled(withLocation)
    setIsWalking(true)

    if (!withLocation || !navigator.geolocation) {
      setLocationEnabled(false)
      setSaveRoute(false)
      setCurrentPosition(null)
      setLocationError(
        withLocation
          ? "この端末では現在地を確認できません。時間のみ記録します。"
          : "",
      )
      return
    }

    watchId.current = navigator.geolocation.watchPosition(
      ({ coords }) =>
        addPosition(coords.latitude, coords.longitude, coords.accuracy),
      (error) => {
        routePartial.current = true
        breakNextPoint.current = true
        setLocationError(
          error.code === error.PERMISSION_DENIED
            ? "位置情報が許可されませんでした。時間は引き続き記録します。"
            : "現在地を確認できません。位置情報の取得を続けます。",
        )
        if (error.code === error.PERMISSION_DENIED && watchId.current !== null) {
          navigator.geolocation.clearWatch(watchId.current)
          watchId.current = null
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    )
  }

  const askToStart = () => {
    if (locationEnabled) {
      setShowLocationNotice(true)

      return
    }

    startTimer(false)
  }

  const finishWalk = () => {
    if (lastRecordedAt.current && Date.now() - lastRecordedAt.current > maxPositionGapMs) {
      routePartial.current = true
    }
    if (watchId.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId.current)

      watchId.current = null
    }

    const seconds = startedAt.current === null
      ? elapsedSeconds
      : Math.floor((Date.now() - startedAt.current) / 1000)
    const durationMinutes = Math.max(1, Math.round(seconds / 60))

    startedAt.current = null

    setIsWalking(false)

    setPendingKind("walk")

    setReview("")

    setScreen("review")

    setElapsedSeconds(seconds)
  }

  const pauseAndAskAboutReturn = () => {
    if (returnToStart || isReturning) {
      finishWalk()
      return
    }
    if (watchId.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId.current)

      watchId.current = null
    }

    if (lastRecordedAt.current && Date.now() - lastRecordedAt.current > maxPositionGapMs) {
      routePartial.current = true
    }
    breakNextPoint.current = true
    if (startedAt.current !== null) {
      setElapsedSeconds(Math.floor((Date.now() - startedAt.current) / 1000))
    }
    startedAt.current = null

    setIsWalking(false)

    setShowReturnPrompt(true)
  }

  const finishAtDestination = () => {
    setShowArrivalChoices(false)
    setExtendingRoute(false)
    setDestinationMapOpen(false)
    finishWalk()
  }

  const continueTowardHome = () => {
    setShowArrivalChoices(false)
    setIsReturning(true)
  }

  const beginNextDestination = () => {
    if (!currentPosition) {
      setDestinationError("現在地を確認できていません。しばらくしてから、もう一度押してください。")
      return
    }
    legBeforeExtend.current = destinationRoute
    destinationBeforeExtend.current = selectedDestination
    distanceBeforeExtend.current = destinationDistanceMeters
    durationBeforeExtend.current = destinationDurationSeconds
    setDestinationRoute([])
    setSelectedDestination(null)
    setDestinationDistanceMeters(null)
    setDestinationDurationSeconds(null)
    setDestinationError("")
    setShowArrivalChoices(false)
    setExtendingRoute(true)
    setDestinationMapOpen(true)
  }

  const confirmNextDestination = () => {
    if (destinationRoute.length < 2 || !selectedDestination) return
    const previousLeg = legBeforeExtend.current ?? []
    const previousDistance = distanceBeforeExtend.current ?? 0
    const previousDuration = durationBeforeExtend.current ?? 0
    if (previousLeg.length > 1) {
      setExtraPlannedRoute((current) => [...current, ...previousLeg])
    }
    setExtraDistanceMeters((current) => current + previousDistance)
    setExtraDurationSeconds((current) => current + previousDuration)
    legBeforeExtend.current = null
    destinationBeforeExtend.current = null
    distanceBeforeExtend.current = null
    durationBeforeExtend.current = null
    setExtendingRoute(false)
    setDestinationMapOpen(false)
    setDestinationError("")
  }

  const cancelNextDestination = () => {
    setDestinationRoute(legBeforeExtend.current ?? [])
    setSelectedDestination(destinationBeforeExtend.current)
    setDestinationDistanceMeters(distanceBeforeExtend.current)
    setDestinationDurationSeconds(durationBeforeExtend.current)
    legBeforeExtend.current = null
    destinationBeforeExtend.current = null
    distanceBeforeExtend.current = null
    durationBeforeExtend.current = null
    setExtendingRoute(false)
    setDestinationMapOpen(false)
    setDestinationError("")
  }

  const saveRecord = () => {
    const now = new Date()

    const durationMinutes =
      pendingKind === "walk" ? Math.max(1, Math.round(elapsedSeconds / 60)) : 0

    const record: WalkRecord = {
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,

      date: localDateKey(now),

      kind: pendingKind,

      durationMinutes,
      durationSeconds: pendingKind === "walk" ? elapsedSeconds : undefined,

      review: review.trim(),

      createdAt: now.toISOString(),

      route:
        pendingKind === "walk" && routeRef.current.length > 0
          ? [...routeRef.current]
          : [],
      ...(pendingKind === "walk" && plannedRoute.length > 0
        ? {
            plannedRoute: [...plannedRoute],
            destination: selectedDestination ?? undefined,
            plannedDistanceMeters: plannedDistanceMeters ?? undefined,
            plannedDurationSeconds: plannedDurationSeconds ?? undefined,
          }
        : {}),
      ...(pendingKind === "walk"
        ? summarizeRoute(routeRef.current, routePartial.current)
        : {}),
    }

    setRecords((current) => [...cleanExpiredRoutes(current), record])
    setSavedForShare(record)

    setLocationEnabled(false)

    setCurrentPosition(null)

    setRoute([])

    setSelectedDestination(null)
    setDestinationRoute([])
    setDestinationDistanceMeters(null)
    setDestinationDurationSeconds(null)
    setDestinationMapOpen(false)
    setExtraPlannedRoute([])
    setExtraDistanceMeters(0)
    setExtraDurationSeconds(0)
    setShowArrivalChoices(false)
    setExtendingRoute(false)
    legBeforeExtend.current = null

    routeRef.current = []

    setScreen("home")

    setReview("")
  }

  const addChargeDay = () => {
    if (todayHasCharge) return

    setPendingKind("charge")

    setReview("")

    setElapsedSeconds(0)

    setScreen("review")
  }

  const startVoiceReview = () => {
    const RecognitionClass =
      (window as RecognitionWindow).SpeechRecognition ??
      (window as RecognitionWindow).webkitSpeechRecognition

    if (!RecognitionClass) {
      setVoiceError(
        "このSafariでは音声認識を利用できません。入力欄をタップし、キーボードのマイクから音声入力してください。",
      )

      return
    }

    if (voiceActiveRef.current) return
    const previousRecognition = recognitionRef.current
    recognitionRef.current = null
    voiceActiveRef.current = false
    if (voiceRestartTimer.current !== null) {
      window.clearTimeout(voiceRestartTimer.current)
      voiceRestartTimer.current = null
    }
    try {
      previousRecognition?.stop()
    } catch {
      // 前の聞き取りはすでに終わっている
    }

    voiceStatusAfterStop.current = null
    setVoiceError("")
    setVoiceStatus("お話しください。入力が終わったら「音声入力を止める」を押してください。")
    voiceActiveRef.current = true

    const desktop = isDesktopDevice()
    const base = (reviewInputRef.current?.value ?? "").trim()
    const recognition = new RecognitionClass()
    recognitionRef.current = recognition
    recognition.lang = "ja-JP"
    recognition.continuous = desktop
    recognition.interimResults = true

    let carried = ""
    let finals = ""
    let interim = ""
    let fatal = false
    let restarting = false
    let captureErrors = 0

    const publish = () => {
      const spoken = [carried, finals, interim]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(" ")
      setReview([base, spoken].filter(Boolean).join(" "))
    }

    const takeUtterance = () => {
      const spoken = `${finals} ${interim}`.replace(/\s+/g, " ").trim()
      finals = ""
      interim = ""
      if (!spoken) return
      carried = [carried, spoken].filter(Boolean).join(" ")
      publish()
    }

    const scheduleRestart = (attempt = 0) => {
      if (fatal || !voiceActiveRef.current || recognitionRef.current !== recognition) return
      if (attempt === 0) {
        if (restarting) return
        restarting = true
        takeUtterance()
      }
      if (voiceRestartTimer.current !== null) {
        window.clearTimeout(voiceRestartTimer.current)
      }
      voiceRestartTimer.current = window.setTimeout(() => {
        voiceRestartTimer.current = null
        if (fatal || !voiceActiveRef.current || recognitionRef.current !== recognition) {
          restarting = false
          return
        }
        try {
          recognition.start()
          restarting = false
          setIsListening(true)
        } catch (error) {
          console.error("音声入力の再開に失敗しました", error)
          if (attempt < 4) {
            scheduleRestart(attempt + 1)
            return
          }
          restarting = false
          fatal = true
          voiceActiveRef.current = false
          recognitionRef.current = null
          setIsListening(false)
          setIsStoppingVoice(false)
          if (carried) {
            setVoiceStatus(stoppedVoiceStatus())
            return
          }
          setVoiceError(
            "音声入力を開始できませんでした。入力欄からキーボードのマイクをお試しください。",
          )
        }
      }, desktop ? 40 + attempt * 60 : 250 + attempt * 150)
    }

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return
      let nextFinals = ""
      let nextInterim = ""
      for (let index = 0; index < event.results.length; index += 1) {
        const piece = event.results[index]?.[0]?.transcript ?? ""
        if (event.results[index]?.isFinal) nextFinals += piece
        else nextInterim += piece
      }
      finals = nextFinals.trim()
      interim = nextInterim.trim()
      if (!finals && !interim) return
      captureErrors = 0
      setVoiceStatus("音声を入力しています。終わったらボタンを押して停止してください。")
      publish()
    }

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition || !voiceActiveRef.current) return
      if (
        event.error === "no-speech" ||
        event.error === "aborted" ||
        event.error === "network"
      ) {
        return
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        fatal = true
        voiceActiveRef.current = false
        setIsListening(false)
        setVoiceError(
          "マイクの使用が許可されていません。iPhoneの「設定」>「Safari」>「マイク」を確認してください。入力欄からキーボードのマイクも使えます。",
        )
        return
      }
      if (event.error === "audio-capture") {
        captureErrors += 1
        if (captureErrors < 3) return
        fatal = true
        voiceActiveRef.current = false
        setIsListening(false)
        setVoiceError(
          "マイクを使用できません。ほかのアプリで使用中でないか確認してください。キーボードのマイクからも入力できます。",
        )
        return
      }
      fatal = true
      voiceActiveRef.current = false
      setIsListening(false)
      setVoiceError(
        "音声入力を開始できませんでした。入力欄からキーボードのマイクをお試しください。",
      )
    }

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return
      if (fatal || !voiceActiveRef.current) {
        setIsListening(false)
        setIsStoppingVoice(false)
        if (!fatal) setVoiceStatus(stoppedVoiceStatus())
        return
      }
      scheduleRestart()
    }

    try {
      recognition.start()
      setIsListening(true)
    } catch (error) {
      console.error("音声入力を開始できませんでした", error)
      fatal = true
      voiceActiveRef.current = false
      recognitionRef.current = null
      setIsListening(false)
      setVoiceError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "マイクの使用が許可されていません。Safariのマイク設定を確認してください。入力欄からキーボードのマイクも使えます。"
          : "音声入力を開始できませんでした。入力欄からキーボードのマイクをお試しください。",
      )
    }
  }

  const canShareToGroup = Boolean(onShareToGroup) && shareGroups.length > 0
  const selectedShareGroup =
    shareGroups.find((group) => group.id === shareGroupId) ?? shareGroups[0]
  const sharePreviewText = shareRequest
    ? walkShareText({
        when: walkWhenLabel(shareRequest.record),
        kind: shareRequest.record.kind,
        durationText: formatDuration(
          shareRequest.record.durationSeconds ??
            shareRequest.record.durationMinutes * 60,
        ),
        distanceLine: distanceText(shareRequest.record),
        review: shareRequest.record.review,
        includeReview,
        hasRoute: shareMapKind(shareRequest.record) !== "none",
        mapKind: shareMapKind(shareRequest.record),
        imageUnavailable:
          shareImageReady &&
          !shareImageUrl &&
          shareMapKind(shareRequest.record) !== "none",
      })
    : ""
  const sendingMap = Boolean(shareImageUrl)

  const clearShareImage = () => {
    shareImageFile.current = null
    if (sharePreviewUrl.current) {
      URL.revokeObjectURL(sharePreviewUrl.current)
      sharePreviewUrl.current = null
    }
    setShareImageUrl(null)
  }

  const openShare = (record: WalkRecord, channel: "external" | "group") => {
    clearShareImage()
    const hasRoute = shareMapKind(record) !== "none"
    setSavedForShare(null)
    setShareError("")
    setShareNotice("")
    setDesktopGuide(null)
    setLineTextCopied(false)
    setShareImageReady(!hasRoute)
    setShareMapNote(
      hasRoute ? "道の図を作っています。できあがってから送ってください。" : "",
    )
    setIncludeReview(Boolean(record.review.trim()))
    setShareGroupId(
      shareGroups.some((group) => group.id === defaultShareGroupId)
        ? defaultShareGroupId
        : (shareGroups[0]?.id ?? ""),
    )
    setShareRequest({ record, channel })
  }

  const closeShare = () => {
    setShareRequest(null)
    setShareError("")
    setIsSharing(false)
    setDesktopGuide(null)
    setLineTextCopied(false)
  }

  const shareTextFor = (record: WalkRecord) =>
    walkShareText({
      when: walkWhenLabel(record),
      kind: record.kind,
      durationText: formatDuration(
        record.durationSeconds ?? record.durationMinutes * 60,
      ),
      distanceLine: distanceText(record),
      review: record.review,
      includeReview,
      hasRoute: shareMapKind(record) !== "none",
      mapKind: shareMapKind(record),
      imageUnavailable:
        shareImageReady &&
        !shareImageFile.current &&
        shareMapKind(record) !== "none",
    })

  const shareSubjectFor = (record: WalkRecord) =>
    walkShareSubject(walkWhenLabel(record))

  const sendPhoneMail = async () => {
    if (!shareRequest || !shareImageReady || isSharing) return
    const text = shareTextFor(shareRequest.record)
    const subject = shareSubjectFor(shareRequest.record)
    setShareAction("mail")
    setIsSharing(true)
    setShareError("")
    try {
      const outcome = await sendPhoneMailWithImage(
        text,
        subject,
        shareImageFile.current,
      )
      if (outcome === "cancelled") {
        setShareError("送信を中止しました。もう一度送れます。")
        return
      }
      if (outcome === "draft") {
        setDesktopGuide("phone-mail")
      } else {
        setShareNotice(
          "共有画面を終了しました。メールアプリで宛先、本文、経路図を確認して送信してください。送信が完了したかはメールアプリでご確認ください。",
        )
        closeShare()
      }
    } catch (error) {
      setShareError(
        error instanceof Error
          ? error.message
          : "メールの送信画面を開けませんでした。もう一度押してください。",
      )
    } finally {
      setIsSharing(false)
      setShareAction(null)
    }
  }

  const saveShareImage = () => {
    if (!shareRequest) return
    const imageFile = shareImageFile.current
    if (!imageFile) {
      setShareError(
        "保存できる道の図がありません。確認画面を開き直してください。",
      )
      return
    }
    try {
      downloadWalkImage(imageFile, shareSubjectFor(shareRequest.record))
      setShareError("")
    } catch (error) {
      console.error("道の図を保存できませんでした", error)
      setShareError("道の図を保存できませんでした。もう一度お試しください。")
    }
  }

  const copyShareMessage = async () => {
    if (!shareRequest || isSharing) return
    setShareAction("line")
    setIsSharing(true)
    setShareError("")
    try {
      const copied = await copyWalkText(shareTextFor(shareRequest.record))
      setLineTextCopied(copied)
      if (!copied) {
        setShareError(
          "文章をコピーできませんでした。上の文章を長押ししてコピーしてください。",
        )
      }
    } finally {
      setIsSharing(false)
      setShareAction(null)
    }
  }

  const confirmShare = async (
    target: "sheet" | "line" | "mail" = "sheet",
  ) => {
    if (!shareRequest || !shareImageReady || isSharing) return
    const text = shareTextFor(shareRequest.record)
    setShareAction(target)
    setIsSharing(true)
    setShareError("")
    try {
      if (shareRequest.channel === "external") {
        const imageFile = shareImageFile.current
        const subject = walkShareSubject(walkWhenLabel(shareRequest.record))
        if (target === "mail") {
          if (!usesDesktopMail()) return
          if (!canShareWalkBySystem(imageFile)) {
            setDesktopGuide("mail")
            return
          }
          const outcome = await shareWalkBySystem(text, subject, imageFile)
          if (outcome === "cancelled") {
            setDesktopGuide("system-share")
            setShareError("共有画面を閉じたか、共有先が見つかりませんでした。もう一度試すか、既定のメールアプリをお使いください。")
          } else {
            setDesktopGuide("system-share")
            if (outcome === "failed") {
              setShareError("共有画面を開けませんでした。下のボタンから既定のメールアプリをお試しください。")
            }
          }
          return
        }
        if (target === "line") {
          const copied = await saveWalkForDesktopLine(text, subject, imageFile)
          setLineTextCopied(copied)
          setDesktopGuide("line")
          return
        }
        const outcome = await sharePreparedWalk(text, imageFile, subject)
        if (outcome === "cancelled") {
          setShareError("送信を中止しました。もう一度送れます。")
          return
        }
        if (outcome === "saved-only") {
          setShareError(
            "道の図は写真として保存しました。文章はコピーできなかったので、上の文章を長押ししてコピーし、保存した画像を添付してください。",
          )
          return
        }
        setShareNotice(
          outcome === "shared" || outcome === "shared-file"
            ? "LINEなどの送り先の画面を開きました。"
            : imageFile
              ? "道の図を保存し、文章をコピーしました。メールには自動で添付できないため、保存した画像を添付してください。"
              : "文章をコピーしました。LINEやメールに貼り付けてください。",
        )
        closeShare()
        return
      }
      if (!onShareToGroup || !selectedShareGroup) {
        setShareError("茶話会に入ってから送れます。")
        return
      }
      const imageFile = shareImageFile.current
      await onShareToGroup({
        groupId: selectedShareGroup.id,
        text,
        image: imageFile ?? undefined,
      })
      closeShare()
      if (onSentToGroup) onSentToGroup()
      else onBack()
    } catch (error) {
      setShareError(
        error instanceof Error
          ? error.message
          : "送れませんでした。もう一度お試しください。",
      )
    } finally {
      setIsSharing(false)
      setShareAction(null)
    }
  }

  const confirmDelete = () => {
    if (!deleteTarget) return

    const remainingRecords = records.filter(
      (record) => record.id !== deleteTarget.id,
    )

    try {
      localStorage.setItem(recordsStorageKey, JSON.stringify(remainingRecords))
      setRecords(remainingRecords)
      setExpandedRouteId((current) =>
        current === deleteTarget.id ? null : current,
      )
      setDeleteTarget(null)
      setStorageError("")
    } catch (error) {
      console.error("散歩の記録を削除できませんでした", error)
      setStorageError(
        "記録を削除できませんでした。端末の保存領域をご確認ください。",
      )
    }
  }

  return (
    <main className="walk-app">
      <header className="walk-header">
        <button className="walk-back-button" onClick={onBack} type="button">
          <span aria-hidden="true">←</span> 茶話会へ戻る
        </button>
        <div className="walk-brand">
          <span aria-hidden="true" className="walk-brand__icon">
            🌿
          </span>
          <span>おさんぽ日和</span>
        </div>
        <nav className="walk-tabs" aria-label="散歩メニュー">
          <button
            aria-current={
              screen === "home" || screen === "review" ? "page" : undefined
            }
            className={
              screen === "home" || screen === "review" ? "is-current" : ""
            }
            onClick={() => {
              stopVoiceReview()
              setScreen("home")
            }}
            type="button"
          >
            今日のお散歩
          </button>
          <button
            aria-current={screen === "month" ? "page" : undefined}
            className={screen === "month" ? "is-current" : ""}
            onClick={() => {
              stopVoiceReview()
              setScreen("month")
            }}
            type="button"
          >
            月のふりかえり
          </button>
        </nav>
      </header>

      <div className="walk-main">
        {storageError && (
          <p className="walk-storage-error" role="alert">
            {storageError}
          </p>
        )}
        {shareNotice && (
          <p className="walk-share-notice" role="status">
            {shareNotice}
          </p>
        )}
        {screen === "home" && !isWalking && (
          <>
            <section className="walk-welcome">
              <p className="walk-date">{dateLabel}</p>
              <h1>今日も、自分のペースで。</h1>
              <p>歩く日も、休む日も。あなたらしい一日を応援します。</p>
            </section>

            <section
              className="walk-card walk-checkin"
              aria-labelledby="walk-checkin-title"
            >
              <div className="walk-section-heading">
                <span className="walk-step">1</span>
                <div>
                  <h2 id="walk-checkin-title">今の体調を教えてください</h2>
                  <p>選んだ内容に合わせて、おすすめをご案内します。</p>
                </div>
              </div>
              <div className="walk-choice-grid" role="group" aria-label="体調">
                {([
                  ["good", "😊", "元気です"],

                  ["tired", "🙂", "少し疲れ気味"],

                  ["unwell", "😌", "体調がすぐれない"],
                ] as const).map(([value, icon, label]) => (
                  <button
                    aria-pressed={condition === value}
                    className={`walk-choice ${
                      condition === value ? "is-selected" : ""
                    }`}
                    key={value}
                    onClick={() => setCondition(value)}
                    type="button"
                  >
                    <span aria-hidden="true">{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
              <div className="walk-weather">
                <label htmlFor="walk-weather">今日の天気</label>
                <select
                  id="walk-weather"
                  onChange={(event) =>
                    setWeather(event.target.value as Weather)
                  }
                  value={weather}
                >
                  {Object.entries(weatherLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <span>現在の天気をご自身で選んでください</span>
              </div>
            </section>

            <section className="walk-recommendation" aria-live="polite">
              <span aria-hidden="true" className="walk-recommendation__icon">
                {suggestion.rest ? "☀️" : "🌱"}
              </span>
              <div>
                <h2>{suggestion.title}</h2>
                <p>{suggestion.message}</p>
              </div>
            </section>

            <section
              className="walk-card walk-plan"
              aria-labelledby="walk-plan-title"
            >
              <div className="walk-section-heading">
                <span className="walk-step">2</span>
                <div>
                  <h2 id="walk-plan-title">今日のプラン</h2>
                  <p>
                    {todayWalkCount > 0
                      ? `今日は${todayWalkCount}回歩きました。続けて記録できます。`
                      : "気分に合わせて、あとから変更できます。"}
                  </p>
                </div>
              </div>
              <div className="walk-location-setting">
                <div>
                  <strong>地図と経路の記録</strong>
                  <span>
                    地図で目的地と徒歩ルートを選べます。位置情報を使わない散歩も選べます。
                  </span>
                </div>
              </div>
              <div
                className="walk-location-options"
                role="group"
                aria-label="地図と経路の記録"
              >
                <button
                  aria-pressed={!locationEnabled}
                  className={!locationEnabled ? "is-selected" : ""}
                  disabled={isFindingRoute}
                  onClick={() => {
                    setLocationEnabled(false)
                    setSaveRoute(false)
                  }}
                  type="button"
                >
                  <strong>使わない</strong>
                  <span>時間だけ記録</span>
                </button>
                <button
                  aria-pressed={locationEnabled && !saveRoute}
                  className={locationEnabled && !saveRoute ? "is-selected" : ""}
                  disabled={isFindingRoute}
                  onClick={() => {
                    setLocationEnabled(true)
                    setSaveRoute(false)
                  }}
                  type="button"
                >
                  <strong>地図を表示</strong>
                  <span>経路は保存しない</span>
                </button>
                <button
                  aria-pressed={locationEnabled && saveRoute}
                  className={locationEnabled && saveRoute ? "is-selected" : ""}
                  disabled={isFindingRoute}
                  onClick={() => {
                    setLocationEnabled(true)
                    setSaveRoute(true)
                  }}
                  type="button"
                >
                  <strong>経路も記録</strong>
                  <span>1週間保存</span>
                </button>
              </div>
              <section className="walk-destination-planner" aria-labelledby="walk-destination-title">
                <div>
                  <h3 id="walk-destination-title">目的地を選ぶ</h3>
                  <p>地図をタップすると、徒歩経路と距離・時間を表示します。</p>
                </div>
                <button
                  className="walk-destination-button"
                  disabled={isFindingRoute}
                  onClick={() => void openDestinationMap()}
                  type="button"
                >
                  {isFindingRoute && !destinationMapOpen
                    ? "現在地を確認しています…"
                    : destinationMapOpen
                      ? "地図を閉じる"
                      : "地図で目的地を選ぶ"}
                </button>
                {destinationMapOpen && currentPosition && (
                  <DestinationMap
                    position={currentPosition}
                    destination={selectedDestination}
                    route={destinationRoute}
                    onSelect={(coordinate) => void selectDestination(coordinate)}
                  />
                )}
                {isFindingRoute && destinationMapOpen && (
                  <p className="walk-destination-status" role="status">
                    徒歩経路を調べています…
                  </p>
                )}
                {destinationError && (
                  <p className="walk-inline-error" role="status">
                    {destinationError}
                  </p>
                )}
                <label className="walk-return-toggle">
                  <input
                    checked={returnToStart}
                    disabled={isFindingRoute}
                    onChange={(event) => setReturnToStart(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <strong>出発地点に戻るコース</strong>
                    <small>有効にすると往復の距離と所要時間を表示します。</small>
                  </span>
                </label>
                {plannedDistanceMeters !== null && plannedDurationSeconds !== null && (
                  <div className="walk-destination-summary" role="status">
                    <strong>徒歩ルートを設定しました</strong>
                    <span>
                      距離 {plannedDistanceMeters < 1000
                        ? `${Math.round(plannedDistanceMeters / 10) * 10} m`
                        : `${(plannedDistanceMeters / 1000).toFixed(1)} km`}
                    </span>
                    <span>所要時間 約{Math.max(1, Math.round(plannedDurationSeconds / 60))}分</span>
                    {selectedDestination && (
                      <span>
                        目的地 {selectedDestination.latitude.toFixed(5)}, {selectedDestination.longitude.toFixed(5)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedDestination(null)
                        setDestinationRoute([])
                        setDestinationDistanceMeters(null)
                        setDestinationDurationSeconds(null)
                      }}
                    >
                      目的地を選び直す
                    </button>
                  </div>
                )}
                <p className="walk-destination-privacy">
                  現在地と選択地点は徒歩経路の検索に送信されます。経路・距離・所要時間は散歩記録に保存し、地図上の位置情報は7日後に削除します。
                </p>
              </section>
              {locationEnabled && (
                <p className="walk-privacy-note">
                  地図タイルの取得と徒歩経路検索では、現在地や選択地点が地図サービスへ送信されます。
                  {saveRoute
                    ? "歩いた経路はこの端末内に保存し、7日経過後にアプリを開いたときなどに削除します。時間とおおよその距離は記録を削除するまで残ります。"
                    : "歩いた経路は保存しません。"}
                </p>
              )}
              {locationError && (
                <p className="walk-inline-error" role="status">
                  {locationError}
                </p>
              )}
              <button
                className="walk-start-button"
                disabled={isFindingRoute}
                onClick={askToStart}
                type="button"
              >
                <span aria-hidden="true">▶</span> ゆっくり散歩を始める
              </button>
              <p className="walk-map-disclaimer">
                経路と所要時間は目安です。出発前に道の安全を確認し、歩行中は画面を見続けず周囲に気をつけてください。
              </p>
            </section>

            <button
              className="walk-rest-button"
              disabled={todayHasCharge}
              onClick={addChargeDay}
              type="button"
            >
              {todayHasCharge
                ? "今日は充電日として記録しました"
                : "今日は充電日にする"}
            </button>

            <section className="walk-map-card">
              <div className="walk-map-card__heading">
                <div>
                  <h2>現在地</h2>
                  <p>
                    {currentPosition
                      ? "現在地と選択した徒歩ルートを表示しています"
                      : "目的地を選ぶか、散歩を開始すると地図を表示します"}
                  </p>
                </div>
                <span aria-hidden="true">📍</span>
              </div>
              <MapPreview
                position={currentPosition}
                route={route}
                plannedRoute={plannedRoute}
              />
              {currentPosition && (
                <p className="walk-coordinates">
                  緯度 {currentPosition.latitude.toFixed(5)} ・経度{" "}
                  {currentPosition.longitude.toFixed(5)}
                </p>
              )}
            </section>
          </>
        )}

        {isWalking && (
          <section className="walk-active">
            <p className="walk-date">今日のお散歩</p>
            <h1>気持ちのよいペースで。</h1>
            <div className="walk-active-metrics">
              <div className="walk-active-metric">
                <span>経過時間</span>
                <strong className="walk-timer" aria-live="off">
                  {`${`${Math.floor(elapsedSeconds / 60)}`.padStart(2, "0")}:${`${elapsedSeconds % 60}`.padStart(2, "0")}`}
                </strong>
              </div>
              <div className="walk-active-metric">
                <span>歩いた距離</span>
                <strong>
                  {actualDistanceMeters === null
                    ? locationEnabled
                      ? "計測中"
                      : "未計測"
                    : actualDistanceMeters < 1000
                      ? `${Math.round(actualDistanceMeters / 10) * 10}m`
                      : `${(actualDistanceMeters / 1000).toFixed(1)}km`}
                </strong>
              </div>
            </div>
            {plannedDistanceMeters !== null && plannedDurationSeconds !== null && (
              <p className="walk-active-plan">
                予定ルート：{plannedDistanceMeters < 1000
                  ? `${Math.round(plannedDistanceMeters / 10) * 10}m`
                  : `${(plannedDistanceMeters / 1000).toFixed(1)}km`}・
                約{Math.max(1, Math.round(plannedDurationSeconds / 60))}分
              </p>
            )}
            <MapPreview
              position={currentPosition}
              route={route}
              plannedRoute={plannedRoute}
            />
            <p className="walk-location-status" role="status">
              {locationError || (locationEnabled && currentPosition
                ? "地図に現在地と歩いた経路を表示しています"
                : "位置情報は使わず、時間のみ記録しています")}
            </p>
            <p className="walk-look-away">
              画面を見続けず、周りに気をつけて歩きましょう。
            </p>
            {selectedDestination && !isReturning && (
              <button
                className="walk-arrived-button"
                onClick={() => setShowArrivalChoices(true)}
                type="button"
              >
                ここに着きました
              </button>
            )}
            <button
              className="walk-finish-button"
              onClick={pauseAndAskAboutReturn}
              type="button"
            >
              お散歩を終える
            </button>
          </section>
        )}

        {screen === "review" && (
          <section
            className="walk-card walk-review"
            aria-labelledby="walk-review-title"
          >
            <p className="walk-date">{dateLabel}</p>
            <h1 id="walk-review-title">
              {pendingKind === "walk"
                ? "おつかれさまでした"
                : "今日はゆっくり充電日"}
            </h1>
            <p className="walk-review-time">
              {pendingKind === "walk"
                ? `今日のお散歩：${formatDuration(elapsedSeconds)}`
                : "休むことも、健やかに続けるための大切な選択です。"}
            </p>
            {pendingKind === "walk" && (
              <p>{distanceText(summarizeRoute(routeRef.current, routePartial.current))}</p>
            )}
            {pendingKind === "walk" && plannedDistanceMeters !== null && plannedDurationSeconds !== null && (
              <p>
                予定ルート：{plannedDistanceMeters < 1000
                  ? `${Math.round(plannedDistanceMeters / 10) * 10}m`
                  : `${(plannedDistanceMeters / 1000).toFixed(1)}km`}・
                約{Math.max(1, Math.round(plannedDurationSeconds / 60))}分
              </p>
            )}
            <label htmlFor="walk-review-input">
              今日の気分を残しませんか？（任意）
            </label>
            <textarea
              id="walk-review-input"
                    ref={reviewInputRef}
              onChange={(event) => setReview(event.target.value)}
              placeholder="「風が気持ちよかった」など、ひとこと"
              rows={4}
              value={review}
            />
            <div
              className={`walk-voice-controls${
                isIphoneDevice() ? " walk-voice-controls--iphone" : ""
              }`}
            >
              <div className={isIphoneDevice() ? "walk-voice-choices" : undefined}>
                <button
                  className={`walk-voice-button ${
                    isListening ? "is-listening" : ""
                  }`}
                  disabled={isStoppingVoice}
                  onClick={isListening ? stopVoiceReview : startVoiceReview}
                  type="button"
                >
                  <span aria-hidden="true">{isListening ? "⏹" : "🎙"}</span>
                  {isStoppingVoice
                    ? "音声入力を終了しています…"
                    : isListening
                      ? "音声入力を止める"
                      : "声でふりかえる"}
                </button>
                {isIphoneDevice() && (
                  <button
                    className="walk-voice-keyboard-button"
                    disabled={isStoppingVoice}
                    onClick={openKeyboardMicrophone}
                    type="button"
                  >
                    キーボードのマイクで話す
                  </button>
                )}
              </div>
              <p aria-live="polite">
                {voiceStatus ||
                  (isIphoneDevice()
                    ? "「声でふりかえる」か「キーボードのマイクで話す」を選んでください。話した内容は、確認してから保存できます。"
                    : "お話し終わったら「音声入力を止める」を押してください。音声はブラウザーで処理され、内容を確認・修正してから保存できます。")}
              </p>
              {voiceError && (
                <div className="walk-voice-fallback" role="status">
                  <p className="walk-inline-error">{voiceError}</p>
                  {!isIphoneDevice() && (
                    <button
                      className="walk-voice-fallback-button"
                      onClick={() => {
                        setVoiceStatus("キーボードのマイクを押してお話しください。")
                        reviewInputRef.current?.focus()
                      }}
                      type="button"
                    >
                      感想欄を開いてキーボードのマイクを使う
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="walk-review-actions">
              <button
                className="walk-secondary-button"
                onClick={() => {
                  stopVoiceReview()
                  setScreen("home")
                }}
                type="button"
              >
                保存せず戻る
              </button>
              <button
                className="walk-start-button"
                disabled={isListening}
                onClick={saveRecord}
                type="button"
              >
                {isListening ? "音声入力を止めてから保存" : "記録を保存する"}
              </button>
            </div>
          </section>
        )}

        {screen === "month" && (
          <section className="walk-monthly">
            <p className="walk-date">ひと月のふりかえり</p>
            <h1>{formatMonth(selectedMonth)}も、自分のペースで。</h1>
            <p className="walk-monthly-intro">
              歩いた日も、充電した日も。ひと月の大切な記録です。
            </p>
            <div className="walk-month-navigation" aria-label="記録する月の切り替え">
              <button type="button" onClick={() => { setSelectedMonth(new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() - 1, 1)); setExpandedRouteId(null) }}>前の月</button>
              <strong>{formatMonth(selectedMonth)}</strong>
              <button type="button" disabled={monthKey >= currentMonthKey} onClick={() => { setSelectedMonth(new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 1)); setExpandedRouteId(null) }}>次の月</button>
            </div>
            <div className="walk-month-stats">
              <article>
                <span aria-hidden="true">👟</span>
                <strong>
                  {walkingDays}
                  <small>日</small>
                </strong>
                <span>お散歩した日</span>
              </article>
              <article>
                <span aria-hidden="true">🌤️</span>
                <strong>
                  {chargeDays}
                  <small>日</small>
                </strong>
                <span>充電した日</span>
              </article>
              <button
                className="walk-calendar-trigger"
                onClick={() => setCalendarOpen(true)}
                type="button"
                aria-haspopup="dialog"
              >
                <span aria-hidden="true">📅</span>
                <strong>
                  {totalDays}
                  <small>日</small>
                </strong>
                <span>記録した日</span>
                <span>カレンダーを見る</span>
              </button>
            </div>
            <div className="walk-month-total">
              <span>この月のお散歩時間</span>
              <strong>{formatDuration(totalSeconds)}</strong>
              <p>ひと歩きずつ、心地よい時間を重ねています。</p>
            </div>
            <section
              className="walk-record-list"
              aria-labelledby="walk-records-title"
            >
              <h2 id="walk-records-title">この月の記録</h2>
              {monthRecords.length === 0 ? (
                <p className="walk-empty-records">
                  記録はまだありません。今日の気分から始めてみませんか？
                </p>
              ) : (
                [...monthRecords]

                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

                  .map((record) => (
                    <article className="walk-record" key={record.id}>
                      <div className="walk-record-content">
                        <strong>
                          {record.date.slice(5).replace("-", "月")}日 ・
                          {record.kind === "walk"
                            ? `お散歩 ${record.durationMinutes}分`
                            : "充電日"}
                        </strong>
                        <p>{new Date(record.createdAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}に保存</p>
                        {record.review && <p>{record.review}</p>}
                        {record.kind === "walk" && (
                          <>
                            <p>実際の時間：{formatDuration(record.durationSeconds ?? record.durationMinutes * 60)}</p>
                            <p>{distanceText(record)}</p>
                            {record.plannedDistanceMeters !== undefined && (
                              <p>
                                予定：{record.plannedDistanceMeters < 1000
                                  ? `${Math.round(record.plannedDistanceMeters / 10) * 10}m`
                                  : `${(record.plannedDistanceMeters / 1000).toFixed(1)}km`}・
                                {formatDuration(record.plannedDurationSeconds ?? 0)}
                              </p>
                            )}
                            <small>
                              {record.route.length > 0 || (record.plannedRoute?.length ?? 0) > 0
                                ? "経路は7日間保存"
                                : "経路なし（未記録または保存期間終了）"}
                            </small>
                            {(record.route.length > 0 || (record.plannedRoute?.length ?? 0) > 0) && (
                              <>
                                <button className="walk-view-route-button" type="button" aria-expanded={expandedRouteId === record.id} onClick={() => setExpandedRouteId(expandedRouteId === record.id ? null : record.id)}>
                                  {expandedRouteId === record.id ? "経路を閉じる" : "経路を見る"}
                                </button>
                                {expandedRouteId === record.id && (
                                  <>
                                    <div className="walk-route-legend">
                                      {record.plannedRoute && <span>点線：予定経路</span>}
                                      {record.route.length > 0 && <span>緑線：歩いた経路</span>}
                                    </div>
                                    <SavedRouteMap route={record.route} plannedRoute={record.plannedRoute} />
                                  </>
                                )}
                              </>
                            )}
                          </>
                        )}
                      </div>
                      <div className="walk-share-actions">
                        <p className="walk-share-hint">
                          {shareMapKind(record) !== "none"
                            ? "道の図は7日以内なら一緒に送れます。"
                            : "時間などの記録を送れます。道の図はありません。"}
                        </p>
                        <button
                          aria-label={`${walkWhenLabel(record)}の記録を、LINEやメールで送る`}
                          className="walk-share-button"
                          onClick={() => openShare(record, "external")}
                          type="button"
                        >
                          LINEやメールで送る
                        </button>
                        <button
                          aria-label={`${walkWhenLabel(record)}の記録を、茶話会に送る`}
                          className="walk-share-button walk-share-button--group"
                          onClick={() => openShare(record, "group")}
                          type="button"
                        >
                          茶話会に送る
                        </button>
                        <button
                          aria-label={`${record.date}の${
                            record.kind === "walk" ? "散歩" : "充電日"
                          }記録を削除`}
                          className="walk-delete-button"
                          onClick={() => setDeleteTarget(record)}
                          type="button"
                        >
                          この記録を削除
                        </button>
                      </div>
                    </article>
                  ))
              )}
            </section>
          </section>
        )}
      </div>

      <dialog
        aria-labelledby="walk-calendar-title"
        className="walk-dialog walk-calendar-dialog"
        onClose={() => setCalendarOpen(false)}
        ref={calendarDialogRef}
      >
        <h2 id="walk-calendar-title">記録のカレンダー</h2>
        <div className="walk-month-navigation walk-calendar-navigation" aria-label="カレンダーの月の切り替え">
          <button type="button" onClick={() => { setSelectedMonth(new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() - 1, 1)); setExpandedRouteId(null) }}>前の月</button>
          <strong aria-live="polite">{formatMonth(selectedMonth)}</strong>
          <button type="button" disabled={monthKey >= currentMonthKey} onClick={() => { setSelectedMonth(new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 1)); setExpandedRouteId(null) }}>次の月</button>
        </div>
        <p className="walk-calendar-legend">○ 散歩の記録　🌤️ 充電日の記録</p>
        <table className="walk-calendar">
          <caption className="walk-calendar-sr">{formatMonth(selectedMonth)}の記録</caption>
          <thead>
            <tr>
              {["日", "月", "火", "水", "木", "金", "土"].map((day) => (
                <th key={day} scope="col">{day}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendarWeeks.map((week, index) => (
              <tr key={index}>
                {week.map((day, weekday) => {
                  if (day < 1 || day > daysInMonth) return <td key={weekday} />
                  const date = localDateKey(new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), day))
                  const hasWalk = walkingDates.has(date)
                  const hasCharge = chargeDates.has(date)
                  return (
                    <td key={weekday}>
                      <span className="walk-calendar-sr">
                        {day}日、{hasWalk && hasCharge ? "散歩と充電日の記録" : hasWalk ? "散歩の記録" : hasCharge ? "充電日の記録" : "記録なし"}
                      </span>
                      <span aria-hidden="true" className="walk-calendar-day">
                        <span className={hasWalk ? "walk-calendar-number is-walk" : "walk-calendar-number"}>{day}</span>
                        <span className="walk-calendar-charge">{hasCharge ? "🌤️" : "\u00a0"}</span>
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="walk-dialog-actions">
          <button className="walk-start-button" onClick={() => calendarDialogRef.current?.close()} type="button">閉じる</button>
        </div>
      </dialog>

      {showLocationNotice && (
        <div className="walk-dialog-backdrop">
          <section
            aria-labelledby="walk-location-title"
            aria-modal="true"
            className="walk-dialog"
            role="dialog"
          >
            <span aria-hidden="true">📍</span>
            <h2 id="walk-location-title">現在地を地図に表示します</h2>
            <p>
              地図タイルの取得時に、現在地が地図サービスへ送信されます。
              {saveRoute
                ? "歩いた経路はこの端末に保存され、7日経過後にアプリを開いたときなどに削除されます。時間とおおよその距離は記録を削除するまで残ります。"
                : "選択した設定では、歩いた経路は保存しません。"}
            </p>
            <p>位置情報を許可しない場合も、時間のみ記録して散歩できます。</p>
            <div className="walk-dialog-actions">
              <button
                className="walk-secondary-button"
                onClick={() => {
                  setShowLocationNotice(false)
                  startTimer(false)
                }}
                type="button"
              >
                時間のみ記録
              </button>
              <button
                className="walk-start-button"
                onClick={() => {
                  setShowLocationNotice(false)
                  startTimer(true)
                }}
                type="button"
              >
                位置情報を使う
              </button>
            </div>
          </section>
        </div>
      )}

      {showArrivalChoices && (
        <div className="walk-dialog-backdrop">
          <section
            aria-labelledby="walk-arrival-title"
            aria-modal="true"
            className="walk-dialog"
            role="dialog"
          >
            <h2 id="walk-arrival-title">ここに着きました</h2>
            <p>このあとの歩き方を選んでください。選んでいる間も時間は進みます。</p>
            {destinationError && (
              <p className="walk-inline-error" role="status">
                {destinationError}
              </p>
            )}
            <div className="walk-dialog-actions walk-arrival-actions">
              <button
                className="walk-start-button"
                onClick={finishAtDestination}
                type="button"
              >
                ここでお散歩を終える
              </button>
              {!returnToStart && (
                <button
                  className="walk-secondary-button"
                  onClick={beginNextDestination}
                  type="button"
                >
                  次の目的地へ進む
                </button>
              )}
              <button
                className="walk-secondary-button"
                onClick={continueTowardHome}
                type="button"
              >
                出発地点に戻る
              </button>
              <button
                className="walk-secondary-button"
                onClick={() => setShowArrivalChoices(false)}
                type="button"
              >
                もどる
              </button>
            </div>
          </section>
        </div>
      )}

      {extendingRoute && destinationMapOpen && currentPosition && (
        <div className="walk-dialog-backdrop">
          <section
            aria-labelledby="walk-next-destination-title"
            aria-modal="true"
            className="walk-dialog walk-next-destination-dialog"
            role="dialog"
          >
            <h2 id="walk-next-destination-title">次の目的地を選ぶ</h2>
            <p>地図をタップしてください。歩いた道と時間はこのまま続きます。</p>
            <DestinationMap
              position={currentPosition}
              destination={selectedDestination}
              route={destinationRoute}
              onSelect={(coordinate) => void selectDestination(coordinate)}
            />
            {isFindingRoute && (
              <p className="walk-destination-status" role="status">
                徒歩経路を調べています…
              </p>
            )}
            {destinationError && (
              <p className="walk-inline-error" role="status">
                {destinationError}
              </p>
            )}
            <div className="walk-dialog-actions walk-arrival-actions">
              <button
                className="walk-start-button"
                disabled={isFindingRoute || destinationRoute.length < 2}
                onClick={confirmNextDestination}
                type="button"
              >
                この目的地へ進む
              </button>
              <button
                className="walk-secondary-button"
                onClick={cancelNextDestination}
                type="button"
              >
                このままの目的地で歩く
              </button>
            </div>
          </section>
        </div>
      )}

      {showReturnPrompt && (
        <div className="walk-dialog-backdrop">
          <section
            aria-labelledby="walk-return-title"
            aria-modal="true"
            className="walk-dialog"
            role="alertdialog"
          >
            <span aria-hidden="true">🌿</span>
            <h2 id="walk-return-title">休憩して出発地点に戻りますか？</h2>
            <p>
              はい：歩いた道を逆に戻ります。いいえ：散歩を終了します。帰り道は無理のない方法をお選びください。
            </p>
            <div className="walk-dialog-actions">
              <button
                className="walk-secondary-button"
                onClick={() => {
                  setShowReturnPrompt(false)
                  setIsReturning(true)
                  startedAt.current = Date.now() - elapsedSeconds * 1000

                  setIsWalking(true)

                  if (locationEnabled && navigator.geolocation) {
                    watchId.current = navigator.geolocation.watchPosition(
                      ({ coords }) =>
                        addPosition(coords.latitude, coords.longitude, coords.accuracy),

                      () => {
                        routePartial.current = true
                        breakNextPoint.current = true
                        setLocationError(
                          "位置情報を再取得できません。時間は引き続き記録します。",
                        )
                      },

                      {
                        enableHighAccuracy: true,
                        maximumAge: 5000,
                        timeout: 15000,
                      },
                    )
                  }
                }}
                type="button"
              >
                はい、戻ります
              </button>
              <button
                className="walk-start-button"
                onClick={() => {
                  setShowReturnPrompt(false)

                  finishWalk()
                }}
                type="button"
              >
                いいえ、終了します
              </button>
            </div>
          </section>
        </div>
      )}

      {savedForShare && !shareRequest && (
        <div className="walk-dialog-backdrop">
          <section
            aria-labelledby="walk-saved-share-title"
            aria-modal="true"
            className="walk-dialog walk-share-dialog"
            role="dialog"
          >
            <h2 id="walk-saved-share-title">記録を保存しました</h2>
            <p>誰かに知らせますか？</p>
            <p>
              {shareMapKind(savedForShare) !== "none"
                ? "画面の道の図は、7日たつとこの端末から消えます。今なら一緒に送れます。"
                : "時間などの記録を送れます。道の図はありません。"}
            </p>
            <div className="walk-dialog-actions walk-dialog-actions--stack">
              <button
                className="walk-share-button"
                onClick={() => openShare(savedForShare, "external")}
                type="button"
              >
                LINEやメールで送る
              </button>
              <button
                className="walk-share-button walk-share-button--group"
                onClick={() => openShare(savedForShare, "group")}
                type="button"
              >
                茶話会に送る
              </button>
              <button
                className="walk-secondary-button"
                onClick={() => setSavedForShare(null)}
                type="button"
              >
                今は送らない
              </button>
            </div>
          </section>
        </div>
      )}

      {shareRequest && (
        <div className="walk-dialog-backdrop">
          <section
            aria-labelledby="walk-share-title"
            aria-modal="true"
            className="walk-dialog walk-share-dialog"
            role="dialog"
          >
            <h2 id="walk-share-title">
              {shareRequest.channel === "group"
                ? "茶話会へ送る前の確認"
                : "送る前の確認"}
            </h2>
            <p>この内容で間違いありませんか？</p>
            <p className="walk-share-preview">{sharePreviewText}</p>
            {shareMapNote && <p role="status">{shareMapNote}</p>}
            {shareImageUrl && (
              <img
                alt="送る道の図"
                className="walk-share-map"
                src={shareImageUrl}
              />
            )}
            {shareRequest.record.review.trim() && (
              <label className="walk-share-review">
                <input
                  checked={includeReview}
                  onChange={(event) => setIncludeReview(event.target.checked)}
                  type="checkbox"
                />
                <span>感想も一緒に送る</span>
              </label>
            )}
            {shareRequest.channel === "group" && selectedShareGroup && (
              <>
                {shareGroups.length > 1 ? (
                  <div
                    aria-label="送り先の茶話会"
                    className="walk-share-groups"
                    role="group"
                  >
                    <p>送り先を選んでください。いま開いている茶話会を最初に選んでいます。</p>
                    {shareGroups.map((group) => (
                      <button
                        aria-pressed={selectedShareGroup.id === group.id}
                        className={
                          selectedShareGroup.id === group.id ? "is-selected" : ""
                        }
                        key={group.id}
                        onClick={() => setShareGroupId(group.id)}
                        type="button"
                      >
                        {group.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="walk-share-destination">
                    送り先は、いま開いている「{selectedShareGroup.name}」です。
                  </p>
                )}
                <p>
                  {sendingMap || !shareImageReady
                    ? "茶話会では、道の図と文章は約30日残ります。"
                    : "茶話会では、この文章は約90日残ります。"}
                </p>
              </>
            )}
            {shareRequest.channel === "group" && !canShareToGroup && (
              <p>
                茶話会に送るには、先に茶話会へ参加してください。記録はこの端末に残りますので、参加した後に記録から送れます。
              </p>
            )}
            {shareRequest.channel === "external" && !desktopGuide && (
              <p>
                {usesDesktopMail()
                  ? "共有画面が開いたらOutlookなどのメールを選んでください。共有先によって本文・件名や画像が渡らない場合があります。"
                  : "LINEやメールは次の画面で送り先を選びます。メールを送る前に、本文と経路図の添付をご確認ください。端末によっては経路図を手動で添付します。"}
              </p>
            )}
            {desktopGuide === "system-share" && (
              <>
                <p>
                  共有画面が表示されたら、Outlookなどのメールを選んでください。
                  メールアプリが開いたら、宛先・件名・本文と経路図を確認して送信してください。
                  このアプリでは送信完了を確認できません。
                </p>
                <p>
                  メールが選べない、または内容が渡らない場合は、下のボタンから文章をコピーし、既定のメールアプリを開いて貼り付けることができます。経路図は保存して手動で添付できます。
                </p>
              </>
            )}
            {(desktopGuide === "mail" || desktopGuide === "phone-mail") && (
              <>
                <p>
                  {desktopGuide === "mail"
                    ? "下の「既定のメールアプリを開く」を押してください。"
                    : "メール画面を開く操作を行いました。"}
                  このアプリではメールの起動や送信完了を確認できません。
                  開かない場合は、端末のメールアプリの設定をご確認ください。
                </p>
                <ol className="walk-share-steps">
                  <li>
                    件名と本文を確認し、送り先を選んでください。
                  </li>
                  {shareImageUrl && (
                    <>
                      <li>
                        経路図は自動で添付されません。
                        {desktopGuide === "mail"
                          ? "下の「経路図を保存する」を押してください。保存先は端末の設定によって異なります。"
                          : "この画面に戻り、下の「経路図を保存する」を押してください。保存先は端末の設定によって異なります。"}
                      </li>
                      <li>メールの添付ボタンから保存した画像を選んでください。</li>
                    </>
                  )}
                  {!shareImageUrl && (
                    <li>経路図の添付はありません。文章のみになります。</li>
                  )}
                  <li>メールアプリで内容を確認して送信してください。</li>
                </ol>
              </>
            )}
            {desktopGuide === "line" && (
              <>
                <p>パソコンのLINEには、この画面から直接送れません。</p>
                <ol className="walk-share-steps">
                  <li>
                    {lineTextCopied
                      ? "文章をコピーしました。「文章をコピーする」でも、もう一度コピーできます。"
                      : "「文章をコピーする」を押し、LINEのトークに貼り付けてください。"}
                  </li>
                  {shareImageUrl && (
                    <li>
                      ダウンロードフォルダーの「{walkShareSubject(walkWhenLabel(shareRequest.record))}」を、LINEのトークへドラッグするか、添付ボタンで選んでください。見当たらないときは、「経路図を保存する」を押してください。
                    </li>
                  )}
                </ol>
              </>
            )}
            {(sendingMap ||
              (!shareImageReady &&
                shareMapKind(shareRequest.record) !== "none")) && (
              <p>
                自宅の近くが分かることがあります。送った相手は、ほかの人へ転送できます。
              </p>
            )}
            {shareError && (
              <p className="walk-inline-error" role="alert">
                {shareError}
              </p>
            )}
            <div className="walk-dialog-actions walk-dialog-actions--stack">
              {desktopGuide ? (
                <>
                  {shareImageUrl && (
                    <button
                      className="walk-start-button"
                      onClick={saveShareImage}
                      type="button"
                    >
                      経路図を保存する
                    </button>
                  )}
                  {(desktopGuide === "line" ||
                    desktopGuide === "mail" ||
                    desktopGuide === "phone-mail" ||
                    desktopGuide === "system-share") && (
                    <button
                      className="walk-share-button walk-share-button--group"
                      disabled={isSharing}
                      onClick={() => void copyShareMessage()}
                      type="button"
                    >
                      {shareAction === "line"
                        ? "コピーしています…"
                        : lineTextCopied
                          ? "文章をコピーしました"
                          : "文章をコピーする"}
                    </button>
                  )}
                  {(desktopGuide === "mail" || desktopGuide === "system-share") && (
                    <a
                      className="walk-share-button walk-share-button--group"
                      href={walkMailDraftHref(
                        shareTextFor(shareRequest.record),
                        shareSubjectFor(shareRequest.record),
                      )}
                      onClick={() => {
                        setShareError("")
                        setDesktopGuide("mail")
                      }}
                    >
                      既定のメールアプリを開く
                    </a>
                  )}
                  {desktopGuide === "system-share" && (
                    <button
                      className="walk-share-button walk-share-button--group"
                      disabled={isSharing}
                      onClick={() => void confirmShare("mail")}
                      type="button"
                    >
                      もう一度共有画面を開く
                    </button>
                  )}
                  {desktopGuide === "phone-mail" && (
                    <button
                      className="walk-share-button walk-share-button--group"
                      disabled={isSharing}
                      onClick={() => void sendPhoneMail()}
                      type="button"
                    >
                      {isSharing && shareAction === "mail"
                        ? "開いています…"
                        : "もう一度メールを開く"}
                    </button>
                  )}
                  <button
                    className="walk-secondary-button"
                    disabled={isSharing}
                    onClick={closeShare}
                    type="button"
                  >
                    閉じる
                  </button>
                </>
              ) : shareRequest.channel === "external" && usesDesktopMail() ? (
                <>
                  <button
                    className="walk-start-button"
                    disabled={!shareImageReady || isSharing}
                    onClick={() => void confirmShare("line")}
                    type="button"
                  >
                    {shareAction === "line"
                      ? "保存しています…"
                      : !shareImageReady
                        ? "道の図を作っています…"
                        : "LINEで送る"}
                  </button>
                  <button
                    className="walk-share-button walk-share-button--group"
                    disabled={!shareImageReady || isSharing}
                    onClick={() => void confirmShare("mail")}
                    type="button"
                  >
                    {shareAction === "mail"
                      ? "保存しています…"
                      : !shareImageReady
                        ? "道の図を作っています…"
                        : "メールで送る"}
                  </button>
                  <button
                    className="walk-secondary-button"
                    disabled={isSharing}
                    onClick={closeShare}
                    type="button"
                  >
                    送るのをやめる
                  </button>
                </>
              ) : shareRequest.channel === "external" ? (
                <>
                  <button
                    className="walk-start-button"
                    disabled={!shareImageReady || isSharing}
                    onClick={() => void confirmShare("sheet")}
                    type="button"
                  >
                    {shareAction === "sheet"
                      ? "送り先を開いています…"
                      : !shareImageReady
                        ? "道の図を作っています…"
                        : "LINEで送る"}
                  </button>
                  <button
                    className="walk-share-button walk-share-button--group"
                    disabled={!shareImageReady || isSharing}
                    onClick={() => void sendPhoneMail()}
                    type="button"
                  >
                    {shareAction === "mail"
                      ? "開いています…"
                      : !shareImageReady
                        ? "道の図を作っています…"
                        : "メールで送る"}
                  </button>
                  <button
                    className="walk-secondary-button"
                    disabled={isSharing}
                    onClick={closeShare}
                    type="button"
                  >
                    送るのをやめる
                  </button>
                </>
              ) : !canShareToGroup ? (
                <>
                  <button
                    className="walk-start-button"
                    onClick={onBack}
                    type="button"
                  >
                    茶話会へ戻る
                  </button>
                  <button
                    className="walk-secondary-button"
                    onClick={closeShare}
                    type="button"
                  >
                    閉じる
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="walk-start-button"
                    disabled={
                      !shareImageReady ||
                      isSharing ||
                      (shareRequest.channel === "group" && !selectedShareGroup)
                    }
                    onClick={() => void confirmShare()}
                    type="button"
                  >
                    {isSharing
                      ? "送っています…"
                      : !shareImageReady
                        ? "道の図を作っています…"
                        : `「${selectedShareGroup?.name ?? "茶話会"}」に送る`}
                  </button>
                  <button
                    className="walk-secondary-button"
                    disabled={isSharing}
                    onClick={closeShare}
                    type="button"
                  >
                    送るのをやめる
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="walk-dialog-backdrop">
          <section
            aria-labelledby="walk-delete-title"
            aria-modal="true"
            className="walk-dialog"
            role="alertdialog"
          >
            <h2 id="walk-delete-title">この記録を削除しますか？</h2>
            <p>
              {deleteTarget.date}の
              {deleteTarget.kind === "walk"
                ? `お散歩（${deleteTarget.durationMinutes}分）`
                : "充電日"}
              の記録を削除します。この操作は取り消せません。
            </p>
            <div className="walk-dialog-actions">
              <button
                className="walk-secondary-button"
                onClick={() => setDeleteTarget(null)}
                type="button"
              >
                削除しない
              </button>
              <button
                className="walk-delete-confirm"
                onClick={confirmDelete}
                type="button"
              >
                削除する
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
