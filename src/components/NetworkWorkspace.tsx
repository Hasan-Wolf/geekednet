import { useEffect, useRef, useState } from 'react';
import { PALETTE } from '../devices.js';
import { createLabScene, type LabScene } from '../labScene.js';
import { hasWorkstationMonitor } from '../labModels.js';
import { useStore } from '../store.js';
import { Canvas } from './Canvas.js';
import { CompanionBot } from './CompanionBot.js';
import { MonitorConsole } from './MonitorConsole.js';
import { TopologyControls } from './Topology.js';
import { WinBar } from './WinBar.js';
import { deviceLinkStatus } from '../../engine/index.js';

export function NetworkWorkspace() {
  const [mode, setMode] = useState<'3d' | '2d'>(() => new URLSearchParams(location.search).get('view') === '2d' ? '2d' : '3d');
  const topologyMode = useStore(s => s.topologyMode);
  const topologyId = useStore(s => s.topologyId);
  const labTitle = useStore(s => s.labs.find(l => l.id === s.activeLabId)?.title);
  return <main className="network-workspace">
    <div className="workspace-heading">
      <div><span className="workspace-eyebrow">GEEKEDNET / LAB 01</span><h1>{topologyMode ? 'Topology studio' : labTitle}</h1></div>
      <div className="workspace-mode" aria-label="Workspace view">
        <button className={mode === '3d' ? 'active' : ''} aria-pressed={mode === '3d'} onClick={() => setMode('3d')}>◈ 3D Lab</button>
        <button className={mode === '2d' ? 'active' : ''} aria-pressed={mode === '2d'} onClick={() => setMode('2d')}>⌗ 2D Map</button>
      </div>
    </div>
    {mode === '2d' || (topologyMode && !topologyId) ? <Canvas /> : <LabCanvas onFallback={() => setMode('2d')} />}
  </main>;
}

function LabCanvas({ onFallback }: { onFallback: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scene = useRef<LabScene | null>(null);
  const [cameraView, setCameraView] = useState<'orbit' | 'top'>('orbit');
  const [bright, setBright] = useState(false);
  const [quiet, setQuiet] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [consoleId, setConsoleId] = useState<string | null>(null);
  const net = useStore(s => s.network);
  const selected = useStore(s => s.selectedDeviceId);
  const connectMode = useStore(s => s.connectMode);
  const connectSource = useStore(s => s.connectSourceId);
  const packet = useStore(s => s.packet);
  const packetsLanded = useStore(s => s.packetsLanded);
  const flight = useRef({ id: packet?.id, landed: packetsLanded });
  if (flight.current.id !== packet?.id) flight.current = { id: packet?.id, landed: packetsLanded };
  const sending = !!packet && packetsLanded === flight.current.landed;
  const result = useStore(s => s.lastResult);
  const lastDeleted = useStore(s => s.lastDeleted);
  const winOpen = useStore(s => !!s.justCompleted);
  const demo = useStore(s => s.topologies.find(t => t.id === s.topologyId) ?? null);
  const quickSetup = useStore(s => !s.topologyMode && s.activeLabId === 'tier0-first-ping.learn');
  const toggleConnect = useStore(s => s.toggleConnectMode);

  useEffect(() => {
    try {
      scene.current = createLabScene(host.current!, labels.current!, () => setError(true), setConsoleId);
      setReady(true);
    } catch (err) { console.warn('3D lab could not start:', err); setError(true); }
    return () => { scene.current?.dispose(); scene.current = null; };
  }, []);

  useEffect(() => {
    if (consoleId && consoleId !== selected) setConsoleId(null);
  }, [consoleId, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.defaultPrevented || el.closest?.('.lab-monitor') || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName) || el.isContentEditable) return;
      const state = useStore.getState();
      if (e.key === 'Escape' && state.connectMode) state.toggleConnectMode();
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedDeviceId) { e.preventDefault(); state.removeDevice(state.selectedDeviceId); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && state.lastDeleted) { e.preventDefault(); state.undoDelete(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectedDevice = net.devices.find(d => d.id === selected);
  const monitorDevice = selectedDevice && selectedDevice.id === consoleId && hasWorkstationMonitor(selectedDevice.kind)
    ? selectedDevice : null;
  const pc = selectedDevice && hasWorkstationMonitor(selectedDevice.kind)
    ? selectedDevice : net.devices.find(d => d.kind === 'pc' || d.kind === 'laptop');
  const destination = net.devices.find(d => d.id !== pc?.id && ['pc', 'laptop', 'server'].includes(d.kind) && d.interfaces.some(i => i.ip));
  function runPing() {
    if (!pc || !destination) return;
    const state = useStore.getState(); state.selectDevice(pc.id);
    state.runTerminal(`ping ${destination.interfaces.find(i => i.ip)!.ip}`);
    scene.current?.resetView();
  }
  function configureDemo() {
    const state = useStore.getState();
    const pcs = state.network.devices.filter(d => d.kind === 'pc').slice(0, 2);
    pcs.forEach((d, i) => {
      state.setIfaceField(d.id, d.interfaces[0].id, 'ip', `192.168.1.${10 + i}`);
      state.setIfaceField(d.id, d.interfaces[0].id, 'mask', '255.255.255.0');
    });
    if (pcs[0]) state.selectDevice(pcs[0].id);
  }

  return <div className={`lab-canvas${selected ? ' has-selection' : ''}${dropActive ? ' drop-active' : ''}${winOpen ? ' win-open' : ''}`}
    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropActive(true); }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false); }}
    onDrop={e => { e.preventDefault(); setDropActive(false); const kind = e.dataTransfer.getData('application/geekednet-kind'); if (PALETTE.some(p => p.kind === kind)) scene.current?.drop(kind as typeof PALETTE[number]['kind'], e.clientX, e.clientY); }}>
    <div ref={host} className="lab-renderer" />
    <div ref={labels} className="lab-labels" />
    <div className="lab-toolbar">
      <button className={`lab-tool${connectMode ? ' active' : ''}`} aria-pressed={connectMode} onClick={toggleConnect}>⌁ {connectMode ? 'Cancel wiring' : 'Connect cables'}</button>
      <span className="lab-toolbar-hint">{connectMode ? connectSource ? 'Now select the second device' : 'Select the first device to connect' : 'Click a PC screen to open its console · drag to rotate'}</span>
      <span className="lab-live"><i />LIVE LAB</span>
    </div>
    <nav className="lab-device-nav" aria-label="Lab devices">
      <span>DEVICES</span>
      {net.devices.map(d => <button key={d.id} className={selected === d.id ? 'active' : ''} aria-label={`Focus ${d.label}`} aria-pressed={selected === d.id} onClick={() => scene.current?.focusDevice(d.id)}><i className={`lab-nav-led ${deviceLinkStatus(net, d.id).health}`} />{d.label}</button>)}
    </nav>
    {demo && <div className="lab-topology-controls"><TopologyControls demo={demo} /></div>}
    <div className="lab-view-tools">
      <button title="3D view — drag empty space to rotate" aria-label="Orbit view" aria-pressed={cameraView === 'orbit'} onClick={() => { setCameraView('orbit'); scene.current?.setView('orbit'); }}>◈</button>
      <button title="Top view — see the complete network from above" aria-label="Top view" aria-pressed={cameraView === 'top'} onClick={() => { setCameraView('top'); scene.current?.setView('top'); }}>⊞</button>
      <span />
      <button title="Zoom in" aria-label="Zoom in" onClick={() => scene.current?.zoom('in')}>+</button>
      <button title="Zoom out" aria-label="Zoom out" onClick={() => scene.current?.zoom('out')}>−</button>
      <span />
      <button title="Toggle work lights" aria-label="Toggle work lights" aria-pressed={bright} onClick={() => { setBright(!bright); scene.current?.setBright(!bright); }}>☼</button>
      <span />
      <button className="lab-quiet-toggle" title="Quiet background" aria-label="Quiet background" aria-pressed={quiet} onClick={() => { setQuiet(!quiet); scene.current?.setQuiet(!quiet); }}>☾</button>
    </div>
    <div className="lab-bottom-bar">
      <button className="lab-tool" onClick={() => scene.current?.resetView()}>↺ Reset view</button>
      <span className="lab-bottom-hint">{selected ? 'CLICK EMPTY SPACE TO ZOOM OUT' : 'CLICK A DEVICE TO CONFIGURE'}</span>
      {quickSetup && !destination && <button className="lab-tool lab-setup" onClick={configureDemo}>Quick setup</button>}
      <button className="lab-run" disabled={!pc || !destination || sending} onClick={runPing}>{sending ? '◌ Sending…' : '▶ Run ping'}</button>
    </div>
    {!ready && !error && <div className="lab-loading">Preparing your workbench…</div>}
    {error && <div className="lab-loading"><h2>3D view is unavailable in this browser.</h2><p>You can keep building in the network map.</p><button className="lab-run" onClick={onFallback}>Open 2D Map</button></div>}
    {lastDeleted && <div className="lab-undo" role="status"><span>{lastDeleted.label} removed</span><button onClick={() => useStore.getState().undoDelete()}>Undo</button><button aria-label="Dismiss undo" onClick={() => useStore.getState().dismissUndo()}>×</button></div>}
    {selectedDevice && <div className="lab-selected-tools">
      <span>{selectedDevice.label} selected</span>
      {!connectMode && hasWorkstationMonitor(selectedDevice.kind) && <button className="lab-open-console" onClick={() => setConsoleId(selectedDevice.id)}>Open console</button>}
      <button onClick={() => useStore.getState().removeDevice(selectedDevice.id)}>Remove device</button>
    </div>}
    {!error && monitorDevice && <MonitorConsole key={monitorDevice.id} device={monitorDevice} onClose={() => setConsoleId(null)} />}
    {result && <button className={`lab-result ${result.success ? 'ok' : 'fail'}`} onClick={() => useStore.getState().dismissResult()}>{result.success ? `✓ ${result.broadcast ? 'Broadcast delivered' : `Reply from ${result.target ?? 'host'} — packet delivered`}` : `✕ ${result.reason ?? 'Unreachable'}`}<span>×</span></button>}
    {net.devices.length === 0 && <div className="lab-empty"><h2>Your bench. Your network.</h2><p>Drag a PC, switch, or router onto the surface to begin.</p></div>}
    <CompanionBot />
    <WinBar />
  </div>;
}
