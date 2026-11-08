export type SharePoint = {
  latitude: number
  longitude: number
  recordedAt: string
  breakBefore?: boolean
}

export type WalkShareTextInput = {
  when: string
  kind: "walk" | "charge"
  durationText: string
  distanceLine: string
  review: string
  includeReview: boolean
  hasRoute: boolean
}

const maxShareTextLength = 500
const tileSize = 256
const canvasWidth = 1080
const canvasHeight = 840
const mapHeight = 640
const fontFamily = '"Noto Sans JP", "Yu Gothic", "Hiragino Sans", sans-serif'
const tileCache = new Map<string, HTMLImageElement>()

export function walkShareText(input: WalkShareTextInput) {
  const lines = ["【おさんぽ日和】"]
  if (input.kind === "charge") {
    lines.push(`${input.when}は、充電日です。`)
    lines.push("歩かずに休んだ日の記録です。")
  } else {
    lines.push(`${input.when}の散歩です。`)
    lines.push(`時間：${input.durationText}`)
    lines.push(input.distanceLine)
    lines.push(
      input.hasRoute
        ? "歩いた道の図を添えています。"
        : "道の記録はないため、時間と距離だけのお知らせです。",
    )
  }
  const review = input.includeReview ? input.review.trim() : ""
  if (review) lines.push(`感想：${review}`)
  const text = lines.join("\n")
  if (text.length <= maxShareTextLength) return text
  if (!review) return text.slice(0, maxShareTextLength)
  const withoutReview = lines.slice(0, -1).join("\n")
  const room = maxShareTextLength - withoutReview.length - "\n感想：".length
  if (room < 8) return withoutReview.slice(0, maxShareTextLength)
  return `${withoutReview}\n感想：${review.slice(0, room)}`
}

export async function createWalkShareImage<T extends SharePoint>(
  route: T[],
  captionLines: string[],
  separates: (first: T, second: T) => boolean,
) {
  const usable = route.filter(
    (point) =>
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      Math.abs(point.latitude) <= 85 &&
      Math.abs(point.longitude) <= 180,
  )
  if (usable.length === 0) {
    throw new Error("道の図を作る位置がありません。")
  }
  const parts = segments(usable, separates)
  const lines = [...captionLines]
  if (parts.length > 1) lines.push("途切れた区間は線にしていません")
  try {
    const blob = await drawStreetMap(usable, parts, lines)
    if (blob) return { blob, showsStreetNames: true }
  } catch (error) {
    console.error("道の名前つき地図を作れませんでした", error)
  }
  const blob = await drawLineMap(usable, parts, lines)
  return { blob, showsStreetNames: false }
}

export async function sharePreparedWalk(
  text: string,
  file: File | null,
): Promise<
  "shared" | "shared-file" | "cancelled" | "copied" | "saved-only"
> {
  const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  try {
    if (file && phone && canShareFile(file, text)) {
      await navigator.share({ files: [file], text, title: "おさんぽの記録" })
      return "shared"
    }
    if (file && canShareFile(file)) {
      const pictured = await fileWithMessage(file, text)
      await navigator.share({
        files: [pictured],
        title: "おさんぽの記録",
      })
      return "shared-file"
    }
    if (!file && typeof navigator.share === "function") {
      await navigator.share({ text, title: "おさんぽの記録" })
      return "shared"
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return "cancelled"
    }
  }
  const copied = await copyText(text)
  if (file) downloadFile(file)
  if (copied) return "copied"
  if (file) return "saved-only"
  throw new Error(
    "この端末では共有画面を開けません。文章を長押ししてコピーしてください。",
  )
}

function canShareFile(file: File, text?: string) {
  if (typeof navigator.canShare !== "function") return false
  try {
    return navigator.canShare(text ? { files: [file], text } : { files: [file] })
  } catch {
    return false
  }
}

async function fileWithMessage(file: File, text: string) {
  try {
    const bitmap = await createImageBitmap(file)
    const width = bitmap.width
    const height = bitmap.height
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    if (!context) {
      bitmap.close()
      return file
    }
    context.font = `700 28px ${fontFamily}`
    const maxWidth = width - 64
    const lines = wrapLines(context, text, maxWidth).slice(0, 12)
    const lineHeight = 40
    const extra = 36 + lines.length * lineHeight
    canvas.width = width
    canvas.height = height + extra
    context.fillStyle = "#fffefa"
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    context.fillStyle = "#203d35"
    context.textBaseline = "top"
    context.font = `700 28px ${fontFamily}`
    lines.forEach((line, index) => {
      context.fillText(line, 32, height + 24 + index * lineHeight, maxWidth)
    })
    const blob = await canvasToJpeg(canvas)
    return new File([blob], "osanpo.jpg", { type: "image/jpeg" })
  } catch (error) {
    console.error("文章を道の図へ重ねられませんでした", error)
    return file
  }
}

function wrapLines(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
) {
  const lines: string[] = []
  text.split("\n").forEach((paragraph) => {
    if (!paragraph) {
      lines.push("")
      return
    }
    let current = ""
    for (const character of paragraph) {
      const next = current + character
      if (context.measureText(next).width > maxWidth && current) {
        lines.push(current)
        current = character
      } else {
        current = next
      }
    }
    if (current) lines.push(current)
  })
  return lines
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function downloadFile(file: File) {
  const url = URL.createObjectURL(file)
  const link = document.createElement("a")
  link.href = url
  link.download = file.name
  link.rel = "noopener"
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

function segments<T extends SharePoint>(
  route: T[],
  separates: (first: T, second: T) => boolean,
) {
  const groups: T[][] = []
  let current: T[] = []
  route.forEach((point, index) => {
    if (index > 0 && separates(route[index - 1], point)) {
      if (current.length) groups.push(current)
      current = [point]
    } else {
      current.push(point)
    }
  })
  if (current.length) groups.push(current)
  return groups
}

function project(point: SharePoint, zoom: number) {
  const scale = tileSize * 2 ** zoom
  const x = ((point.longitude + 180) / 360) * scale
  const sinLatitude = Math.sin((point.latitude * Math.PI) / 180)
  const y =
    (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) *
    scale
  return { x, y }
}

function chooseView<T extends SharePoint>(points: T[]) {
  for (let zoom = 17; zoom >= 13; zoom -= 1) {
    const projected = points.map((point) => project(point, zoom))
    const minX = Math.min(...projected.map((point) => point.x))
    const maxX = Math.max(...projected.map((point) => point.x))
    const minY = Math.min(...projected.map((point) => point.y))
    const maxY = Math.max(...projected.map((point) => point.y))
    if (
      maxX - minX + 160 <= canvasWidth &&
      maxY - minY + 160 <= mapHeight
    ) {
      return { zoom, minX, maxX, minY, maxY }
    }
  }
  const zoom = 13
  const projected = points.map((point) => project(point, zoom))
  return {
    zoom,
    minX: Math.min(...projected.map((point) => point.x)),
    maxX: Math.max(...projected.map((point) => point.x)),
    minY: Math.min(...projected.map((point) => point.y)),
    maxY: Math.max(...projected.map((point) => point.y)),
  }
}

async function drawStreetMap<T extends SharePoint>(
  route: T[],
  parts: T[][],
  lines: string[],
) {
  const view = chooseView(route)
  const centerX = (view.minX + view.maxX) / 2
  const centerY = (view.minY + view.maxY) / 2
  const left = centerX - canvasWidth / 2
  const top = centerY - mapHeight / 2
  const tileCount = 2 ** view.zoom
  const jobs: { x: number; y: number }[] = []
  for (
    let x = Math.floor(left / tileSize);
    x <= Math.floor((left + canvasWidth - 1) / tileSize);
    x += 1
  ) {
    for (
      let y = Math.floor(top / tileSize);
      y <= Math.floor((top + mapHeight - 1) / tileSize);
      y += 1
    ) {
      if (y < 0 || y >= tileCount) return null
      jobs.push({ x, y })
    }
  }
  if (jobs.length === 0 || jobs.length > 20) return null
  const tiles = await Promise.race([
    Promise.all(
      jobs.map(async (job) => ({
        ...job,
        image: await loadTile(view.zoom, job.x, job.y, tileCount),
      })),
    ),
    rejectAfter(8000),
  ])
  const canvas = document.createElement("canvas")
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const context = canvas.getContext("2d")
  if (!context) return null
  context.fillStyle = "#e7f0e4"
  context.fillRect(0, 0, canvasWidth, mapHeight)
  context.save()
  context.beginPath()
  context.rect(0, 0, canvasWidth, mapHeight)
  context.clip()
  tiles.forEach((tile) => {
    context.drawImage(
      tile.image,
      tile.x * tileSize - left,
      tile.y * tileSize - top,
      tileSize,
      tileSize,
    )
  })
  drawRoute(
    context,
    parts,
    (point) => {
      const projected = project(point, view.zoom)
      return { x: projected.x - left, y: projected.y - top }
    },
  )
  context.restore()
  drawFooter(context, lines, "© OpenStreetMap contributors")
  return canvasToJpeg(canvas)
}

async function drawLineMap<T extends SharePoint>(
  route: T[],
  parts: T[][],
  lines: string[],
) {
  const canvas = document.createElement("canvas")
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const context = canvas.getContext("2d")
  if (!context) throw new Error("道の図を作れませんでした。")
  context.fillStyle = "#e7f0e4"
  context.fillRect(0, 0, canvasWidth, canvasHeight)
  context.fillStyle = "#f7faf4"
  context.fillRect(36, 36, canvasWidth - 72, mapHeight - 72)
  const projected = route.map((point) => project(point, 16))
  const minX = Math.min(...projected.map((point) => point.x))
  const maxX = Math.max(...projected.map((point) => point.x))
  const minY = Math.min(...projected.map((point) => point.y))
  const maxY = Math.max(...projected.map((point) => point.y))
  const spanX = Math.max(maxX - minX, 80)
  const spanY = Math.max(maxY - minY, 80)
  const scale = Math.min(
    (canvasWidth - 180) / spanX,
    (mapHeight - 180) / spanY,
  )
  const offsetX = (canvasWidth - spanX * scale) / 2 - minX * scale
  const offsetY = (mapHeight - spanY * scale) / 2 - minY * scale
  const pointAt = (point: T) => {
    const index = route.indexOf(point)
    const source = projected[index] ?? project(point, 16)
    return { x: source.x * scale + offsetX, y: source.y * scale + offsetY }
  }
  drawRoute(context, parts, pointAt)
  drawFooter(context, lines, "道の名前は出ていません")
  return canvasToJpeg(canvas)
}

function drawRoute<T extends SharePoint>(
  context: CanvasRenderingContext2D,
  parts: T[][],
  pointAt: (point: T) => { x: number; y: number },
) {
  parts.forEach((part) => {
    const pixels = part.map(pointAt)
    strokePath(context, pixels, "#ffffff", 14)
    strokePath(context, pixels, "#2f7d67", 8)
  })
  const flat = parts.flat()
  if (flat.length === 0) return
  const start = pointAt(flat[0])
  const end = pointAt(flat[flat.length - 1])
  const close = Math.hypot(end.x - start.x, end.y - start.y) < 64
  if (flat.length === 1) {
    drawMarker(context, start, "#2f7d67", "ここ", -22)
    return
  }
  drawMarker(context, start, "#2f7d67", "出発", -22)
  drawMarker(context, end, "#c15b38", "終わり", close ? 36 : -22)
}

function strokePath(
  context: CanvasRenderingContext2D,
  pixels: { x: number; y: number }[],
  color: string,
  width: number,
) {
  if (pixels.length < 2) return
  context.beginPath()
  context.moveTo(pixels[0].x, pixels[0].y)
  pixels.slice(1).forEach((point) => context.lineTo(point.x, point.y))
  context.strokeStyle = color
  context.lineWidth = width
  context.lineCap = "round"
  context.lineJoin = "round"
  context.stroke()
}

function drawMarker(
  context: CanvasRenderingContext2D,
  point: { x: number; y: number },
  color: string,
  label: string,
  labelOffset: number,
) {
  context.beginPath()
  context.arc(point.x, point.y, 16, 0, Math.PI * 2)
  context.fillStyle = "#ffffff"
  context.fill()
  context.lineWidth = 6
  context.strokeStyle = color
  context.stroke()
  context.beginPath()
  context.arc(point.x, point.y, 6, 0, Math.PI * 2)
  context.fillStyle = color
  context.fill()
  context.font = `700 28px ${fontFamily}`
  context.textAlign = "center"
  context.lineWidth = 6
  context.strokeStyle = "#ffffff"
  context.strokeText(label, point.x, point.y + labelOffset)
  context.fillStyle = "#245c4b"
  context.fillText(label, point.x, point.y + labelOffset)
}

function drawFooter(
  context: CanvasRenderingContext2D,
  lines: string[],
  attribution: string,
) {
  context.fillStyle = "#fffefa"
  context.fillRect(0, mapHeight, canvasWidth, canvasHeight - mapHeight)
  context.strokeStyle = "#d5e3d8"
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(0, mapHeight)
  context.lineTo(canvasWidth, mapHeight)
  context.stroke()
  context.fillStyle = "#203d35"
  context.textAlign = "left"
  context.textBaseline = "middle"
  const body = lines.filter(Boolean).slice(0, 4)
  const attributionSpace = attribution ? 36 : 16
  const available = canvasHeight - mapHeight - attributionSpace
  const lineHeight = Math.min(40, available / Math.max(body.length, 1))
  body.forEach((line, index) => {
    let size = 30
    context.font = `700 ${size}px ${fontFamily}`
    while (size > 18 && context.measureText(line).width > canvasWidth - 64) {
      size -= 1
      context.font = `700 ${size}px ${fontFamily}`
    }
    context.fillStyle = "#203d35"
    context.fillText(
      line,
      32,
      mapHeight + lineHeight * index + lineHeight / 2 + 6,
      canvasWidth - 64,
    )
  })
  if (attribution) {
    context.font = `400 18px ${fontFamily}`
    context.fillStyle = "#60776f"
    context.fillText(attribution, 32, canvasHeight - 22)
  }
}

function loadTile(zoom: number, x: number, y: number, tileCount: number) {
  const wrapped = ((x % tileCount) + tileCount) % tileCount
  const key = `${zoom}/${wrapped}/${y}`
  const cached = tileCache.get(key)
  if (cached) return Promise.resolve(cached)
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = "anonymous"
    const timeout = window.setTimeout(() => reject(new Error("地図画像が時間内に届きませんでした。")), 7000)
    image.onload = () => {
      window.clearTimeout(timeout)
      tileCache.set(key, image)
      if (tileCache.size > 48) {
        const oldest = tileCache.keys().next().value
        if (oldest) tileCache.delete(oldest)
      }
      resolve(image)
    }
    image.onerror = () => {
      window.clearTimeout(timeout)
      reject(new Error("地図画像を読み込めませんでした。"))
    }
    image.src = `https://tile.openstreetmap.org/${key}.png`
  })
}

function rejectAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    window.setTimeout(
      () => reject(new Error("地図画像が時間内に届きませんでした。")),
      milliseconds,
    )
  })
}

function canvasToJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob && blob.size <= 1_800_000) resolve(blob)
        else if (blob) {
          canvas.toBlob(
            (smaller) => {
              if (smaller) resolve(smaller)
              else reject(new Error("道の図を書き出せませんでした。"))
            },
            "image/jpeg",
            0.62,
          )
        } else {
          reject(new Error("道の図を書き出せませんでした。"))
        }
      },
      "image/jpeg",
      0.86,
    )
  })
}
