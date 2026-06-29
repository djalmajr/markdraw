const RELEASES_BASE_URL = "https://github.com/djalmajr/markdraw/releases/latest/download";
const RELEASES_LATEST_URL = "https://github.com/djalmajr/markdraw/releases/latest";

function releaseUrl(asset) {
  return `${RELEASES_BASE_URL}/${asset}`;
}

function detectDownload() {
  const platform =
    navigator.userAgentData?.platform?.toLowerCase() ?? navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes("mac")) {
    const hasSiliconHint =
      platform.includes("arm") ||
      userAgent.includes("arm64") ||
      userAgent.includes("aarch64") ||
      userAgent.includes("apple silicon");
    const hasIntelHint = userAgent.includes("intel") || userAgent.includes("x86_64");
    const isAppleSilicon = hasSiliconHint || !hasIntelHint;
    return {
      href: releaseUrl(isAppleSilicon ? "Markdraw-macos-arm64.dmg" : "Markdraw-macos-x64.dmg"),
      platformKey: isAppleSilicon ? "platformMacArm64" : "platformMacX64",
    };
  }

  if (platform.includes("win")) {
    return { href: releaseUrl("Markdraw-windows-x64.msi"), platformKey: "platformWindows" };
  }

  if (platform.includes("linux")) {
    return { href: releaseUrl("Markdraw-linux-x64.AppImage"), platformKey: "platformLinux" };
  }

  return { href: RELEASES_LATEST_URL, platformKey: "platformFallback" };
}

function labelFor(button, platformKey) {
  const platform = button.dataset[platformKey] ?? button.dataset.platformFallback ?? "";
  return (button.dataset.labelTemplate ?? "Download for {platform}").replace("{platform}", platform);
}

for (const button of document.querySelectorAll("[data-preferred-download]")) {
  const preferred = detectDownload();
  button.href = preferred.href;
  button.textContent = labelFor(button, preferred.platformKey);
}
