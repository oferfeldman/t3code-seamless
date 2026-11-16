// @effect-diagnostics globalTimers:off preferSchemaOverJson:off - This browser/WebView binary transport has no Effect runtime.
import { createCanvasFrameSink, type DeviceFrameSink } from "./frame.ts";
import { withDeviceHubQuery } from "./hubAccess.ts";
import {
  avcCodecString,
  scanAccessUnit,
  type DeviceStreamTarget,
  type DeviceStreamClient,
  type DeviceStreamEvents,
} from "./stream.ts";

const utf8 = new TextEncoder();
const text = new TextDecoder();

function codecHeaders(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const starts: number[] = [];
  for (let i = 0; i < data.length - 3; i++) {
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))
    ) {
      starts.push(i);
      i += data[i + 2] === 1 ? 2 : 3;
    }
  }
  const headers: number[] = [];
  for (let n = 0; n < starts.length; n++) {
    const start = starts[n]!;
    const type = data[start + (data[start + 2] === 1 ? 3 : 4)]! & 31;
    if (type === 7 || type === 8)
      for (let i = start; i < (starts[n + 1] ?? data.length); i++) headers.push(data[i]!);
  }
  return new Uint8Array(headers);
}

export function createSeamlessStreamClient(
  target: DeviceStreamTarget,
  output: HTMLCanvasElement | DeviceFrameSink,
  events: DeviceStreamEvents,
): DeviceStreamClient {
  const sink = "present" in output ? output : createCanvasFrameSink(output);
  let socket: WebSocket | null = null;
  let decoder: VideoDecoder | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let buffer = new Uint8Array(0);
  let welcomed = false;
  let configuring = false;
  let configuration = new Uint8Array(0);
  let width = 0,
    height = 0;
  let generation = 0;
  let mouseButtons = 0;
  const heldKeys = new Set<number>();
  let awaitingKey = true;
  const desktop = target.platform === "desktop";

  const packet = (kind: number, payload = new Uint8Array(0)) => {
    if (socket?.readyState !== WebSocket.OPEN || !welcomed) return;
    if (payload.length > 65535) return;
    const bytes = new Uint8Array(3 + payload.length);
    bytes[0] = kind;
    new DataView(bytes.buffer).setUint16(1, payload.length);
    bytes.set(payload, 3);
    socket.send(bytes);
  };
  const resetDecoder = () => {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    configuring = false;
    awaitingKey = true;
  };
  const screen = () =>
    events.onScreen({ width, height, orientation: width > height ? "landscape_left" : "portrait" });
  const displays = (value: {
    displays?: ReadonlyArray<{ id: number; name: string }>;
    selectedDisplay?: number;
    supportsAll?: boolean;
  }) => {
    const items =
      value.displays?.filter(
        (item) => Number.isInteger(item.id) && typeof item.name === "string",
      ) ?? [];
    events.onDisplays?.(items, value.selectedDisplay ?? 0, value.supportsAll === true);
  };
  const fail = (message: string) => events.onStatus("error", message);
  const requestKey = () => packet(20);
  const video = (payload: Uint8Array) => {
    if (payload.length < 9 || !("VideoDecoder" in globalThis)) return;
    const key = payload[0] === 1;
    const timestamp = Number(
      new DataView(payload.buffer, payload.byteOffset + 1, 8).getBigUint64(0),
    );
    const raw = payload.subarray(9);
    const scanned = scanAccessUnit(raw);
    if (scanned.sps && (!decoder || decoder.state !== "configured")) {
      configuration = codecHeaders(raw);
      if (configuring) return;
      configuring = true;
      const ownGeneration = generation;
      const config: VideoDecoderConfig = {
        codec: avcCodecString(scanned.sps),
        optimizeForLatency: true,
      };
      void VideoDecoder.isConfigSupported(config)
        .then((supported) => {
          if (stopped || ownGeneration !== generation) return;
          configuring = false;
          if (!supported.supported) return fail(`This browser cannot decode ${config.codec}.`);
          const next = new VideoDecoder({
            output(frame) {
              try {
                if (stopped || ownGeneration !== generation) return;
                if (frame.displayWidth !== width || frame.displayHeight !== height) {
                  width = frame.displayWidth;
                  height = frame.displayHeight;
                  screen();
                }
                if (sink.present(frame, width, height)) events.onStatus("streaming");
              } finally {
                frame.close();
              }
            },
            error: () => {
              resetDecoder();
              requestKey();
            },
          });
          next.configure(config);
          decoder = next;
          awaitingKey = true;
          requestKey();
        })
        .catch(() => {
          configuring = false;
          fail("Could not initialize the device video decoder.");
        });
      return;
    }
    if (!decoder || decoder.state !== "configured" || (awaitingKey && !key)) return;
    if (decoder.decodeQueueSize > 8) {
      awaitingKey = true;
      requestKey();
      return;
    }
    const data =
      key && configuration.length ? new Uint8Array(configuration.length + raw.length) : raw;
    if (data !== raw) {
      data.set(configuration);
      data.set(raw, configuration.length);
    }
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }));
      awaitingKey = false;
    } catch {
      resetDecoder();
      requestKey();
    }
  };
  const consume = (bytes: Uint8Array) => {
    if (buffer.length + bytes.length > 17 * 1024 * 1024)
      throw new Error("Invalid Seamless video packet.");
    const joined = new Uint8Array(buffer.length + bytes.length);
    joined.set(buffer);
    joined.set(bytes, buffer.length);
    buffer = joined;
    while (buffer.length) {
      if (!welcomed) {
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.length > 8192) throw new Error("Invalid Seamless handshake.");
          return;
        }
        const hello = JSON.parse(text.decode(buffer.subarray(0, newline))) as {
          type: string;
          width?: number;
          height?: number;
          message?: string;
          displays?: ReadonlyArray<{ id: number; name: string }>;
          selectedDisplay?: number;
          supportsAll?: boolean;
        };
        buffer = buffer.slice(newline + 1);
        if (hello.type === "pending") continue;
        if (hello.type !== "welcome")
          throw new Error(hello.message ?? "The device did not approve this connection.");
        width = hello.width ?? 0;
        height = hello.height ?? 0;
        if (width <= 0 || height <= 0)
          throw new Error("The device returned an invalid screen size.");
        welcomed = true;
        screen();
        displays(hello);
        events.onInputConnected(true);
        continue;
      }
      if (buffer.length < 5) return;
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
      if (length > 16 * 1024 * 1024) throw new Error("Invalid Seamless video packet.");
      if (buffer.length < 5 + length) return;
      const kind = buffer[0];
      const payload = buffer.slice(5, 5 + length);
      buffer = buffer.slice(5 + length);
      if (kind === 1) video(payload);
      else if (kind === 3 && length === 8) {
        const view = new DataView(payload.buffer);
        const nextWidth = view.getUint32(0),
          nextHeight = view.getUint32(4);
        if (nextWidth <= 0 || nextHeight <= 0) throw new Error("Invalid Seamless screen size.");
        if (nextWidth !== width || nextHeight !== height) {
          width = nextWidth;
          height = nextHeight;
          generation++;
          resetDecoder();
          configuration = new Uint8Array(0);
          screen();
        }
      } else if (kind === 5) displays(JSON.parse(text.decode(payload)));
    }
  };
  const connect = () => {
    if (stopped) return;
    if (!("VideoDecoder" in globalThis)) {
      fail("Live device video requires a browser with WebCodecs over HTTPS or localhost.");
      return;
    }
    buffer = new Uint8Array(0);
    welcomed = false;
    configuration = new Uint8Array(0);
    const own = new WebSocket(
      withDeviceHubQuery(
        `${target.access.wsBase}/seamless/stream?device=${encodeURIComponent(target.deviceId)}`,
        target.access,
      ),
    );
    own.binaryType = "arraybuffer";
    socket = own;
    events.onStatus("connecting");
    own.onopen = () =>
      own.send(
        utf8.encode(
          JSON.stringify({
            type: "hello",
            id: "t3-viewer",
            name: "T3 Code",
            width: 1920,
            height: 1080,
          }) + "\n",
        ),
      );
    own.onmessage = (event) => {
      if (socket !== own || stopped || !(event.data instanceof ArrayBuffer)) return;
      try {
        consume(new Uint8Array(event.data));
      } catch (error) {
        fail(error instanceof Error ? error.message : "Invalid device stream.");
        own.close();
      }
    };
    own.onclose = (event) => {
      if (socket !== own) return;
      generation++;
      resetDecoder();
      socket = null;
      welcomed = false;
      mouseButtons = 0;
      heldKeys.clear();
      events.onInputConnected(false);
      if (stopped) return;
      if (event.code === 1008 || event.code === 4401) {
        events.onUnauthorized();
        return;
      }
      timer = setTimeout(connect, 1000);
    };
    own.onerror = () => own.close();
  };
  const point = (x: number, y: number) => {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, Math.round(Math.max(0, Math.min(1, x)) * 65535));
    view.setUint16(2, Math.round(Math.max(0, Math.min(1, y)) * 65535));
    return payload;
  };
  const mouse = (phase: "begin" | "move" | "end", x: number, y: number, button = 0) => {
    packet(10, point(x, y));
    if (phase !== "move") {
      packet(11, new Uint8Array([button, phase === "begin" ? 1 : 0]));
      const mask = 1 << button;
      mouseButtons = phase === "begin" ? mouseButtons | mask : mouseButtons & ~mask;
    }
  };
  const releaseInput = () => {
    for (let button = 0; button < 3; button++)
      if (mouseButtons & (1 << button)) packet(11, new Uint8Array([button, 0]));
    mouseButtons = 0;
    for (const code of heldKeys) {
      const payload = new Uint8Array(3);
      new DataView(payload.buffer).setUint16(0, code);
      packet(13, payload);
    }
    heldKeys.clear();
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      globalThis.addEventListener?.("blur", releaseInput);
      connect();
    },
    stop() {
      stopped = true;
      globalThis.removeEventListener?.("blur", releaseInput);
      releaseInput();
      generation++;
      clearTimeout(timer);
      resetDecoder();
      socket?.close();
      socket = null;
    },
    setMjpegImage() {},
    controlDuo() {},
    setDuoPanels() {},
    setOrientation() {},
    sendRawTouch() {},
    sendTouch(phase, x, y) {
      if (desktop) return mouse(phase, x, y);
      const payload = new Uint8Array(9);
      payload[0] = phase === "begin" ? 0 : phase === "end" ? 1 : 2;
      payload.set(point(x, y), 5);
      packet(15, payload);
    },
    sendKey(event, phase) {
      const code =
        event.keyCode === 16
          ? event.location === 2
            ? 161
            : 160
          : event.keyCode === 17
            ? event.location === 2
              ? 163
              : 162
            : event.keyCode === 18
              ? event.location === 2
                ? 165
                : 164
              : event.keyCode;
      const payload = new Uint8Array(3);
      const view = new DataView(payload.buffer);
      view.setUint16(0, code);
      payload[2] = phase === "down" ? 1 : 0;
      packet(13, payload);
      if (phase === "down") heldKeys.add(code);
      else heldKeys.delete(code);
    },
    sendText(value) {
      const bytes = utf8.encode(value);
      const payload = new Uint8Array(bytes.length + 1);
      payload[0] = 1;
      payload.set(bytes, 1);
      packet(17, payload);
    },
    pressButton(button) {
      const code = { home: 3, back: 4, recents: 187, power: 26, appSwitcher: 187 }[button];
      const bytes = new Uint8Array(2);
      new DataView(bytes.buffer).setUint16(0, code);
      packet(16, bytes);
    },
    rotate() {},
    sendMouse: mouse,
    sendScroll(dx, dy) {
      const bytes = new Uint8Array(4);
      const view = new DataView(bytes.buffer);
      view.setInt16(0, Math.max(-32768, Math.min(32767, Math.round(-dy))));
      view.setInt16(2, Math.max(-32768, Math.min(32767, Math.round(-dx))));
      packet(12, bytes);
    },
    releaseInput,
    selectDisplay(id) {
      releaseInput();
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setInt32(0, id);
      packet(22, bytes);
    },
  };
}
