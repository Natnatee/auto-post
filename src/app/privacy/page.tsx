export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 800, margin: "40px auto", padding: "0 20px", fontFamily: "sans-serif", lineHeight: 1.6 }}>
      <h1>Privacy Policy</h1>
      <p>Last updated: November 8, 2026</p>
      <section>
        <h2>1. Information We Collect</h2>
        <p>
          Elephant-Maker collects user authorization tokens, profile identifiers, and content media provided directly by
          the user for publishing purposes across supported platforms (Facebook, YouTube, TikTok).
        </p>
      </section>
      <section>
        <h2>2. How Information is Used</h2>
        <p>
          Collected credentials and tokens are strictly used to authenticate API requests and upload content at the
          user's explicit direction. We do not sell or share user data with third parties.
        </p>
      </section>
      <section>
        <h2>3. Data Retention and Security</h2>
        <p>
          All tokens and credentials are encrypted and stored in private backend services. Users may revoke access at any
          time via their respective platform security settings.
        </p>
      </section>
      <section>
        <h2>4. Contact</h2>
        <p>For privacy inquiries, contact: drawnewtrio@gmail.com</p>
      </section>
    </main>
  );
}

