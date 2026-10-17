import { renderMarkdown } from "@/lib/markdown";
import { LightboxGrid } from "@/components/site/Lightbox";
import { siteHref, type SectionComponent } from "../render-types";
import type { z } from "zod";
import type { ctaProps, faqProps, featuresProps, galleryProps, heroProps, richTextProps, testimonialsProps } from "./manifest";

export const Hero: SectionComponent = ({ props, ctx }) => {
  const p = props as z.output<typeof heroProps>;
  const center = p.align !== "left";
  return (
    <section
      className="relative overflow-hidden"
      style={
        p.image
          ? { backgroundImage: `linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)), url("${encodeURI(p.image)}")`, backgroundSize: "cover", backgroundPosition: "center", color: "#fff" }
          : { background: "linear-gradient(160deg, var(--gb-surface), var(--gb-bg))" }
      }
    >
      <div className={`gb-container py-20 md:py-32 ${center ? "text-center" : ""}`}>
        <h1 className="m-0 text-[clamp(2rem,1.4rem+3vw,3.75rem)] font-bold" data-gb="hero-heading">
          {p.heading}
        </h1>
        {p.subheading && <p className={`mt-5 max-w-2xl text-lg leading-relaxed opacity-90 ${center ? "mx-auto" : ""}`}>{p.subheading}</p>}
        {p.ctaLabel && p.ctaHref && (
          <a className="gb-btn mt-8" href={siteHref(ctx, p.ctaHref)}>
            {p.ctaLabel}
          </a>
        )}
      </div>
    </section>
  );
};

export const RichText: SectionComponent = ({ props }) => {
  const p = props as z.output<typeof richTextProps>;
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <div className="gb-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.markdown) }} />
      </div>
    </section>
  );
};

export const Features: SectionComponent = ({ props }) => {
  const p = props as z.output<typeof featuresProps>;
  return (
    <section className="gb-section">
      <div className="gb-container">
        {p.heading && <h2 className="gb-h2 text-center">{p.heading}</h2>}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {p.items.map((it, i) => (
            <div key={i} className="gb-card p-6">
              {it.icon && <div className="mb-3 text-3xl" aria-hidden>{it.icon}</div>}
              <h3 className="m-0 mb-2 text-lg font-bold" style={{ color: "var(--gb-secondary)" }}>{it.title}</h3>
              <p className="gb-muted m-0 leading-relaxed">{it.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export const Gallery: SectionComponent = ({ props }) => {
  const p = props as z.output<typeof galleryProps>;
  return (
    <section className="gb-section">
      <div className="gb-container">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <LightboxGrid items={p.images.map((im) => ({ src: im.src, alt: im.alt, caption: im.caption }))} />
      </div>
    </section>
  );
};

export const Testimonials: SectionComponent = ({ props }) => {
  const p = props as z.output<typeof testimonialsProps>;
  return (
    <section className="gb-section" style={{ background: "var(--gb-surface)" }}>
      <div className="gb-container">
        {p.heading && <h2 className="gb-h2 text-center">{p.heading}</h2>}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {p.items.map((it, i) => (
            <figure key={i} className="gb-card m-0 p-6" style={{ background: "var(--gb-bg)" }}>
              <blockquote className="m-0 text-lg leading-relaxed">「{it.quote}」</blockquote>
              <figcaption className="gb-muted mt-4 text-sm">
                — {it.author}
                {it.role ? `，${it.role}` : ""}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
};

export const Faq: SectionComponent = ({ props }) => {
  const p = props as z.output<typeof faqProps>;
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <div className="flex flex-col gap-3">
          {p.items.map((it, i) => (
            <details key={i} className="gb-card px-5 py-4">
              <summary className="cursor-pointer font-semibold">{it.q}</summary>
              <p className="gb-muted mb-0 mt-3 whitespace-pre-line leading-relaxed">{it.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
};

export const Cta: SectionComponent = ({ props, ctx }) => {
  const p = props as z.output<typeof ctaProps>;
  return (
    <section className="gb-section">
      <div className="gb-container">
        <div className="px-6 py-12 text-center text-white md:px-12" style={{ background: "var(--gb-secondary)", borderRadius: "var(--gb-radius)" }}>
          <h2 className="m-0 text-2xl font-bold md:text-3xl">{p.heading}</h2>
          {p.body && <p className="mx-auto mt-3 max-w-xl opacity-90">{p.body}</p>}
          <a className="gb-btn mt-6" href={siteHref(ctx, p.buttonHref)}>
            {p.buttonLabel}
          </a>
        </div>
      </div>
    </section>
  );
};
