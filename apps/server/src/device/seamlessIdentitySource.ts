export const seamlessIdentitySource = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');
let id;
if (process.platform === 'win32') {
  try { id = /\bid\s+REG_SZ\s+(\S+)/.exec(cp.execFileSync('reg.exe', ['query', 'HKCU\\Software\\Feldman\\Seamless\\contributor', '/v', 'id'], {encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','ignore']}))?.[1]; } catch {}
}
if (!id) for (const path of [os.homedir() + '/Library/Application Support/Seamless/config.json', '/etc/seamless/agent.json']) {
  try { id = JSON.parse(fs.readFileSync(path, 'utf8')).id; if (id) break; } catch {}
}
if (!id && process.platform === 'darwin') {
  try { id = cp.execFileSync('defaults', ['read', 'com.feldman.Seamless', 'contributor.id'], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim(); } catch {}
}
if (!id) {
  try { id = /\[contributor\][\s\S]*?^id=([^\r\n]+)/m.exec(fs.readFileSync(os.homedir() + '/.config/Feldman/Seamless.conf','utf8'))?.[1]; } catch {}
}
if (!id) {
  try { id = JSON.parse(fs.readFileSync(os.homedir() + '/.seamless-computer.json', 'utf8')).id; } catch {}
}
if (id) process.stdout.write(id);
`;
