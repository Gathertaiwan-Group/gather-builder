"use client";

import { useCallback, useEffect, useState } from "react";

export interface LightboxItem {
  src: string;
  alt: string;
  title?: string;
  caption?: string;
  href?: string;
}

/** 圖片網格＋燈箱（相簿與作品集共用） */
export function LightboxGrid({ items, columns = 3 }: { items: LightboxItem[]; columns?: 2 | 3 }) {
  const [open, setOpen] = useState<number | null>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") setOpen((i) => (i === null ? i : (i + 1) % items.length));
      if (e.key === "ArrowLeft") setOpen((i) => (i === null ? i : (i - 1 + items.length) % items.length));
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, close, items.length]);

  const cur = open === null ? null : items[open];
  return (
    <>
      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${columns === 3 ? "lg:grid-cols-3" : ""}`}>
        {items.map((it, i) => (
          <button
            key={`${it.src}-${i}`}
            type="button"
            onClick={() => setOpen(i)}
            className="gb-card group block overflow-hidden p-0 text-left"
            style={{ cursor: "zoom-in" }}
          >
            <img src={it.src} alt={it.alt} loading="lazy" className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
            {(it.title || it.caption) && (
              <span className="block p-3 text-sm">
                {it.title && <strong className="block">{it.title}</strong>}
                {it.caption && <span className="gb-muted">{it.caption}</span>}
              </span>
            )}
          </button>
        ))}
      </div>
      {cur && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={cur.title ?? cur.alt}
          onClick={close}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <figure onClick={(e) => e.stopPropagation()} className="m-0 max-h-full max-w-4xl overflow-auto rounded-lg bg-white text-neutral-900">
            <img src={cur.src} alt={cur.alt} className="max-h-[75vh] w-full object-contain" />
            {(cur.title || cur.caption || cur.href) && (
              <figcaption className="p-4 text-sm">
                {cur.title && <strong className="mb-1 block text-base">{cur.title}</strong>}
                {cur.caption && <p className="m-0 whitespace-pre-line">{cur.caption}</p>}
                {cur.href && (
                  <a href={cur.href} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block underline">
                    查看專案
                  </a>
                )}
              </figcaption>
            )}
          </figure>
          <button type="button" onClick={close} aria-label="關閉" className="absolute right-4 top-4 h-11 w-11 rounded-full bg-white/90 text-xl">
            ×
          </button>
        </div>
      )}
    </>
  );
}
