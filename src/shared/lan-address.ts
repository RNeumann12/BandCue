// Picks the LAN IPv4 address other machines can actually route to. Node's
// `networkInterfaces()` lists virtual switches (WSL/Hyper-V, VMware, VirtualBox),
// overlay VPNs (Tailscale), Bluetooth PAN, and 169.254 APIPA addresses alongside
// the real adapter, and the first entry is often one of those — so a naive
// "first non-internal IPv4" pick hands clients an unreachable host in the room
// URL/QR. This module isolates the selection so it can be unit-tested without a
// live network. Kept dependency-free of `node:os` types so tests can pass plain
// objects.

export interface NetworkAddressInfo {
  family: string | number;
  internal: boolean;
  address: string;
}

// Virtual/overlay adapters whose IPs no peer on the physical LAN can route to.
export const VIRTUAL_INTERFACE_PATTERN =
  /(vethernet|hyper-?v|wsl|vmware|vmnet|virtualbox|vbox|tailscale|bluetooth|loopback|docker|zerotier|tap-?windows)/i;

export function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.");
}

export function isPrivateLan(address: string): boolean {
  if (address.startsWith("192.168.") || address.startsWith("10.")) {
    return true;
  }
  const match = /^172\.(\d+)\./.exec(address);
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : false;
}

function isIpv4(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

// Returns routable LAN IPv4 candidates best-first: real private-LAN addresses on
// physical adapters first, then anything else usable (public IPs, virtual
// adapters) as a last resort. Loopback and link-local APIPA are dropped.
export function selectLanCandidates(
  interfaces: Record<string, NetworkAddressInfo[] | undefined>
): string[] {
  const real: string[] = [];
  const fallback: string[] = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (!isIpv4(address.family) || address.internal || isLinkLocal(address.address)) {
        continue;
      }
      if (VIRTUAL_INTERFACE_PATTERN.test(name)) {
        fallback.push(address.address);
        continue;
      }
      (isPrivateLan(address.address) ? real : fallback).push(address.address);
    }
  }

  return [...real, ...fallback];
}

export function selectLanAddress(
  interfaces: Record<string, NetworkAddressInfo[] | undefined>
): string {
  return selectLanCandidates(interfaces)[0] ?? "127.0.0.1";
}
