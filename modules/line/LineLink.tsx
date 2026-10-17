"use client";

/** LINE 連結：點擊時用 sendBeacon 記錄（不擋跳轉） */
export function LineLink(props: { href: string; slug: string; path: string; placement: "section" | "floating"; className?: string; children: React.ReactNode; ariaLabel?: string }) {
  const onClick = () => {
    try {
      const body = JSON.stringify({ path: props.path, placement: props.placement });
      const url = `/api/s/${props.slug}/line-click`;
      if (!navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) {
        void fetch(url, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true });
      }
    } catch {
      /* 追蹤失敗不影響跳轉 */
    }
  };
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer" onClick={onClick} className={props.className} aria-label={props.ariaLabel}>
      {props.children}
    </a>
  );
}
