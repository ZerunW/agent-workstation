/**
 * The hub has no passwords. Password managers (macOS Passwords, 1Password,
 * LastPass, Bitwarden, ...) must never treat a text field here as part of a
 * login flow, so every free-text field spreads these attributes.
 */
export const NO_AUTOFILL = {
  autoComplete: "off",
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-lastpass-ignore": "true",
  "data-bwignore": true,
  "data-form-type": "other",
} as const;
