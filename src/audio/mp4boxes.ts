/** ISO BMFF (MP4/M4A) のボックス走査ユーティリティ */

export type Box = {
  type: string;
  /** ボックス先頭 (サイズ+タイプ) のオフセット */
  start: number;
  /** ペイロード先頭のオフセット */
  contentStart: number;
  /** ボックス終端のオフセット */
  end: number;
};

export function readBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4),
      view.getUint8(pos + 5),
      view.getUint8(pos + 6),
      view.getUint8(pos + 7),
    );
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = view.getUint32(pos + 8) * 4294967296 + view.getUint32(pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    boxes.push({ type, start: pos, contentStart: pos + header, end: pos + size });
    pos += size;
  }
  return boxes;
}

export function findBox(view: DataView, start: number, end: number, type: string): Box | null {
  for (const box of readBoxes(view, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** パス (例: ['moov', 'trak', 'mdia']) をたどって最初に見つかったボックスを返す */
export function findBoxPath(view: DataView, path: string[]): Box | null {
  let start = 0;
  let end = view.byteLength;
  let found: Box | null = null;
  for (const type of path) {
    found = findBox(view, start, end, type);
    if (!found) return null;
    start = found.contentStart;
    end = found.end;
  }
  return found;
}
