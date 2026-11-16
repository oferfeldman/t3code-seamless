import { ThreadId, type DeviceServiceState, type DeviceSummary } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { uniqueDevices } from "./uniqueDevices.ts";

const device = (hostId: string, id: string, sourceId: string): DeviceSummary => ({
  hostId,
  id,
  sourceId,
  platform: "android",
  name: "Pixel",
  version: "Android",
  booted: true,
  physical: false,
});
function state(devices: DeviceSummary[]): DeviceServiceState {
  return {
    hosts: [
      {
        id: "hub",
        kind: "seamless",
        label: "Seamless",
        platforms: [],
        hubInstalled: true,
        agentDeviceInstalled: true,
      },
    ],
    hostStatus: "ready",
    hostStatuses: {},
    devices,
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 0,
  };
}

it("lists one device across local, SSH and Seamless routes and uses Seamless frames", () => {
  const native = device("ssh", "emulator-5554", "mac");
  const remote = {
    ...device("hub", "encoded", "mac"),
    nativeIds: ["Pixel", "emulator-5554"],
    sourceLabel: "Mac mini",
  };
  expect(uniqueDevices(state([native, remote])).devices).toEqual([
    { ...native, sourceLabel: "Mac mini", seamlessTarget: { hostId: "hub", deviceId: "encoded" } },
  ]);
});

it("does not merge the same emulator serial on different computers or equal model names", () => {
  const first = device("local", "emulator-5554", "first");
  const second = { ...device("hub", "remote", "second"), nativeIds: ["emulator-5554"] };
  expect(uniqueDevices(state([first, second])).devices).toHaveLength(2);
  expect(uniqueDevices(state([first, { ...first, id: "emulator-5556" }])).devices).toHaveLength(2);
});

it("uses an iOS UDID across routes and retains an existing Seamless session", () => {
  const native = { ...device("ssh", "unique-udid", "mac"), platform: "ios" as const };
  const remote = { ...native, hostId: "hub", id: "encoded", nativeIds: [native.id] };
  const input = state([native, remote]);
  expect(uniqueDevices(input).devices).toHaveLength(1);
  expect(
    uniqueDevices({
      ...input,
      sessions: [
        {
          threadId: ThreadId.make("thread"),
          hostId: "hub",
          deviceId: "encoded",
          platform: "ios",
          openedAt: "2026-11-16T00:00:00.000Z",
        },
      ],
    }).devices[0]?.hostId,
  ).toBe("hub");
});
