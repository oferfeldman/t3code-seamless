import { useState } from "react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SeamlessDeviceHostConfig,
  type DeviceServiceState,
} from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";

export function SeamlessDeviceSources(props: {
  environments: ReadonlyArray<{
    environmentId: EnvironmentId;
    label: string;
    settings?: { seamlessDeviceHosts: ReadonlyArray<SeamlessDeviceHostConfig> } | undefined;
    state?: Pick<DeviceServiceState, "supportsSeamlessHosts" | "hostStatuses"> | undefined;
  }>;
  disabled?: boolean | undefined;
}) {
  return (
    <div className="space-y-3 border-t border-border/60 px-4 py-3">
      <p className="text-sm font-medium">Seamless</p>
      <p className="text-xs text-muted-foreground">
        Connect your Seamless hub once. Shared computers, phones, and emulators appear automatically
        in Devices.
      </p>
      {props.environments
        .filter((environment) => environment.state?.supportsSeamlessHosts)
        .map((environment) => (
          <div
            key={`${environment.environmentId}:${environment.settings?.seamlessDeviceHosts[0]?.hubUrl ?? ""}`}
          >
            <SeamlessConnection environment={environment} disabled={props.disabled} />
            {environment.state?.hostStatuses[environment.settings?.seamlessDeviceHosts[0]?.id ?? ""]
              ?.status === "failed" ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {environment.state.hostStatuses[
                  environment.settings?.seamlessDeviceHosts[0]?.id ?? ""
                ]?.detail ?? "Could not connect to Seamless."}
              </p>
            ) : null}
          </div>
        ))}
    </div>
  );
}

function SeamlessConnection(props: {
  environment: {
    environmentId: EnvironmentId;
    label: string;
    settings?: { seamlessDeviceHosts: ReadonlyArray<SeamlessDeviceHostConfig> } | undefined;
  };
  disabled?: boolean | undefined;
}) {
  const { environment } = props;
  const saved = environment.settings?.seamlessDeviceHosts[0];
  const disabled =
    props.disabled || !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const [url, setUrl] = useState(saved?.hubUrl ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const save = async (remove: boolean) => {
    if (disabled) return;
    let hubUrl: string;
    try {
      const parsed = new URL(remove ? (saved?.hubUrl ?? url) : url);
      if (
        !/^https?:$/.test(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error();
      hubUrl = parsed.href.replace(/\/+$/, "");
    } catch {
      setError("Enter an HTTP or HTTPS Seamless hub address.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: environment.environmentId,
      input: {
        patch: {
          seamlessDeviceHosts: remove
            ? (environment.settings?.seamlessDeviceHosts.slice(1) ?? [])
            : [
                {
                  kind: "seamless",
                  id: saved?.id ?? "seamless",
                  label: "Seamless",
                  hubUrl,
                  accessToken: token || saved?.accessToken || "",
                },
                ...(environment.settings?.seamlessDeviceHosts.slice(1) ?? []),
              ],
          ...(!remove ? { enableDeviceSupport: true, deviceOnboardingCompleted: true } : {}),
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError("Could not save the Seamless connection.");
    else setToken("");
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save(false);
      }}
    >
      <p className="text-xs text-muted-foreground">{environment.label}</p>
      <label className="block space-y-1 text-xs">
        Hub address
        <Input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://seamless.example.com"
          disabled={disabled || busy}
        />
      </label>
      <label className="block space-y-1 text-xs">
        Seamless API token
        <SecretInput
          value={token}
          configured={!!saved?.accessToken}
          onChange={(event) => setToken(event.target.value)}
          disabled={disabled || busy}
        />
      </label>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={
            disabled || busy || !url || (!token && (url !== saved?.hubUrl || !saved?.accessToken))
          }
        >
          {saved ? "Save connection" : "Connect Seamless"}
        </Button>
        {saved ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => void save(true)}
          >
            Disconnect
          </Button>
        ) : null}
      </div>
    </form>
  );
}
