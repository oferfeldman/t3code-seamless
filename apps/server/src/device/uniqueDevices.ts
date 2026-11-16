import type { DeviceServiceState, DeviceSummary } from "@t3tools/contracts";

const sameDevice = (a: DeviceSummary, b: DeviceSummary) => {
  if (a.hostId === b.hostId && a.id === b.id) return true;
  if (a.platform !== b.platform || a.physical !== b.physical) return false;
  const aliases = a.nativeIds ?? [a.id];
  const matches = (b.nativeIds ?? [b.id]).some((id) => aliases.includes(id));
  if (!matches) return false;
  if (a.platform === "ios" || (a.platform === "android" && a.physical)) return true;
  return a.sourceId !== undefined && a.sourceId === b.sourceId;
};

export function uniqueDevices(state: DeviceServiceState): DeviceServiceState {
  const seamless = state.devices.filter((device) =>
    state.hosts.some((host) => host.id === device.hostId && host.kind === "seamless"),
  );
  const active = (device: DeviceSummary) =>
    state.sessions.some(
      (session) => session.hostId === device.hostId && session.deviceId === device.id,
    );
  const preferred: DeviceSummary[] = [];
  for (const device of state.devices.toSorted(
    (a, b) =>
      Number(active(b)) - Number(active(a)) ||
      Number(seamless.includes(a)) - Number(seamless.includes(b)),
  )) {
    if (preferred.some((existing) => sameDevice(existing, device))) continue;
    const target = seamless.find((target) => target === device || sameDevice(target, device));
    preferred.push(
      target && target !== device
        ? {
            ...device,
            sourceLabel: target.sourceLabel,
            seamlessTarget: { hostId: target.hostId, deviceId: target.id },
          }
        : device,
    );
  }
  return {
    ...state,
    devices: preferred,
  };
}
