import { useEffect, useRef, useState } from "react"

import "./WalkingApp.css"

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
}

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
    return withDistance.route.length > 0 &&
      now - new Date(withDistance.createdAt).getTime() >= routeRetentionMs
      ? { ...withDistance, route: [] }
      : withDistance
  })
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
        record.route.every(
          (point: unknown) =>
            typeof point === "object" &&
            point !== null &&
            "latitude" in point &&
            typeof point.latitude === "number" &&
            "longitude" in point &&
            typeof point.longitude === "number" &&
            "recordedAt" in point &&
            typeof point.recordedAt === "string" &&
            (!("breakBefore" in point) ||
              typeof point.breakBefore === "boolean"),
        ),
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
  suggestedRoute = [],
}: {
  position: Position | null

  route: Position[]
  suggestedRoute?: Position[]
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

  const suggestedLine = suggestedRoute
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
        {suggestedRoute.length > 1 && (
          <polyline
            points={suggestedLine}
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

function SavedRouteMap({ route }: { route: Position[] }) {
  const [zoomOffset, setZoomOffset] = useState(0)
  const [tileError, setTileError] = useState(false)
  const [tileAttempt, setTileAttempt] = useState(0)
  const atBaseZoom = route.map((point) =>
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

function ExternalMapLinks({ position }: { position: Position | null }) {
  return (
    <div className="walk-external-maps">
      <h3>地図アプリで道を選ぶ</h3>
      <p>地図を開き、目的地を選んで徒歩ルートをご確認ください。選んだ経路はこのアプリには取り込まれません。</p>
      <a className="walk-external-map-button" href="https://www.google.com/maps/@?api=1&map_action=map" target="_blank" rel="noreferrer">Google マップを開く</a>
      <a className="walk-external-map-button" href="https://maps.apple.com/" target="_blank" rel="noreferrer">Apple マップを開く</a>
      {position && (
        <a className="walk-route-map-link" href={`https://www.openstreetmap.org/?mlat=${position.latitude}&mlon=${position.longitude}#map=16/${position.latitude}/${position.longitude}`} target="_blank" rel="noreferrer">OpenStreetMapで現在地を開く</a>
      )}
      <p>地図アプリ側で位置情報を使う場合は、そのサービスに現在地が送られます。切り替え中は散歩の位置記録が途切れることがあります。</p>
    </div>
  )
}

function formatMonth(date = new Date()) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`
}

export default function WalkingApp({ onBack }: { onBack: () => void }) {
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
  const [expandedRouteId, setExpandedRouteId] = useState<string | null>(null)

  const [condition, setCondition] = useState<Condition>("good")

  const [weather, setWeather] = useState<Weather>("sunny")

  const [walkMinutes, setWalkMinutes] = useState(15)

  const [returnToStart, setReturnToStart] = useState(true)

  const [isWalking, setIsWalking] = useState(false)
  const [isReturning, setIsReturning] = useState(false)

  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const [locationEnabled, setLocationEnabled] = useState(false)
  const [saveRoute, setSaveRoute] = useState(false)

  const [locationError, setLocationError] = useState("")

  const [currentPosition, setCurrentPosition] = useState<Position | null>(null)

  const [route, setRoute] = useState<Position[]>([])
  const [suggestedRoute, setSuggestedRoute] = useState<Position[]>([])
  const [routeSuggestionError, setRouteSuggestionError] = useState("")
  const [isFindingRoute, setIsFindingRoute] = useState(false)

  const [review, setReview] = useState("")

  const [pendingKind, setPendingKind] = useState<"walk" | "charge">("walk")

  const [deleteTarget, setDeleteTarget] = useState<WalkRecord | null>(null)

  const [isListening, setIsListening] = useState(false)
  const [isStoppingVoice, setIsStoppingVoice] = useState(false)

  const [voiceError, setVoiceError] = useState("")

  const [showLocationNotice, setShowLocationNotice] = useState(false)
  const [locationNoticeAction, setLocationNoticeAction] =
    useState<"start" | "route-search">("start")

  const [showReturnPrompt, setShowReturnPrompt] = useState(false)

  const watchId = useRef<number | null>(null)

  const startedAt = useRef<number | null>(null)

  const routeRef = useRef<Position[]>([])

  const lastRecordedAt = useRef(0)
  const trackingStartedAt = useRef(0)
  const routePartial = useRef(false)
  const breakNextPoint = useRef(false)

  const recognitionRef = useRef<Recognition | null>(null)
  const voiceActiveRef = useRef(false)
  const voiceRestartTimer = useRef<number | null>(null)

  const stopVoiceReview = () => {
    voiceActiveRef.current = false
    if (voiceRestartTimer.current !== null) {
      window.clearTimeout(voiceRestartTimer.current)
      voiceRestartTimer.current = null
    }
    if (recognitionRef.current) {
      setIsStoppingVoice(true)
      recognitionRef.current.stop()
    } else {
      setIsListening(false)
      setIsStoppingVoice(false)
    }
  }

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

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
    if (!isWalking) return

    const interval = window.setInterval(() => {
      if (startedAt.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - startedAt.current) / 1000))
      }
    }, 1000)

    return () => window.clearInterval(interval)
  }, [isWalking])

  useEffect(() => {
    setSuggestedRoute([])
  }, [returnToStart, walkMinutes])

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

  const walkingDays = new Set(
    monthRecords
      .filter((record) => record.kind === "walk")
      .map((record) => record.date),
  ).size

  const chargeDays = new Set(
    monthRecords

      .filter((record) => record.kind === "charge")

      .map((record) => record.date),
  ).size

  const totalDays = new Set(monthRecords.map((record) => record.date)).size

  const totalMinutes = monthRecords

    .filter((record) => record.kind === "walk")

    .reduce((sum, record) => sum + record.durationMinutes, 0)

  const suggestion = getSafetyMessage(condition, weather, new Date().getHours())
  const suggestedDistanceMeters = suggestedRoute
    .slice(1)
    .reduce(
      (sum, point, index) => sum + distanceMeters(point, suggestedRoute[index]),
      0,
    )
  const suggestedMinutes = Math.max(1, Math.round(suggestedDistanceMeters / 45))

  const todayHasWalk = records.some(
    (record) => record.date === localDateKey() && record.kind === "walk",
  )

  const todayHasCharge = records.some(
    (record) => record.date === localDateKey() && record.kind === "charge",
  )

  const distanceLabel =
    walkMinutes <= 10 ? "約0.5 km" : walkMinutes <= 15 ? "約0.8 km" : "約1.5 km"

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

  const findSuggestedRoute = async () => {
    if (!navigator.geolocation) {
      setRouteSuggestionError(
        "この端末では現在地を確認できません。位置情報を使わずに散歩できます。",
      )
      return
    }
    setIsFindingRoute(true)
    setRouteSuggestionError("")
    setSuggestedRoute([])
    try {
      const start = await new Promise<GeolocationPosition>(
        (resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 15000,
          })
        },
      )
      const origin: Position = {
        latitude: start.coords.latitude,
        longitude: start.coords.longitude,
        recordedAt: new Date().toISOString(),
      }
      setCurrentPosition(origin)
      const searchRadius = Math.min(1800, Math.max(900, walkMinutes * 60))
      const highwayValues = [
        "footway",
        "pedestrian",
        "path",
        "living_street",
        "residential",
        "tertiary",
      ]
      const wayQueries = highwayValues
        .map(
          (highway) =>
            `way(around:${searchRadius},${origin.latitude},${origin.longitude})["highway"="${highway}"];`,
        )
        .join("")
      const query = `[out:json][timeout:10];(${wayQueries});out body geom;`
      const ways = await fetchOSMWays(query)
      const outbound = buildSuggestedRoute(ways, origin, walkMinutes * 45)
      const completeRoute = returnToStart
        ? [...outbound, ...outbound.slice(0, -1).reverse()]
        : outbound
      setSuggestedRoute(completeRoute)
      setRouteSuggestionError("")
    } catch (error) {
      console.error("散歩コース候補を作成できませんでした", error)
      setSuggestedRoute([])
      setRouteSuggestionError(
        error instanceof GeolocationPositionError
          ? error.code === error.PERMISSION_DENIED
            ? "位置情報が許可されませんでした。設定を見直すか、時間のみの散歩をお選びください。"
            : "現在地を取得できませんでした。電波のよい場所でお試しください。"
          : error instanceof DOMException && error.name === "AbortError"
            ? "地図データの取得に時間がかかっています。少し待ってからもう一度お試しください。"
            : error instanceof TypeError
              ? "地図データのサーバーに接続できませんでした。時間をおいてもう一度お試しください。"
              : error instanceof Error
                ? error.message
                : "散歩コースを作成できませんでした。時間をおいてお試しください。",
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

    setCurrentPosition(null)

    lastRecordedAt.current = 0
    trackingStartedAt.current = Date.now()
    routePartial.current = false
    breakNextPoint.current = false

    startedAt.current = Date.now()

    setElapsedSeconds(0)
    setLocationEnabled(withLocation)
    setIsWalking(true)

    if (!withLocation || !navigator.geolocation) {
      setLocationEnabled(false)
      setSaveRoute(false)

      setLocationError(
        withLocation
          ? "この端末では現在地を確認できません。時間のみ記録します。"
          : "",
      )

      return
    }

    watchId.current = navigator.geolocation.watchPosition(
      ({ coords }) => addPosition(coords.latitude, coords.longitude, coords.accuracy),
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
      setLocationNoticeAction("start")
      setShowLocationNotice(true)

      return
    }

    startTimer(false)
  }

  const askToFindRoute = () => {
    setRouteSuggestionError("")
    setLocationNoticeAction("route-search")
    setShowLocationNotice(true)
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

    setElapsedSeconds(durationMinutes * 60)
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

  const saveRecord = () => {
    const now = new Date()

    const durationMinutes =
      pendingKind === "walk" ? Math.max(1, Math.round(elapsedSeconds / 60)) : 0

    const record: WalkRecord = {
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,

      date: localDateKey(now),

      kind: pendingKind,

      durationMinutes,

      review: review.trim(),

      createdAt: now.toISOString(),

      route:
        pendingKind === "walk" && routeRef.current.length > 0
          ? [...routeRef.current]
          : [],
      ...(pendingKind === "walk"
        ? summarizeRoute(routeRef.current, routePartial.current)
        : {}),
    }

    setRecords((current) => [...cleanExpiredRoutes(current), record])

    setLocationEnabled(false)

    setCurrentPosition(null)

    setRoute([])

    routeRef.current = []

    setScreen("home")

    setReview("")
  }

  const addChargeDay = () => {
    if (todayHasCharge || todayHasWalk) return

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
        "この端末では音声入力を利用できません。文字で入力してください。",
      )

      return
    }

    setVoiceError("")

    if (voiceActiveRef.current) return
    voiceActiveRef.current = true
    let silentEnds = 0

    const begin = () => {
      if (!voiceActiveRef.current) return
      const recognition = new RecognitionClass()
      recognitionRef.current = recognition
      recognition.lang = "ja-JP"
      recognition.continuous = true
      recognition.interimResults = false
      let heardSpeech = false
      let fatalError = false

      recognition.onresult = (event) => {
        const text = Array.from(event.results)
          .slice(event.resultIndex)
          .filter((result) => result.isFinal)
          .map((result) => result[0]?.transcript ?? "")
          .join("")
          .trim()
        if (text) {
          heardSpeech = true
          silentEnds = 0
          setReview((current) => [current.trim(), text].filter(Boolean).join(" "))
        }
      }

      recognition.onerror = (event) => {
        if (!voiceActiveRef.current) return
        if (event.error === "no-speech") return
        fatalError = true
        voiceActiveRef.current = false
        setIsListening(false)
        setVoiceError(
          event.error === "not-allowed" || event.error === "service-not-allowed"
            ? "マイクの使用が許可されませんでした。設定を確認するか、文字で入力してください。"
            : "音声入力が止まりました。もう一度お試しください。",
        )
      }

      recognition.onend = () => {
        if (recognitionRef.current === recognition) recognitionRef.current = null
        if (!voiceActiveRef.current || fatalError) {
          setIsListening(false)
          setIsStoppingVoice(false)
          return
        }
        if (!heardSpeech) silentEnds += 1
        if (silentEnds >= 3) {
          voiceActiveRef.current = false
          setIsListening(false)
          setVoiceError("声を聞き取れませんでした。もう一度ボタンを押してお話しください。")
          return
        }
        voiceRestartTimer.current = window.setTimeout(() => {
          voiceRestartTimer.current = null
          begin()
        }, 500)
      }

      try {
        recognition.start()
        setIsListening(true)
      } catch (error) {
        console.error("音声入力を開始できませんでした", error)
        voiceActiveRef.current = false
        recognitionRef.current = null
        setIsListening(false)
        setVoiceError("音声入力を開始できませんでした。もう一度お試しください。")
      }
    }

    begin()
  }

  const confirmDelete = () => {
    if (!deleteTarget) return

    setRecords((current) =>
      current.filter((record) => record.id !== deleteTarget.id),
    )

    setDeleteTarget(null)
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
                  <p>気分に合わせて、あとから変更できます。</p>
                </div>
              </div>
              <div className="walk-plan-controls">
                <label htmlFor="walk-duration">歩く時間の目安</label>
                <div
                  className="walk-segment"
                  role="group"
                  aria-label="歩く時間"
                >
                  {[10, 15, 30].map((minutes) => (
                    <button
                      aria-pressed={walkMinutes === minutes}
                      className={walkMinutes === minutes ? "is-selected" : ""}
                      disabled={isFindingRoute}
                      key={minutes}
                      onClick={() => setWalkMinutes(minutes)}
                      type="button"
                    >
                      {minutes}分
                    </button>
                  ))}
                </div>
                <div className="walk-plan-summary">
                  <span>🚶 {distanceLabel}の目安</span>
                  <span>
                    {returnToStart ? "↩ 出発地点へ戻る" : "● 別の場所で終了"}
                  </span>
                </div>
                <label className="walk-return-toggle">
                  <input
                    checked={returnToStart}
                    disabled={isFindingRoute}
                    onChange={(event) => setReturnToStart(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <strong>出発地点に戻るコース</strong>
                    <small>
                      戻る場合は、往復の時間と距離が目安の約2倍です。
                    </small>
                  </span>
                </label>
              </div>
              <div className="walk-location-setting">
                <div>
                  <strong>地図と経路の記録</strong>
                  <span>
                    地図は散歩開始後に表示します。位置情報を使わない選択もできます。
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
              {locationEnabled && (
                <p className="walk-privacy-note">
                  地図表示とコース検索では、現在地をOpenStreetMapの地図データサーバーへ送信します（コース検索では複数のサーバーへ同時に問い合わせます）。
                  {saveRoute
                    ? "歩いた経路はこの端末内に保存し、7日経過後にアプリを開いたときなどに削除します。時間とおおよその距離は記録を削除するまで残ります。"
                    : "歩いた経路は保存しません。"}
                </p>
              )}
              {locationEnabled && (
                <div className="walk-route-suggestion">
                  <button
                    className="walk-route-button"
                    disabled={isFindingRoute}
                    onClick={askToFindRoute}
                    type="button"
                  >
                    {isFindingRoute
                      ? "近くの道を調べています…"
                      : suggestedRoute.length > 0
                        ? "別のコースを提案する"
                        : "近くの道からコースを提案"}
                  </button>
                  {suggestedRoute.length > 0 && (
                    <p className="walk-route-result" role="status">
                      歩道が登録された比較的大きな道や歩行者道を優先して、ランダムに候補を選びました。
                      <br />
                      このコースは約{suggestedMinutes}分・約
                      {(suggestedDistanceMeters / 1000).toFixed(1)}
                      kmの目安です。
                      {returnToStart
                        ? "同じ道を戻るコースです。"
                        : "終了地点からの帰り道は別途ご確認ください。"}
                    </p>
                  )}
                  {routeSuggestionError && (
                    <p className="walk-inline-error" role="status">
                      {routeSuggestionError}
                    </p>
                  )}
                  <p className="walk-route-disclaimer">
                    ランダムな候補です。歩道や通行可否などの地図情報は不完全なことがあり、交差点ごとの音声案内もありません。案内に従う必要はありません。出発前に、ご自身で道の安全と現在地から道までの経路をご確認ください。
                  </p>
                </div>
              )}
              <ExternalMapLinks position={currentPosition} />
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
                コース提案は任意です。選んだ時間に近い道を地図情報から探しますが、時間・距離と安全を保証するものではありません。出発前に天候や道の様子をご確認ください。
              </p>
            </section>

            {!todayHasWalk && (
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
            )}

            <section className="walk-map-card">
              <div className="walk-map-card__heading">
                <div>
                  <h2>現在地</h2>
                  <p>
                    {currentPosition
                      ? "現在地とコース候補を表示しています"
                      : "コース検索または散歩開始後に地図を表示します"}
                  </p>
                </div>
                <span aria-hidden="true">📍</span>
              </div>
              <MapPreview
                position={currentPosition}
                route={route}
                suggestedRoute={suggestedRoute}
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
            <div className="walk-timer" aria-live="off">
              {`${`${Math.floor(elapsedSeconds / 60)}`.padStart(2, "0")}:${`${elapsedSeconds % 60}`.padStart(2, "0")}`}
            </div>
            <p className="walk-timer-caption">おさんぽの時間</p>
            <MapPreview
              position={currentPosition}
              route={route}
              suggestedRoute={suggestedRoute}
            />
            <p className="walk-location-status" role="status">
              {locationError || (locationEnabled && currentPosition
                ? "地図に現在地と歩いた経路を表示しています"
                : "位置情報は使わず、時間のみ記録しています")}
            </p>
            <p className="walk-look-away">
              画面を見続けず、周りに気をつけて歩きましょう。
            </p>
            <button
              className="walk-finish-button"
              onClick={pauseAndAskAboutReturn}
              type="button"
            >
              お散歩を終える
            </button>
            <ExternalMapLinks position={currentPosition} />
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
                ? `今日のお散歩：${Math.max(1, Math.round(elapsedSeconds / 60))}分`
                : "休むことも、健やかに続けるための大切な選択です。"}
            </p>
            {pendingKind === "walk" && (
              <p>{distanceText(summarizeRoute(routeRef.current, routePartial.current))}</p>
            )}
            <label htmlFor="walk-review-input">
              今日の気分を残しませんか？（任意）
            </label>
            <textarea
              id="walk-review-input"
              onChange={(event) => setReview(event.target.value)}
              placeholder="「風が気持ちよかった」など、ひとこと"
              rows={4}
              value={review}
            />
            {pendingKind === "walk" && (
              <div className="walk-voice-controls">
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
                <p>
                  お話し終わったら「音声入力を止める」を押してください。音声はブラウザーの音声機能で処理され、内容を確認・修正してから保存できます。
                </p>
                {voiceError && (
                  <p className="walk-inline-error" role="status">
                    {voiceError}
                  </p>
                )}
              </div>
            )}
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
              <article>
                <span aria-hidden="true">📅</span>
                <strong>
                  {totalDays}
                  <small>日</small>
                </strong>
                <span>記録した日</span>
              </article>
            </div>
            <div className="walk-month-total">
              <span>この月のお散歩時間</span>
              <strong>
                {totalMinutes >= 60
                  ? `${Math.floor(totalMinutes / 60)}時間${
                      totalMinutes % 60 ? ` ${totalMinutes % 60}分` : ""
                    }`
                  : `${totalMinutes}分`}
              </strong>
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
                            <p>{distanceText(record)}</p>
                            <small>{record.route.length > 0 ? "経路を保存中（7日間）" : "経路なし（未記録または保存期間終了）"}</small>
                            {record.route.length > 0 && (
                              <>
                                <button className="walk-view-route-button" type="button" aria-expanded={expandedRouteId === record.id} onClick={() => setExpandedRouteId(expandedRouteId === record.id ? null : record.id)}>
                                  {expandedRouteId === record.id ? "経路を閉じる" : "歩いた経路を見る"}
                                </button>
                                {expandedRouteId === record.id && <SavedRouteMap route={record.route} />}
                              </>
                            )}
                          </>
                        )}
                      </div>
                      <button
                        aria-label={`${record.date}の${
                          record.kind === "walk" ? "散歩" : "充電日"
                        }記録を削除`}
                        className="walk-delete-button"
                        onClick={() => setDeleteTarget(record)}
                        type="button"
                      >
                        削除
                      </button>
                    </article>
                  ))
              )}
            </section>
          </section>
        )}
      </div>

      {showLocationNotice && (
        <div className="walk-dialog-backdrop">
          <section
            aria-labelledby="walk-location-title"
            aria-modal="true"
            className="walk-dialog"
            role="dialog"
          >
            <span aria-hidden="true">📍</span>
            <h2 id="walk-location-title">
              {locationNoticeAction === "route-search"
                ? "現在地から近くの道を探します"
                : "現在地を地図に表示します"}
            </h2>
            <p>
              {locationNoticeAction === "route-search"
                ? "現在地をOpenStreetMapの地図データに照会して、歩行者道や歩道が登録された道を優先する候補を作ります。候補の検索に現在地が送信されます。"
                : `地図画像の取得時に、現在地がOpenStreetMapへ送信されます。${
                    saveRoute
                      ? "歩いた経路はこの端末に保存され、7日経過後にアプリを開いたときなどに削除されます。時間とおおよその距離は記録を削除するまで残ります。"
                      : "選択した設定では、歩いた経路は保存しません。"
                  }`}
            </p>
            {locationNoticeAction === "route-search" ? (
              <p>
                道の情報は不完全な場合があります。提案を使わず、地図を見ながら歩くこともできます。
              </p>
            ) : (
              <p>位置情報を許可しない場合も、時間のみ記録して散歩できます。</p>
            )}
            <div className="walk-dialog-actions">
              {locationNoticeAction === "route-search" ? (
                <button
                  className="walk-secondary-button"
                  onClick={() => setShowLocationNotice(false)}
                  type="button"
                >
                  やめる
                </button>
              ) : (
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
              )}
              <button
                className="walk-start-button"
                onClick={() => {
                  setShowLocationNotice(false)
                  if (locationNoticeAction === "route-search") {
                    void findSuggestedRoute()
                  } else {
                    startTimer(true)
                  }
                }}
                type="button"
              >
                {locationNoticeAction === "route-search"
                  ? "同意してコースを探す"
                  : "位置情報を使う"}
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
