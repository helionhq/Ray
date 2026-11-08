import { LegalPage } from "../components/LegalPage";
import {
  CONTACT_EMAIL,
  PLANS,
  PRIVACY_LINE,
  REPOSITORY_URL,
} from "../content";
import { formatNumber } from "../lib/format";
import { usePageMeta } from "../lib/head";
import { Link } from "../lib/router";

export function TermsPage() {
  usePageMeta({
    title: "Terms",
    description: "The terms that govern your use of Ray, its plans, and billing.",
    path: "/terms",
  });

  return (
    <LegalPage title="Terms of service" updated="November 8, 2026">
      <p>
        These terms are a working draft and will be reviewed by counsel before
        launch. By downloading, installing, or using Ray, you agree to them.
      </p>

      <h2>The service</h2>
      <p>
        Ray is a Windows dictation application made by Helion. It records audio
        while you dictate, sends it to AssemblyAI for transcription and cleanup,
        and pastes the result into the app you were using. Ray also includes a
        floating recording bar, a personal dictionary, and local history.
      </p>

      <h2>License</h2>
      <p>
        Helion grants you a personal, non-exclusive, non-transferable,
        revocable license to install and use Ray on Windows devices you own or
        control, for personal or internal business use. You may not resell,
        redistribute, or sublicense the app, or attempt to reverse engineer it,
        except where applicable law says you may.
      </p>

      <h2>Accounts</h2>
      <p>
        You need a Ray account to use the app. Keep your sign-in credentials and
        devices secure; you are responsible for activity under your account.
        Provide accurate account information and let us know about unauthorized
        use.
      </p>

      <h2>Plans, billing, and cancellation</h2>
      <p>
        <strong>{PLANS.starter.name}</strong> is free and includes{" "}
        {formatNumber(PLANS.starter.weeklyWords)} words per week, resetting
        every {PLANS.starter.resetDay} at {PLANS.starter.resetTime}. A
        dictation that crosses the limit is allowed to finish and is counted.
      </p>
      <p>
        <strong>{PLANS.pro.name}</strong> is billed at ${PLANS.pro.monthly.price}
        /month on the monthly plan, or ${PLANS.pro.annual.price}/month billed
        annually (${PLANS.pro.annual.total}/year). Creem is our merchant of
        record and handles checkout, payment methods, invoices, and applicable
        tax. Subscriptions renew automatically until canceled.
      </p>
      <p>
        Pro is marketed as unlimited, but it is subject to a fair-use limit that
        protects the service for everyone. Ordinary personal dictation is not
        affected; automated, abusive, or resold use is not fair use. If you
        reach the fair-use limit, dictation pauses until the weekly reset on{" "}
        {PLANS.starter.resetDay} at {PLANS.starter.resetTime}.
      </p>
      <p>
        You can cancel from Account → Manage billing. Cancellation stops future
        charges and you keep Pro until the end of the period you already paid
        for. Prices may change with notice; any change applies at your next
        renewal. Refunds are handled under Creem&rsquo;s terms and applicable
        law.
      </p>

      <h2>Your content</h2>
      <p>
        You keep all rights to your audio and the text Ray produces for you. You
        grant Helion the limited permission needed to send that audio and text
        to our speech-processing provider to deliver the service. {PRIVACY_LINE}{" "}
        See the <Link to="/privacy">privacy policy</Link> for details.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Do not use Ray for unlawful content or to violate anyone&rsquo;s rights.</li>
        <li>Do not attempt to bypass word limits, disrupt the service, or resell access.</li>
        <li>
          Do not dictate audio you do not have the right to process, such as
          someone else&rsquo;s private conversation without consent.
        </li>
      </ul>

      <h2>Availability and changes</h2>
      <p>
        Ray is actively developed. We may add, change, or remove features and
        limits. We work to keep the service reliable, but we do not guarantee
        uninterrupted availability; maintenance, provider outages, and network
        problems can happen. If we discontinue a paid plan, we will give
        reasonable notice and refund any unused prepaid period.
      </p>

      <h2>Disclaimer</h2>
      <p>
        Transcription and cleanup can make mistakes. Review important text
        before you send, file, or act on it, and do not treat Ray as the only
        copy of anything important. Ray is provided &ldquo;as is&rdquo; and
        &ldquo;as available&rdquo; to the extent permitted by law, without
        warranties of merchantability, fitness for a particular purpose, or
        non-infringement.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, Helion is not liable for
        indirect, incidental, special, or consequential damages, or for lost
        data, profits, or business opportunity. Our total liability for any
        claim is limited to the amount you paid us in the twelve months before
        the claim, or $50 if you are on the Starter plan. Some jurisdictions do
        not allow these limits, so parts of this section may not apply to you.
      </p>

      <h2>Termination</h2>
      <p>
        You can stop using Ray at any time and request deletion of your account.
        We may suspend or terminate access if you materially violate these
        terms, if required by law, or to protect the service and its users.
      </p>

      <h2>Governing law</h2>
      <p>
        This section is a placeholder pending legal review. The governing law,
        venue, and dispute-resolution terms will be completed before launch.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms:{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. You can also
        reach us through the{" "}
        <a href={REPOSITORY_URL} rel="noreferrer">
          Ray repository
        </a>
        . See the <Link to="/privacy">privacy policy</Link> for how data is
        handled.
      </p>
    </LegalPage>
  );
}
