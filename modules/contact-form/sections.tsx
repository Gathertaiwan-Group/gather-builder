import type { z } from "zod";
import type { SectionComponent } from "../render-types";
import type { contactFormProps } from "./manifest";
import { ContactFormClient } from "./ContactFormClient";

export const ContactForm: SectionComponent = ({ props, ctx }) => {
  const p = props as z.output<typeof contactFormProps>;
  return (
    <section className="gb-section" id="contact">
      <div className="gb-container max-w-3xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {p.intro && <p className="gb-muted mb-6 mt-0">{p.intro}</p>}
        {ctx.site.mode === "preview" ? (
          <p className="gb-card gb-muted p-6 text-sm">（預覽模式：表單在正式網站才能送出）</p>
        ) : (
          <ContactFormClient
            endpoint={`/api/s/${ctx.site.tenant.slug}/inquiry`}
            path={ctx.path}
            submitLabel={p.submitLabel ?? "送出"}
            successMessage={p.successMessage ?? "已收到您的訊息，我們會盡快回覆！"}
            showPhone={p.showPhone}
          />
        )}
      </div>
    </section>
  );
};
