import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import {
  PASSKEY_CANCELLED_MESSAGE,
  PASSKEY_FAILED_MESSAGE,
  PASSKEY_SETUP_CANCELLED_MESSAGE,
  PASSKEY_SETUP_FAILED_MESSAGE,
} from "@/lib/login-messages";

// The only importer of @simplewebauthn/browser (owner-passkeys), so tests
// mock this module and a library upgrade touches one file.
export function runPasskeyAuthentication(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON });
}

export function runPasskeyRegistration(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

export function passkeyErrorMessage(err: unknown, flow: "login" | "enroll"): string {
  const name = err instanceof Error ? err.name : "";
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") {
    return flow === "login" ? PASSKEY_CANCELLED_MESSAGE : PASSKEY_SETUP_CANCELLED_MESSAGE;
  }
  return flow === "login" ? PASSKEY_FAILED_MESSAGE : PASSKEY_SETUP_FAILED_MESSAGE;
}
