import {
  DeviceOperationError,
  DevicePlatform,
  type SeamlessDeviceHostConfig,
} from "@t3tools/contracts";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as DeviceHost from "./DeviceHost.ts";
import { seamlessAgentSource } from "./seamlessAgentSource.ts";

const Inventory = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      platform: DevicePlatform,
      version: Schema.String,
      booted: Schema.Boolean,
      physical: Schema.Boolean,
    }),
  ),
});
const CommandResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.Number,
});
const BootResult = Schema.Struct({ id: Schema.String });
const Contributors = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    inventory: Schema.Struct({
      emulators: Schema.Array(
        Schema.Struct({ id: Schema.String, serial: Schema.optional(Schema.String) }),
      ),
    }),
  }),
);
const encodeLauncherConfig = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      base: Schema.String,
      token: Schema.String,
      deviceId: Schema.String,
      platform: DevicePlatform,
    }),
  ),
);

export const make = Effect.fn("SeamlessDeviceHost.make")(function* (
  config: SeamlessDeviceHostConfig,
  stateDir: string,
) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nodePath = yield* resolveNodeExecutable("Device automation");
  const origin = config.hubUrl.replace(/\/+$/, "");
  const base = `${origin}/api/integrations/t3`;
  const headers = { authorization: `Bearer ${config.accessToken}` };
  const failure = (operation: string, cause: unknown) =>
    new DeviceOperationError({ operation, reason: "request_failed", cause });
  const request = Effect.fn("SeamlessDeviceHost.request")(
    function* (route: string, body?: unknown) {
      const call =
        body === undefined
          ? HttpClientRequest.get(`${base}${route}`)
          : yield* HttpClientRequest.bodyJson(HttpClientRequest.post(`${base}${route}`), body);
      return yield* http
        .execute(HttpClientRequest.setHeaders(call, headers))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout("120 seconds"));
    },
    Effect.mapError((cause) => failure("Seamless request", cause)),
  );
  const contributors = http
    .execute(
      HttpClientRequest.setHeaders(HttpClientRequest.get(`${origin}/api/contributors`), headers),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Contributors)),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => []),
    );
  const list = request("/devices").pipe(
    Effect.timeout("10 seconds"),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Inventory)),
    Effect.flatMap(({ devices }) =>
      contributors.pipe(
        Effect.map((computers) => ({
          devices: devices.map((device) => {
            const decoded = Buffer.from(device.id, "base64url").toString("utf8");
            const ident = decoded.slice(decoded.indexOf(":") + 1);
            const node = /^node\.([^@]+)@(.*)$/.exec(ident);
            const sourceId = device.platform === "desktop" ? ident : node?.[1];
            const computer = computers.find((computer) => computer.id === sourceId);
            const nativeId = node?.[2] ?? ident;
            const emulator = computer?.inventory.emulators.find(
              (emulator) => emulator.id === nativeId,
            );
            return {
              ...device,
              ...(sourceId ? { sourceId } : {}),
              sourceLabel:
                computer?.name ??
                (device.platform === "desktop" ? device.name : new URL(origin).hostname),
              nativeIds: [
                nativeId.replace(/^ios\./, ""),
                ...(emulator?.serial ? [emulator.serial] : []),
              ],
            };
          }),
          detail: undefined,
        })),
      ),
    ),
    Effect.mapError((cause) => failure("list Seamless devices", cause)),
  );
  let ready: DeviceHost.DeviceHostAgentReady | null = null;
  const endpoint = (id: string, action: string) => `/devices/${encodeURIComponent(id)}/${action}`;
  const lifecycle = Effect.fn("SeamlessDeviceHost.lifecycle")(
    function* (id: string, operation: string) {
      const response = yield* request(endpoint(id, "lifecycle"), { operation });
      return yield* HttpClientResponse.schemaBodyJson(BootResult)(response);
    },
    Effect.mapError((cause) => failure("Seamless emulator lifecycle", cause)),
  );
  const run: DeviceHost.DeviceHostReady["run"] = Effect.fn("SeamlessDeviceHost.run")(function* (
    command,
    args,
    options,
  ) {
    const { devices } = yield* list;
    const target = devices.find((device) => args.includes(device.id));
    if (!target)
      return yield* failure("Seamless command", new Error("A device-scoped command is required."));
    const response = yield* request(endpoint(target.id, "command"), {
      argv: [command, ...args],
      timeout: Math.ceil((options?.timeoutMs ?? 30000) / 1000),
    });
    return yield* HttpClientResponse.schemaBodyJson(CommandResult)(response);
  }, Effect.orDie);
  const agentLauncher: NonNullable<DeviceHost.DeviceHostReady["agentLauncher"]> = Effect.fn(
    "SeamlessDeviceHost.agentLauncher",
  )(
    function* (deviceId, session) {
      const device = (yield* list).devices.find((device) => device.id === deviceId);
      if (!device)
        return yield* failure("prepare Seamless control", new Error("Device is unavailable."));
      const dir = path.join(stateDir, "device", "targets", session);
      yield* fs.makeDirectory(dir, { recursive: true });
      const sourceConfig = yield* encodeLauncherConfig({
        base,
        token: config.accessToken,
        deviceId,
        platform: device.platform,
      });
      const source = `const config = ${sourceConfig};\n${seamlessAgentSource}`;
      const entry = path.join(dir, "agent-device-launcher.mjs");
      yield* fs.writeFileString(entry, source, { mode: 0o600 });
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const windows = (yield* HostProcess.Platform) === "win32";
      const launcher = path.join(dir, windows ? "seamless-device.cmd" : "seamless-device");
      yield* fs.writeFileString(
        launcher,
        windows
          ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${nodePath}" "${entry}" %*\r\n`
          : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(nodePath)} ${quote(entry)} "$@"\n`,
        { mode: 0o700 },
      );
      return launcher;
    },
    Effect.mapError((cause) => failure("prepare Seamless control", cause)),
  );
  const current: DeviceHost.DeviceHostAgentReady = {
    nodePath,
    hub: { origin },
    agentDevice: null,
    agentLauncher,
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run,
    devices: {
      list,
      boot: (device) => lifecycle(device.id, "start").pipe(Effect.map((result) => result.id)),
      attach: () => Effect.void,
      shutdown: (device) => lifecycle(device.id, "stop").pipe(Effect.asVoid),
      screenshot: (device) =>
        request(endpoint(device.id, "screenshot"), {}).pipe(
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.map((bytes) => new Uint8Array(bytes)),
          Effect.mapError((cause) => failure("Seamless screenshot", cause)),
        ),
    },
    upstream: (hubPath, search) =>
      Effect.sync(() => {
        const id = search.get("device");
        if (!id) return null;
        const action =
          hubPath === "/seamless/stream"
            ? "stream"
            : /\/api\/screenshot$/.test(hubPath)
              ? "screenshot"
              : null;
        return action ? { url: `${base}${endpoint(id, action)}`, headers, protocols: [] } : null;
      }),
  };
  const ensure = list.pipe(
    Effect.tap(
      Effect.sync(() => {
        ready = current;
      }),
    ),
    Effect.as(current),
    Effect.mapError(
      (cause) =>
        new DeviceHost.DeviceHostError({
          hostId: config.id,
          step: "connecting to Seamless",
          cause,
        }),
    ),
  );
  const summary: DeviceHost.DeviceHost["Service"]["summary"] = Effect.succeed({
    id: config.id,
    label: config.label,
    kind: "seamless",
    hubInstalled: true,
    agentDeviceInstalled: true,
    platforms: (["ios", "android", "desktop"] as const).map((platform) => ({
      platform,
      available: true,
    })),
  });
  return DeviceHost.DeviceHost.of({
    id: config.id,
    label: config.label,
    summary,
    platformAvailability: Effect.fn("SeamlessDeviceHost.platformAvailability")((platform) =>
      Effect.succeed({ platform, available: true }),
    ),
    ensureReady: Effect.fn("SeamlessDeviceHost.ensureReady")(() =>
      ready ? Effect.succeed(ready) : ensure,
    ),
    ensureAgentReady: Effect.fn("SeamlessDeviceHost.ensureAgentReady")(() =>
      ready ? Effect.succeed(ready) : ensure,
    ),
    current: Effect.sync(() => ready),
    stopAgent: Effect.void,
    stop: Effect.sync(() => {
      ready = null;
    }),
  });
});
