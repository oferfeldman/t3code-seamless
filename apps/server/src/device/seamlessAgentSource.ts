export const seamlessAgentSource = String.raw`
const args = process.argv.slice(2);
const [command, ...values] = args;
if (command === "close") process.exit(0);
const fs = await import("node:fs/promises");
const endpoint = config.base + "/devices/" + encodeURIComponent(config.deviceId);
async function call(action, body = {}) {
  const response = await fetch(endpoint + "/" + action, {
    method: "POST", headers: {authorization: "Bearer " + config.token, "content-type": "application/json"},
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000), redirect: "error"
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error("Seamless " + action + " failed (HTTP " + response.status + ")" + (typeof detail?.detail === "string" ? ": " + detail.detail : "."));
  }
  return response;
}
try {
  if (command === "screenshot" || command === "snapshot") {
    const image = Buffer.from(await (await call("screenshot")).arrayBuffer());
    const output = values[0] && !values[0].startsWith("-") ? values[0] : "seamless-screen.png";
    await fs.writeFile(output, image);
    console.log(JSON.stringify({path: output, width: image.readUInt32BE(16), height: image.readUInt32BE(20), coordinates: "normalized 0..1", accessibility: false}));
  } else if (command === "tap" || command === "swipe") {
    const numbers = values.map(Number);
    const count = command === "tap" ? 2 : 4;
    if (numbers.length !== count || numbers.some(n => !Number.isFinite(n) || n < 0 || n > 1)) throw new Error("Use normalized coordinates from 0 to 1.");
    await call("input", {type: command, x: numbers[0], y: numbers[1], endX: numbers[2], endY: numbers[3]});
  } else if (command === "text") {
    await call("input", {type: "text", text: values.join(" ")});
  } else if (command === "key") {
    const codes = values.map(Number);
    if (!codes.length || codes.some(code => !Number.isInteger(code) || code < 0 || code > 65535)) throw new Error("Provide numeric key codes.");
    await call("input", {type: "key", codes});
  } else if (command === "scroll") {
    await call("input", {type: "scroll", dy: Number(values[0]), dx: Number(values[1] || 0)});
  } else if (command === "install") {
    if (!values[0]) throw new Error("Provide a local APK path.");
    const response = await fetch(endpoint + "/install", {method: "POST", headers: {authorization: "Bearer " + config.token},
      body: await fs.readFile(values[0]), signal: AbortSignal.timeout(120000), redirect: "error"});
    if (!response.ok) throw new Error("APK installation failed (HTTP " + response.status + ").");
    console.log(await response.text());
  } else if (command === "exec") {
    const argv = config.platform === "android" && values[0] !== "adb" ? ["adb", "shell", ...values] : values;
    const result = await (await call("command", {argv})).json();
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
  } else {
    console.log("Commands: screenshot <path>, snapshot <path>, tap <x> <y>, swipe <x> <y> <endX> <endY>, text <text>, key <code> [code...], scroll <dy> [dx], install <local.apk>, exec <command> [args]. Coordinates are normalized 0..1. Key codes are Android keycodes on phones/simulators, Windows virtual-key codes on desktops (multiple codes form a chord, e.g. key 162 65 for Ctrl+A). Snapshot returns an image; inspect it visually.");
    if (command && command !== "help") process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;
