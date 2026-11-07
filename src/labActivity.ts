import * as T from 'three';
import type { NetworkState } from '../engine/index.js';

const operations = [
  '$ tshark -i core0 -f ip',
  'core0  10.24.0.12:443  ESTABLISHED',
  '$ ip route get 10.24.0.1',
  'via core0  metric 10  route OK',
  'CRC error -> frame discarded',
  'link retry -> checksum verified',
  '$ ss -tn state established',
  'TLS sessions healthy / latency 2ms',
];
const security = [
  '[IDS] inspecting ingress traffic',
  '[IDS] port scan 198.51.100.24',
  '[FW] rule G-17 matched -> DENY',
  '[FW] source blocked / logged',
  '[AUDIT] checking policy integrity',
  '[AUDIT] policies verified -> OK',
  '[IDS] signature sweep complete',
  '[GUARD] no active incidents',
];

/** A deliberately separate simulated operations feed; never presented as lab errors. */
export function createOperationsDisplay() {
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 560;
  const ctx = canvas.getContext('2d')!;
  const texture = new T.CanvasTexture(canvas); texture.colorSpace = T.SRGBColorSpace; texture.anisotropy = 4;
  let previousStep = -1;
  function update(elapsed: number, network: NetworkState, quiet: boolean) {
    const step = quiet ? 0 : Math.floor(elapsed / 3200);
    if (step === previousStep) return; previousStep = step;
    ctx.fillStyle = '#030c13'; ctx.fillRect(0, 0, 1280, 560);
    const background = ctx.createLinearGradient(0, 0, 1280, 560); background.addColorStop(0, '#0b1f2b'); background.addColorStop(1, '#040d16');
    ctx.fillStyle = background; ctx.fillRect(0, 0, 1280, 560);
    ctx.fillStyle = '#6dd5ed'; ctx.font = 'bold 24px monospace'; ctx.fillText('GEEKEDNET  /  NETWORK OPERATIONS', 30, 43);
    ctx.font = '14px monospace'; ctx.fillStyle = '#597b8c'; ctx.fillText('SIMULATED OPS FEED  //  ISOLATED FROM STUDENT LAB', 30, 70);
    ctx.strokeStyle = '#1e3c4c'; ctx.beginPath(); ctx.moveTo(28, 90); ctx.lineTo(1250, 90); ctx.stroke();
    const panels = [{ x: 30, title: 'SHELL / ROUTING', lines: operations }, { x: 667, title: 'GUARD / FIREWALL', lines: security }];
    for (const panel of panels) {
      ctx.fillStyle = '#447e9a'; ctx.font = 'bold 18px monospace'; ctx.fillText(panel.title, panel.x, 125);
      ctx.font = '18px monospace';
      for (let line = 0; line < 8; line++) {
        const entry = panel.lines[(step + line) % panel.lines.length];
        ctx.fillStyle = entry.includes('blocked') || entry.includes('DENY') ? '#75dab3' : entry.startsWith('$') ? '#6fbeda' : '#719a9c';
        ctx.fillText(entry, panel.x, 168 + line * 35);
      }
    }
    ctx.strokeStyle = '#173747'; ctx.beginPath(); ctx.moveTo(635, 110); ctx.lineTo(635, 450); ctx.stroke();
    ctx.fillStyle = '#122d38'; ctx.fillRect(30, 474, 1220, 52);
    ctx.font = '16px monospace'; ctx.fillStyle = '#74b8bc';
    const powered = network.devices.filter(d => d.powered).length;
    ctx.fillText(`LAB TELEMETRY  ${powered} DEVICES ON  /  ${network.links.length} CABLES  /  STUDENT WORKSPACE ISOLATED`, 48, 506);
    if (!quiet && step % 2 === 0) { ctx.fillStyle = '#58d8a8'; ctx.fillRect(590, 410, 10, 19); }
    texture.needsUpdate = true;
  }
  return { texture, update };
}
