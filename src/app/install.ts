export type InstallDecision = "prompt" | "ios-hint" | "none";

// Contextual install CTA policy (spec): only after a first successful
// analysis, never standalone, never after dismissal, never as an
// interrupting prompt on load.
export function installDecision(input: {
  hasDeferredPrompt: boolean;
  isIos: boolean;
  isStandalone: boolean;
  dismissed: boolean;
  successes: number;
}): InstallDecision {
  const { hasDeferredPrompt, isIos, isStandalone, dismissed, successes } =
    input;
  if (successes < 1 || isStandalone || dismissed) return "none";
  if (hasDeferredPrompt) return "prompt";
  if (isIos) return "ios-hint";
  return "none";
}

export function isIosSafari(userAgent: string): boolean {
  return /iPhone|iPad|iPod/.test(userAgent);
}
