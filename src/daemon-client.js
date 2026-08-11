// Client side of the daemon socket. The SDK's stdio client transport spawns
// the process it talks to, so there is nothing to bind to an already-open
// socket — but its framing primitives are exported, so this is the SDK's own
// wire format, not a hand-rolled one.
import { connect } from 'net';
import { Client, ReadBuffer, serializeMessage } from '@modelcontextprotocol/client';

const CLIENT_INFO = { name: 'kb-daemon-client', version: '1.0.0' };

class SocketClientTransport {
  constructor(socket) {
    this._socket = socket;
    this._readBuffer = new ReadBuffer();
  }

  async start() {
    this._socket.on('data', (chunk) => {
      this._readBuffer.append(chunk);
      this._flush();
    });
    this._socket.on('error', (err) => this.onerror?.(err));
    this._socket.on('close', () => this.onclose?.());
  }

  _flush() {
    for (;;) {
      let message;
      try {
        message = this._readBuffer.readMessage();
      } catch (err) {
        this.onerror?.(err);
        return;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  send(message) {
    return new Promise((resolve, reject) => {
      this._socket.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()));
    });
  }

  async close() {
    this._socket.destroy();
  }
}

/** Connects an MCP client to a daemon socket. Caller owns client.close(). */
export async function connectDaemonClient(socketPath, clientOptions = {}) {
  const socket = await new Promise((resolve, reject) => {
    const pending = connect(socketPath);
    const onError = (err) => reject(err);
    pending.once('error', onError);
    pending.once('connect', () => {
      pending.off('error', onError);
      resolve(pending);
    });
  });

  const client = new Client(CLIENT_INFO, clientOptions);
  try {
    await client.connect(new SocketClientTransport(socket));
  } catch (err) {
    socket.destroy();
    throw err;
  }
  return client;
}
