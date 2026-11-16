import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as SeamlessDeviceHost from "./SeamlessDeviceHost.ts";

it.effect(
  "discovers a desktop and binds its stream, screenshots, and agent control to Seamless",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const device = {
        id: Buffer.from("computer:test").toString("base64url"),
        name: "Desktop",
        platform: "desktop",
        version: "Windows",
        booted: true,
        physical: true,
      } as const;
      const requests: string[] = [];
      const png = new Uint8Array([137, 80, 78, 71]);
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.headers.authorization).toBe("Bearer fixture-token");
          requests.push(`${request.method} ${request.url}`);
          return HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/screenshot")
              ? new Response(png)
              : request.url.endsWith("/api/contributors")
                ? Response.json([{ id: "test", name: "My desktop", inventory: { emulators: [] } }])
                : Response.json({ devices: [device] }),
          );
        }),
      );
      const host = yield* SeamlessDeviceHost.make(
        {
          kind: "seamless",
          id: "seamless",
          label: "Seamless",
          hubUrl: "https://hub.test/",
          accessToken: "fixture-token",
        },
        stateDir,
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect((yield* ready.devices.list).devices).toEqual([
        { ...device, sourceId: "test", sourceLabel: "My desktop", nativeIds: ["test"] },
      ]);
      expect(yield* ready.devices.screenshot(device)).toEqual(png);
      expect(
        yield* ready.upstream!("/seamless/stream", new URLSearchParams({ device: device.id })),
      ).toEqual({
        url: `https://hub.test/api/integrations/t3/devices/${device.id}/stream`,
        headers: { authorization: "Bearer fixture-token" },
        protocols: [],
      });
      expect(yield* ready.upstream!("/seamless/stream", new URLSearchParams())).toBeNull();
      const launcher = yield* ready.agentLauncher!(device.id, "test-session");
      const source = yield* fs.readFileString(
        path.join(path.dirname(launcher), "agent-device-launcher.mjs"),
      );
      expect(source).toContain(`"deviceId":"${device.id}"`);
      expect(source).toContain('"platform":"desktop"');
      expect(source).toContain('"token":"fixture-token"');
      expect(requests).toContain(
        `POST https://hub.test/api/integrations/t3/devices/${device.id}/screenshot`,
      );
      yield* host.stop;
      expect(yield* host.current).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
