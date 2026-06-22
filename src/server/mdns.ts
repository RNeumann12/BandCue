import makeMdns from "multicast-dns";
import { mdnsRoomHosts } from "../shared/room-locator.js";

interface MdnsResponderOptions {
  roomCode: string;
  port: number;
  address: string;
}

// Advertises the room over multicast DNS so any LAN client can resolve
// "bandcue[-<roomcode>].local" to this server's IP through the OS resolver and
// connect with a plain HTTP request -- no LAN brute-force scan. This is the
// browser-friendly counterpart to the UDP discovery responder; clients without
// an OS mDNS resolver (or on multicast-blocked networks) simply fall back to
// the scan. Mirrors the resilient, never-throw style of startDiscoveryResponder.
export function startMdnsResponder(options: MdnsResponderOptions): ReturnType<typeof makeMdns> {
  const mdns = makeMdns();
  const names = new Set(mdnsRoomHosts(options.roomCode).map((host) => host.toLowerCase()));

  mdns.on("query", (query) => {
    const answers = query.questions
      .filter((question) => question.type === "A" && names.has(question.name.toLowerCase()))
      .map((question) => ({
        name: question.name,
        type: "A" as const,
        ttl: 120,
        data: options.address
      }));
    if (answers.length) {
      mdns.respond({ answers });
    }
  });

  mdns.on("error", (error: Error) => {
    console.warn(`BandCue mDNS responder failed: ${error.message}`);
  });

  console.log(`mDNS responder:     ${[...mdnsRoomHosts(options.roomCode)].join(", ")} -> ${options.address}`);
  return mdns;
}
