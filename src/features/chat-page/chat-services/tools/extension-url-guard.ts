import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Reject any URL that could be used to pivot inside the network or reach
 * the Azure Instance Metadata Service (IMDS). Extensions are user-authored
 * — without this guard any authenticated user can craft an extension whose
 * endpoint targets http://169.254.169.254/metadata/identity/... and
 * exfiltrate the managed-identity bearer token.
 *
 * Rules:
 *   1. Scheme MUST be https. http (and file:, gopher:, etc.) is rejected.
 *   2. Hostname is resolved; every resolved address MUST be a publicly
 *      routable unicast address. Private (RFC1918), link-local (169.254/16
 *      incl. IMDS, fe80::/10), loopback (127/8, ::1), unique-local
 *      (fc00::/7), and 0.0.0.0/8 / :: addresses are rejected.
 *   3. Literal IP hostnames must pass the same checks.
 *   4. Optional ALLOWED_EXTENSION_HOSTS env (comma-separated) is treated
 *      as the only legal host list. Empty/unset = "any public https host".
 *
 * Throws on any violation; returns the original url string on success.
 */
export async function assertExtensionUrlAllowed(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Extension endpoint is not a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Extension endpoint must use https (got ${parsed.protocol})`);
  }

  const allowList = parseAllowList(process.env.ALLOWED_EXTENSION_HOSTS);
  if (allowList && !allowList.includes(parsed.hostname.toLowerCase())) {
    throw new Error(`Extension host ${parsed.hostname} is not in ALLOWED_EXTENSION_HOSTS`);
  }

  // Resolve hostname (or accept literal IPs) and check every address.
  // URL keeps the brackets of an IPv6 literal ("[::1]").
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const literalIpFamily = isIP(host);
  const addresses = literalIpFamily
    ? [{ address: host, family: literalIpFamily }]
    : await lookup(host, { all: true });

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `Extension endpoint resolves to a non-public address (${address}) — refusing to send request`
      );
    }
  }

  return rawUrl;
}

function parseAllowList(raw: string | undefined): string[] | null {
  if (!raw || !raw.trim()) return null;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns true if `address` is in a non-public range we must refuse to
 * contact. Covers the standard SSRF-mitigation set.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  // Unknown family → fail closed.
  return true;
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  // 0.0.0.0/8 — current network
  if (a === 0) return true;
  // 168.63.129.16 — Azure platform (wire server / DNS / health probe)
  if (address === "168.63.129.16") return true;
  // 10/8 — RFC1918
  if (a === 10) return true;
  // 100.64/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127/8 — loopback
  if (a === 127) return true;
  // 169.254/16 — link-local (incl. Azure IMDS 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16/12 — RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0/24, 192.0.2/24 — IETF protocol assignments / TEST-NET-1
  if (a === 192 && b === 0) return true;
  // 192.168/16 — RFC1918
  if (a === 192 && b === 168) return true;
  // 198.18/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100/24 — TEST-NET-2
  if (a === 198 && b === 51) return true;
  // 203.0.113/24 — TEST-NET-3
  if (a === 203 && b === 0) return true;
  // 224/4 — multicast, 240/4 — reserved, 255.255.255.255 — broadcast
  if (a >= 224) return true;
  return false;
}

/** The 8 hextets of an IPv6 address, or null when it does not parse. */
function ipv6Hextets(address: string): number[] | null {
  let text = address;
  // A trailing dotted IPv4 ("::ffff:1.2.3.4") becomes two hextets.
  const v4 = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const p = v4[2].split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    text = `${v4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

const embeddedIPv4 = (h: number[]) =>
  `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;

function isBlockedIPv6(rawAddress: string): boolean {
  // Strip zone id and lowercase.
  const address = rawAddress.split("%")[0].toLowerCase();
  const h = ipv6Hextets(address);
  // Not parseable → fail closed.
  if (!h) return true;
  const zeroUpTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  // ::, ::1 — unspecified, loopback
  if (zeroUpTo(7) && (h[7] === 0 || h[7] === 1)) return true;
  // fe80::/10 — link-local, fec0::/10 — site-local (deprecated)
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return true;
  // fc00::/7 — unique local
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  // ff00::/8 — multicast
  if ((h[0] & 0xff00) === 0xff00) return true;
  // IPv4-mapped ::ffff:a.b.c.d (also written in hex, e.g. ::ffff:7f00:1)
  if (zeroUpTo(5) && h[5] === 0xffff) return isBlockedIPv4(embeddedIPv4(h));
  // IPv4-compatible ::a.b.c.d (deprecated) — check the embedded v4
  if (zeroUpTo(6)) return isBlockedIPv4(embeddedIPv4(h));
  // 64:ff9b::/96 — NAT64 well-known prefix, 64:ff9b:1::/48 — local NAT64
  if (h[0] === 0x64 && h[1] === 0xff9b) return true;
  // 2001:db8::/32 — documentation
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  return false;
}
