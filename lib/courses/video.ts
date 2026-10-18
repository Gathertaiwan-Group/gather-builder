/**
 * 課程影片網址白名單：只接受 YouTube（含未公開連結）與 Vimeo，正規化成 embed 網址（YouTube 用 youtube-nocookie）。
 * 其他網域一律拒絕——iframe 來源可控，避免把任意網頁嵌進租戶網站。
 */
export function toEmbedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  const yt = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null);
  if (host === "youtu.be") return yt(u.pathname.slice(1).split("/")[0]);
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") return yt(u.searchParams.get("v"));
    const m = /^\/(embed|shorts|live)\/([^/?#]+)/.exec(u.pathname);
    return m ? yt(m[2]) : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    // vimeo.com/123、vimeo.com/123/abcdef（未公開 hash）、player.vimeo.com/video/123?h=abcdef
    const m = /^\/(?:video\/)?(\d{5,12})(?:\/([0-9a-f]{6,20}))?\/?$/.exec(u.pathname);
    if (!m) return null;
    const hash = m[2] ?? u.searchParams.get("h");
    if (hash && !/^[0-9a-f]{6,20}$/.test(hash)) return null;
    return `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ""}`;
  }
  return null;
}
