import type { VerificationResult } from "./verifier.js";

export type VerifierInfrastructureFailure = {
  stage: "setup" | "sandbox" | "launcher" | "cleanup";
  message: string;
};

// Only the verifier's own runtime boundary may create this classification.
// Application stderr (EPERM included) is never parsed to infer infrastructure.
export function infrastructureFailure(stage: VerifierInfrastructureFailure["stage"], message: string): VerificationResult {
  const failure = { stage, message: message.slice(0, 500) };
  return { success: false, failureKind: "infrastructure", infrastructureFailure: failure, packageManager: null,
    checks: [{ name: "verifier", command: null, success: false, skipped: false, exitCode: null,
      stdout: "", stderr: verifierFailureMessage({ infrastructureFailure: failure }), durationMs: 0, timedOut: false }] };
}

export function verifierFailureMessage(result: Pick<VerificationResult, "infrastructureFailure">): string {
  return result.infrastructureFailure
    ? `Verifier infrastructure failure: ${result.infrastructureFailure.message}`
    : "Deterministic verification failed.";
}
