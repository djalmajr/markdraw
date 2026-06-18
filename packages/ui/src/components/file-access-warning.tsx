import IconShieldAlert from "~icons/lucide/shield-alert";
import { Button } from "./ui/button.tsx";

interface FileAccessWarningProps {
  url: string;
}

/** Detect browser to show correct extensions URL */
function getExtensionsUrl(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Brave")) return "brave://extensions";
  if (ua.includes("Edg/")) return "edge://extensions";
  return "chrome://extensions";
}

export function FileAccessWarning(props: FileAccessWarningProps) {
  function handleRetry() {
    location.reload();
  }

  const extUrl = getExtensionsUrl();

  return (
    <div class="empty-state">
      <div class="empty-icon" style={{ color: "hsl(var(--destructive))" }}>
        <IconShieldAlert width={64} height={64} />
      </div>
      <h2>File access not enabled</h2>
      <p style={{ "max-width": "480px", "text-align": "center" }}>
        To preview local files, you need to enable file access for this
        extension:
      </p>
      <ol
        style={{
          "text-align": "left",
          "max-width": "480px",
          "line-height": "1.8",
          margin: "8px 0 16px",
          "padding-left": "20px",
          color: "hsl(var(--muted-foreground))",
        }}
      >
        <li>
          Open{" "}
          <code
            style={{
              padding: "2px 6px",
              background: "hsl(var(--secondary))",
              "border-radius": "4px",
              "font-size": "0.85em",
            }}
          >
            {extUrl}
          </code>
        </li>
        <li>
          Find <strong>"Markdraw"</strong> and click <strong>Details</strong>
        </li>
        <li>
          Enable <strong>"Allow access to file URLs"</strong>
        </li>
        <li>Reload the original file in a new tab</li>
      </ol>
      <Button size="lg" onClick={handleRetry}>
        Retry
      </Button>
    </div>
  );
}
