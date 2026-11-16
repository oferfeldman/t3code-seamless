// @effect-diagnostics nodeBuiltinImport:off -- Executes the generated standalone launcher in its real Node runtime.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import { seamlessAgentSource } from "./seamlessAgentSource.ts";

function run(platform: string, args: string[], status = 200) {
  const fixture = `const config = {base:'https://hub.test', token:'fixture', deviceId:'target', platform:${JSON.stringify(platform)}};
process.argv = ['node', 'fixture', ...${JSON.stringify(args)}];
globalThis.fetch = async (url, request) => Response.json(${status === 200 ? "{stdout:JSON.stringify(JSON.parse(request.body).argv),stderr:'',code:0}" : "{detail:'Device host commands are unavailable'}"}, {status:${status}});
`;
  return NodeChildProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "-e", fixture + seamlessAgentSource],
    {
      encoding: "utf8",
    },
  );
}

it("routes Android exec to the device shell instead of the computer host", () => {
  const result = run("android", ["exec", "pm", "list", "packages", "com.feldman.motion.gallery"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    "adb",
    "shell",
    "pm",
    "list",
    "packages",
    "com.feldman.motion.gallery",
  ]);
});

it("keeps explicit adb arguments and desktop host commands unchanged", () => {
  expect(JSON.parse(run("android", ["exec", "adb", "shell", "getprop"]).stdout)).toEqual([
    "adb",
    "shell",
    "getprop",
  ]);
  expect(JSON.parse(run("desktop", ["exec", "whoami"]).stdout)).toEqual(["whoami"]);
});

it("reports the server error instead of blaming sharing for every failure", () => {
  const result = run("android", ["exec", "pm", "list", "packages"], 409);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("HTTP 409): Device host commands are unavailable");
  expect(result.stderr).not.toContain("sharing changed");
});
