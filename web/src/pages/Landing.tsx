import { useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import {
  DOWNLOAD_URL,
  PLANS,
  PRIVACY_LINE,
  RESET_LABEL,
  TRIAL_LINE,
  proPrice,
  type BillingInterval,
} from "../content";
import { clerkEnabled } from "../lib/clerk";
import { formatNumber } from "../lib/format";
import { usePageMeta } from "../lib/head";
import { Link } from "../lib/router";
import {
  AppsIcon,
  ArrowRightIcon,
  BookIcon,
  CheckIcon,
  ChevronIcon,
  CleanupIcon,
  DownloadIcon,
  KeyboardIcon,
  LockIcon,
  ShieldIcon,
  WaveIcon,
} from "../components/Icons";
import { HeroBar } from "../components/HeroBar";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";

const starterFeatures = [
  `${formatNumber(PLANS.starter.weeklyWords)} words a week`,
  `Resets ${RESET_LABEL}`,
  "Live transcription",
  "Structured cleanup",
  "Personal dictionary",
  "Works in any Windows app",
  "Custom dictation shortcut",
];

const proFeatures = [
  "Unlimited words · fair use applies",
  "Everything in Starter",
  "Live transcription + Structured cleanup",
  "Cancel anytime",
];

const faqs: { question: string; answer: ReactNode }[] = [
  {
    question: "What happens to my audio and transcripts?",
    answer: (
      <>
        Audio and transcripts are sent over a Cloudflare Worker to AssemblyAI
        to be transcribed and cleaned up, then discarded from our servers.{" "}
        {PRIVACY_LINE} We keep only your account details, your subscription,
        weekly usage counts (words and audio minutes), and device sign-ins. Your
        local History stays on your PC.{" "}
        <Link to="/privacy">Read the privacy policy</Link>.
      </>
    ),
  },
  {
    question: "What counts as a word?",
    answer:
      "Ray counts the words in the final transcript. Punctuation doesn't add to the count, and the cleanup pass never counts twice.",
  },
  {
    question: "What happens when I reach the Starter limit?",
    answer: `Starter includes ${formatNumber(
      PLANS.starter.weeklyWords,
    )} words every week, resetting every ${
      PLANS.starter.resetDay
    } at ${
      PLANS.starter.resetTime
    }. When you hit the limit, Ray stops recording and asks you to upgrade. A dictation that crosses the line keeps the part already transcribed (up to about two minutes) and is counted.`,
  },
  {
    question: "Can I try Pro before paying?",
    answer: `${TRIAL_LINE} Pro starts on your first desktop sign-in and runs for 14 days; when it ends you can keep dictating on the free Starter plan.`,
  },
  {
    question: "Can I use Ray on a shared PC?",
    answer:
      "Free plans are limited to three accounts per PC. Additional accounts can sign in but need Pro to dictate.",
  },
  {
    question: "Can I cancel Pro anytime?",
    answer:
      "Yes. Pro is billed through Creem, our merchant of record. Cancel from Account → Manage billing and you keep Pro until the end of the period you paid for.",
  },
  {
    question: "Does Ray work on Windows 10?",
    answer:
      "Ray supports Windows 10 and 11. It needs WebView2, which is already present on current Windows installs. There is no Mac version.",
  },
];

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="eyebrow">
      <span className="eyebrow-dot" aria-hidden="true" />
      {children}
    </p>
  );
}

function SectionHead({
  eyebrow,
  title,
  lede,
  centered = false,
  id,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  centered?: boolean;
  id?: string;
}) {
  return (
    <div className={`section-head${centered ? " is-centered" : ""}`}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 id={id}>{title}</h2>
      <p className="section-lede">{lede}</p>
    </div>
  );
}

function HeroShot() {
  return (
    <div
      className="shot"
      role="img"
      aria-label="Ray's floating dictation bar resting over a notes document"
    >
      <div className="shot-window">
        <div className="shot-chrome">
          <span className="shot-app">Notes</span>
          <span className="shot-kbd">
            <kbd>Right Alt</kbd>
            <span>to dictate</span>
          </span>
        </div>
        <div className="shot-doc">
          <p className="shot-title">Launch notes</p>
          <p>
            We shipped the new onboarding flow today. Three things left before
            Tuesday:
          </p>
          <ul>
            <li>Polish the empty states</li>
            <li>Write the migration guide</li>
            <li>Check the pricing page at 360 px</li>
          </ul>
          <p>
            Next week we&rsquo;ll focus on the release checklist
            <span className="caret" aria-hidden="true" />
          </p>
        </div>
      </div>
      <HeroBar />
    </div>
  );
}

function CleanupDemo() {
  return (
    <div className="cleanup-demo">
      <div className="cleanup-col">
        <span className="cleanup-label">You said</span>
        <p className="cleanup-raw">
          um so I think we should <s>like</s> move the launch to Tuesday, and
          uh, maybe cut the pricing section down to two plans?
        </p>
      </div>
      <span className="cleanup-arrow" aria-hidden="true">
        <ArrowRightIcon size={16} />
      </span>
      <div className="cleanup-col">
        <span className="cleanup-label">Ray pasted</span>
        <p className="cleanup-clean">
          Let&rsquo;s move the launch to Tuesday and cut the pricing section
          down to two plans.
        </p>
      </div>
    </div>
  );
}

function GetProCta({ interval }: { interval: BillingInterval }) {
  if (!clerkEnabled) {
    return (
      <Link
        className="btn btn-primary btn-block"
        to={`/sign-up?redirect_url=${encodeURIComponent(
          `/account?interval=${interval}`,
        )}`}
      >
        Get Pro
        <ArrowRightIcon size={15} />
      </Link>
    );
  }
  return <ClerkGetProCta interval={interval} />;
}

function ClerkGetProCta({ interval }: { interval: BillingInterval }) {
  const { isLoaded, isSignedIn } = useAuth();
  // Before Clerk resolves, /account is the safe destination either way: a
  // signed-in visitor stays there, a signed-out one is sent to sign-in with
  // the interval preserved in the redirect URL.
  const to = !isLoaded
    ? `/account?interval=${interval}`
    : isSignedIn
      ? `/account?interval=${interval}&checkout=1`
      : `/sign-up?redirect_url=${encodeURIComponent(
          `/account?interval=${interval}`,
        )}`;

  return (
    <Link className="btn btn-primary btn-block" to={to}>
      Get Pro
      <ArrowRightIcon size={15} />
    </Link>
  );
}

function Pricing() {
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const price = proPrice(interval);

  return (
    <section className="section pricing-section" id="pricing">
      <div className="container">
        <SectionHead
          eyebrow="Pricing"
          title="Start free. Go Pro when you live in it."
          lede="Every feature is in both plans. The only difference is how much you can say."
          centered
        />

        <div
          className="billing-toggle"
          role="group"
          aria-label="Pro billing interval"
        >
          <button
            type="button"
            aria-pressed={interval === "monthly"}
            onClick={() => setInterval("monthly")}
          >
            Monthly
          </button>
          <button
            type="button"
            aria-pressed={interval === "annual"}
            onClick={() => setInterval("annual")}
          >
            Annual
            <span className="save-pill">{PLANS.pro.annual.savings}</span>
          </button>
        </div>
        <p className="sr-only" aria-live="polite">
          Pro costs ${price.price} per month, {price.billing.toLowerCase()}.
        </p>

        <div className="pricing-grid">
          <article className="price-card">
            <header className="price-card-head">
              <span className="plan-name">{PLANS.starter.name}</span>
              <span className="plan-badge">Free</span>
            </header>
            <div className="price-line">
              <span className="price-amount">$0</span>
              <span className="price-period">forever</span>
            </div>
            <p className="price-billing">{PLANS.starter.blurb}</p>

            <a className="btn btn-secondary btn-block" href={DOWNLOAD_URL}>
              <DownloadIcon size={15} />
              Download for Windows
            </a>

            <ul className="plan-features">
              {starterFeatures.map((feature) => (
                <li key={feature}>
                  <CheckIcon size={14} />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </article>

          <article className="price-card price-card-pro">
            <header className="price-card-head">
              <span className="plan-name">{PLANS.pro.name}</span>
              <span className="plan-badge">Unlimited</span>
            </header>
            <div className="price-line" key={interval}>
              <span className="price-amount">${price.price}</span>
              <span className="price-period">{price.period}</span>
            </div>
            <p className="price-billing">
              {price.billing}
              {interval === "annual" ? (
                <span className="save-inline"> · {PLANS.pro.annual.savings}</span>
              ) : null}
            </p>

            <GetProCta interval={interval} />

            <ul className="plan-features">
              {proFeatures.map((feature) => (
                <li key={feature}>
                  <CheckIcon size={14} />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>

        <p className="pricing-note">{TRIAL_LINE}</p>
        <p className="pricing-note">
          Prices in USD. Pro renews monthly or yearly until you cancel. Creem
          is our merchant of record.
        </p>
      </div>
    </section>
  );
}

export function LandingPage() {
  usePageMeta({ path: "/" });

  return (
    <div className="site">
      <SiteHeader />
      <main id="main" tabIndex={-1}>
        <section className="hero" aria-labelledby="hero-title">
          <div className="container hero-inner">
            <div className="hero-copy">
              <Eyebrow>Dictation for Windows 10 &amp; 11</Eyebrow>
              <h1 id="hero-title">Fast, clean dictation for Windows.</h1>
              <p className="hero-lede">
                Press a shortcut, speak, and polished text appears wherever
                you&rsquo;re typing. Ray transcribes live, tidies up the
                rambling, and stays out of your way.
              </p>
              <div className="hero-actions">
                <a className="btn btn-primary btn-lg" href={DOWNLOAD_URL}>
                  <DownloadIcon size={16} />
                  Download for Windows
                </a>
                <a className="btn btn-secondary btn-lg" href="#pricing">
                  See pricing
                </a>
              </div>
              <p className="hero-note">
                Free to start · {formatNumber(PLANS.starter.weeklyWords)} words
                a week · No card required
              </p>
            </div>

            <div className="hero-visual">
              <HeroShot />
            </div>
          </div>
        </section>

        <section className="section" id="how-it-works">
          <div className="container">
            <SectionHead
              eyebrow="How it works"
              title="Three seconds from thought to text."
              lede="No recorder to open, no window to switch to. The words land where your cursor already is."
            />
            <ol className="steps">
              <li className="step">
                <span className="step-number">01</span>
                <h3>Press your shortcut</h3>
                <p>
                  Right Alt by default. Pick another key if you&rsquo;d rather
                  — Ray never takes focus from what you&rsquo;re doing.
                </p>
              </li>
              <li className="step">
                <span className="step-number">02</span>
                <h3>Speak naturally</h3>
                <p>
                  Ray transcribes while you talk. Stopping leaves only the
                  final decode, typically about half a second.
                </p>
              </li>
              <li className="step">
                <span className="step-number">03</span>
                <h3>Keep working</h3>
                <p>
                  The cleaned text is pasted into the app you were already
                  using. Ray restores your clipboard afterwards.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section className="section" id="features">
          <div className="container">
            <SectionHead
              eyebrow="Features"
              title="Everything dictation should be."
              lede="Fast in the moment, careful with the result, and quiet about everything else."
            />

            <div className="feature-grid">
              <article className="feature-card">
                <span className="feature-icon" aria-hidden="true">
                  <WaveIcon size={18} />
                </span>
                <h3>Live transcription</h3>
                <p>
                  Words stream in while you speak. When you stop, only the
                  final decode is left — typically about half a second.
                </p>
              </article>

              <article className="feature-card feature-cleanup">
                <span className="feature-icon" aria-hidden="true">
                  <CleanupIcon size={18} />
                </span>
                <h3>Structured cleanup</h3>
                <p>
                  Ray rewrites rambling speech for flow, adding paragraphs and
                  lists when they help — then pastes it as if you&rsquo;d typed
                  it that way.
                </p>
                <CleanupDemo />
              </article>

              <article className="feature-card">
                <span className="feature-icon" aria-hidden="true">
                  <BookIcon size={18} />
                </span>
                <h3>Personal dictionary</h3>
                <p>
                  Teach Ray the names, products, and odd spellings you use. It
                  keeps them right across every dictation.
                </p>
              </article>

              <article className="feature-card">
                <span className="feature-icon" aria-hidden="true">
                  <AppsIcon size={18} />
                </span>
                <h3>Works in any app</h3>
                <p>
                  Email, Slack, Notion, your editor, a terminal. Anywhere
                  Windows can paste, Ray can dictate.
                </p>
              </article>

              <article className="feature-card">
                <span className="feature-icon" aria-hidden="true">
                  <KeyboardIcon size={18} />
                </span>
                <h3>Your shortcut</h3>
                <p>
                  Right Alt by default. Make it whatever key your hands already
                  know, and change it whenever.
                </p>
              </article>

              <article className="feature-card feature-privacy">
                <div className="feature-privacy-copy">
                  <span className="feature-icon" aria-hidden="true">
                    <ShieldIcon size={18} />
                  </span>
                  <h3>Private by default</h3>
                  <p>
                    Your audio and transcripts are sent to AssemblyAI to be
                    transcribed and cleaned up. {PRIVACY_LINE}
                  </p>
                </div>
                <div className="privacy-route" aria-hidden="true">
                  <span>Your voice</span>
                  <ArrowRightIcon size={14} />
                  <span>AssemblyAI</span>
                  <ArrowRightIcon size={14} />
                  <span>Your text</span>
                </div>
                <p className="privacy-note">
                  <LockIcon size={14} />
                  Only your account, subscription, weekly usage counts (words
                  and audio minutes), and device sign-ins are stored on our
                  servers. History stays on your PC.
                </p>
              </article>
            </div>
          </div>
        </section>

        <Pricing />

        <section className="section" id="faq">
          <div className="container faq-container">
            <SectionHead
              eyebrow="FAQ"
              title="Questions, answered."
              lede="The short version of what Ray does with your words."
            />
            <div className="faq-list">
              {faqs.map((item) => (
                <details className="faq-item" key={item.question}>
                  <summary>
                    <span>{item.question}</span>
                    <ChevronIcon className="faq-chevron" size={16} />
                  </summary>
                  <div className="faq-answer">{item.answer}</div>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="final-cta">
          <div className="container final-cta-inner">
            <h2>Stop typing. Start talking.</h2>
            <p>
              Install Ray on Windows 10 or 11 and dictate your next email.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary btn-lg" href={DOWNLOAD_URL}>
                <DownloadIcon size={16} />
                Download for Windows
              </a>
              <a className="btn btn-secondary btn-lg" href="#pricing">
                See pricing
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
