import { createSocket, type Socket } from "node:dgram";
import {
  DISCOVERY_PROTOCOL_VERSION,
  DISCOVERY_RESPONSE_TYPE,
  parseDiscoveryRequest
} from "../shared/lan-discovery.js";

interface DiscoveryResponderOptions {
  roomCode: string;
  port: number;
  discoveryPort: number;
}

export function startDiscoveryResponder(options: DiscoveryResponderOptions): Socket {
  const socket = createSocket("udp4");

  socket.on("message", (message, remote) => {
    const request = parseDiscoveryRequest(message.toString());
    if (!request) {
      return;
    }

    if (request.roomCode && request.roomCode.toUpperCase() !== options.roomCode.toUpperCase()) {
      return;
    }

    const response = Buffer.from(JSON.stringify({
      type: DISCOVERY_RESPONSE_TYPE,
      protocol: DISCOVERY_PROTOCOL_VERSION,
      roomCode: options.roomCode,
      port: options.port
    }));
    socket.send(response, remote.port, remote.address);
  });

  socket.on("error", (error) => {
    console.warn(`BandCue discovery responder failed: ${error.message}`);
  });

  socket.bind(options.discoveryPort, "0.0.0.0", () => {
    socket.setBroadcast(true);
    console.log(`Discovery responder: udp://0.0.0.0:${options.discoveryPort}`);
  });

  return socket;
}
