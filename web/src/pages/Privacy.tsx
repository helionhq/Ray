import { LegalPage } from "../components/LegalPage";
import { CONTACT_EMAIL, REPOSITORY_URL } from "../content";
import { usePageTitle } from "../lib/hooks";
import { Link } from "../lib/router";

export function PrivacyPage() {
  usePageTitle("Privacy");

  return (
    <LegalPage title="Privacy policy" updated="November 8, 2026">
      <p>
        Ray is a Windows dictation app made by Helion. This policy explains what
        happens to your words when you use the app and this site. It is a
        working draft and will be reviewed by counsel before launch.
      </p>

      <h2>Audio and transcripts</h2>
      <p>
        When you dictate, Ray records audio on your PC and sends it through our
        Cloudflare Worker to <strong>AssemblyAI</strong>, which transcribes it
        and runs the cleanup prompt. The audio and transcript pass through in
        memory.
      </p>
      <p>
        <strong>
          Ray&rsquo;s servers never store or log your audio or transcripts.
        </strong>{" "}
        We do not use them to train models. AssemblyAI processes the audio
        under its own terms and privacy policy as our speech-processing
        provider.
      </p>

      <h2>Account details</h2>
      <p>
        Sign-in is handled by <strong>Clerk</strong>. Clerk processes your email
        address, name, and authentication credentials; Ray receives a Clerk user
        id, your email address, and your name. When you connect the desktop app,
        we store a hashed device token and the time it was last used so the app
        can stay signed in. Signing out of the desktop app revokes that token.
        Your device token itself lives in Windows Credential Manager on your PC.
      </p>

      <h2>Plan, payment, and usage</h2>
      <p>
        <strong>Creem</strong> is our merchant of record. Creem handles checkout,
        payment methods, invoices, and tax; we never receive or store your full
        card details. We receive a customer id, subscription id, plan, billing
        interval, status, and renewal date so we can apply your plan.
      </p>
      <p>
        We store weekly word counts — a number per account, not the text — to
        enforce the Starter limit and a fair-use limit that protects service
        costs. The count resets every Monday at 00:00 UTC.
      </p>

      <h2>What stays on your PC</h2>
      <p>
        Your settings, dictionary, and dictation history live in the Ray app&rsquo;s
        local data folder on your computer. They are not uploaded to our
        servers. Deleting them from the app or the folder removes them.
      </p>

      <h2>What we do not do</h2>
      <ul>
        <li>We do not store audio or transcripts on Ray&rsquo;s servers.</li>
        <li>We do not sell personal data.</li>
        <li>
          We do not use advertising cookies or third-party analytics on this
          site.
        </li>
        <li>We do not use your dictation to train models.</li>
      </ul>

      <h2>Where data lives</h2>
      <p>
        Authentication runs on Clerk, payments run on Creem, and the site, API,
        and database run on Cloudflare (Workers and D1). Speech and cleanup
        processing run on AssemblyAI. These providers may process data in the
        United States and other countries; where required, transfers rely on
        their contractual safeguards.
      </p>

      <h2>Retention</h2>
      <p>
        Account, subscription, and weekly usage rows are kept while your account
        exists, so we can run your plan and enforce its limits. Device tokens
        stay until they are revoked or you sign out. Payment records may be kept
        by Creem for accounting and legal reasons. Write to us to request
        deletion of your Ray account.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        You can sign out of a device at any time in the desktop app, which
        revokes its token. Depending on where you live, you may have the right
        to access, correct, export, or delete your personal data, or to object
        to certain processing. Contact us at{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will
        respond as required by applicable law.
      </p>

      <h2>Cookies and local storage</h2>
      <p>
        This site uses cookies and local storage from Clerk to keep you signed
        in and to protect your session. The desktop app keeps its settings,
        history, and dictionary locally. We do not add analytics or advertising
        cookies of our own.
      </p>

      <h2>Children</h2>
      <p>
        Ray is not directed at children under 13, and we do not knowingly
        collect their personal data. If you believe a child has created an
        account, contact us and we will remove it.
      </p>

      <h2>Changes</h2>
      <p>
        We will update this page and its date when the policy changes. If a
        change is material, we will announce it in the app or by email where
        appropriate.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about privacy: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        You can also reach us through the{" "}
        <a href={REPOSITORY_URL} rel="noreferrer">
          Ray repository
        </a>
        . See also our <Link to="/terms">terms of service</Link>.
      </p>
    </LegalPage>
  );
}
