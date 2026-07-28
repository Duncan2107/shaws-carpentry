/* Shaws Carpentry — shared behaviour */

// Mobile navigation toggle
const navToggle = document.querySelector(".nav-toggle");
const siteNav = document.querySelector(".site-nav");

if (navToggle && siteNav) {
  navToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

// Sticky header shadow
const header = document.querySelector(".site-header");
if (header) {
  const onScroll = () => {
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

// Scroll reveal (respects reduced motion)
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealEls = document.querySelectorAll(".reveal");

if (revealEls.length && !prefersReducedMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  revealEls.forEach((el) => observer.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add("is-visible"));
}

// Gallery lightbox
const lightbox = document.querySelector(".lightbox");
if (lightbox) {
  const lightboxImg = lightbox.querySelector("img");
  const lightboxCaption = lightbox.querySelector(".lightbox__caption");
  const closeBtn = lightbox.querySelector(".lightbox__close");
  let lastFocused = null;

  const openLightbox = (src, caption) => {
    lightboxImg.src = src;
    lightboxImg.alt = caption;
    lightboxCaption.textContent = caption;
    lightbox.classList.add("is-open");
    lastFocused = document.activeElement;
    closeBtn.focus();
    document.body.style.overflow = "hidden";
  };

  const closeLightbox = () => {
    lightbox.classList.remove("is-open");
    document.body.style.overflow = "";
    if (lastFocused) lastFocused.focus();
  };

  document.querySelectorAll(".gallery-item").forEach((item) => {
    const open = () => {
      const img = item.querySelector("img");
      const caption = item.querySelector("figcaption");
      openLightbox(img.src, caption ? caption.textContent : img.alt);
    };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });

  closeBtn.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lightbox.classList.contains("is-open")) closeLightbox();
  });
}

// Contact form — validates, then sends the enquiry via the form service
const contactForm = document.querySelector("#contact-form");
if (contactForm) {
  const statusEl = contactForm.querySelector(".form-status");

  const validateField = (field) => {
    const wrapper = field.closest(".form-field");
    if (!wrapper) return true;
    let valid = field.checkValidity();
    wrapper.classList.toggle("has-error", !valid);
    return valid;
  };

  contactForm.querySelectorAll("input, textarea").forEach((field) => {
    field.addEventListener("blur", () => validateField(field));
    field.addEventListener("input", () => {
      const wrapper = field.closest(".form-field");
      if (wrapper && wrapper.classList.contains("has-error") && field.checkValidity()) {
        wrapper.classList.remove("has-error");
      }
    });
  });

  contactForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const fields = Array.from(contactForm.querySelectorAll("input, select, textarea"));
    let firstInvalid = null;
    fields.forEach((field) => {
      if (!validateField(field) && !firstInvalid) firstInvalid = field;
    });
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const submitBtn = contactForm.querySelector('button[type="submit"]');
    const restoreLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";
    statusEl.classList.remove("is-success", "is-error");
    statusEl.setAttribute("role", "status");

    fetch(contactForm.dataset.endpoint, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new FormData(contactForm),
    })
      .then((res) => {
        if (!res.ok) throw new Error("send failed");
        statusEl.textContent = "Thanks for your enquiry, we will be in touch soon.";
        statusEl.classList.add("is-success");
        contactForm.reset();
      })
      .catch(() => {
        const to = contactForm.dataset.email || "stuart@shawscarpentry.com";
        statusEl.textContent = `Sorry, your message could not be sent. Please email us directly at ${to} or give us a call.`;
        statusEl.classList.add("is-error");
      })
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = restoreLabel;
      });
  });
}
