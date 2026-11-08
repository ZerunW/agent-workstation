import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "../src/util/redact.js";

// Built at run time so this file holds no secret-shaped string itself (scripts/check-secrets.sh scans it).
const rep = (s: string, n: number) => s.repeat(n);
const KEYS = {
  anthropic: `sk-ant-api03-${rep("Zq9", 12)}`,
  proxy: `hsk-${rep("Ab9_", 10)}xyz`,
  github: `ghp_${rep("a1B2", 9)}`,
  tailscale: `tskey-auth-${rep("k7Q", 8)}`,
  aws: `AKIA${rep("Q7", 8)}`,
  google: `AIza${rep("Sy3", 11)}Ab`,
  slack: `xoxb-${rep("12", 6)}-${rep("ab", 6)}`,
  stripe: `sk_live_${rep("9z", 13)}`,
};

describe("redactSecrets", () => {
  for (const [name, key] of Object.entries(KEYS)) {
    it(`masks a ${name} credential and keeps the text around it`, () => {
      const out = redactSecrets(`Error: request failed with ${key} at /srv/x\n`);
      expect(out).not.toContain(key);
      expect(out).toBe(`Error: request failed with ${REDACTED} at /srv/x\n`);
    });
  }

  it("masks a private key block", () => {
    const header = "-----BEGIN RSA PRIV" + "ATE KEY-----";
    const footer = "-----END RSA PRIV" + "ATE KEY-----";
    const out = redactSecrets(`before\n${header}\nMIIEabc\n${footer}\nafter`);
    expect(out).toBe(`before\n${REDACTED}\nafter`);
  });

  it("masks authorization header values but keeps the header name", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecrets('{"x-api-key":"secret123"}')).toBe(`{"x-api-key":"${REDACTED}"}`);
  });

  it("leaves ordinary output alone", () => {
    const text = "TypeError: cannot read properties of undefined (reading 'x')\n    at run (/opt/app/cli.js:12:5)";
    expect(redactSecrets(text)).toBe(text);
  });
});
