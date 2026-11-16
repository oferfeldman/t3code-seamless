// @effect-diagnostics nodeBuiltinImport:off -- Supplies filesystem and registry fixtures to the standalone host probe.
import * as NodeVM from "node:vm";
import { expect, it } from "@effect/vitest";
import { seamlessIdentitySource } from "./seamlessIdentitySource.ts";

it("reads the installed Mac agent identity without returning its credentials", () => {
  let output = "";
  NodeVM.runInNewContext(seamlessIdentitySource, {
    process: {
      platform: "darwin",
      stdout: {
        write: (value: string) => {
          output += value;
        },
      },
    },
    require: (module: string) =>
      module === "node:os"
        ? { homedir: () => "/fixture" }
        : module === "node:fs"
          ? {
              readFileSync: (path: string) => {
                if (path.endsWith("/.seamless-computer.json")) return '{"id":"retired-agent"}';
                if (!path.endsWith("/Library/Application Support/Seamless/config.json"))
                  throw new Error("missing");
                return '{"id":"mac-host","token":"private"}';
              },
            }
          : {},
  });
  expect(output).toBe("mac-host");
});

it("prefers the installed Windows identity over a retired agent configuration", () => {
  let output = "";
  NodeVM.runInNewContext(seamlessIdentitySource, {
    process: {
      platform: "win32",
      stdout: {
        write: (value: string) => {
          output += value;
        },
      },
    },
    require: (module: string) =>
      module === "node:os"
        ? { homedir: () => "C:/fixture" }
        : module === "node:fs"
          ? {
              readFileSync: () => '{"id":"retired-agent"}',
            }
          : { execFileSync: () => "    id    REG_SZ    windows-host\r\n" },
  });
  expect(output).toBe("windows-host");
});
