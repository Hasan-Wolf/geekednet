/**
 * Minimal terminal (Build Brief §11). Bound to the currently selected device
 * (falls back to the first host). Enter runs a command through the store, which
 * calls the engine and animates any resulting packet path on the canvas.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDevice } from '../../engine/index.js';
import { useStore } from '../store.js';

export function Terminal() {
  const log = useStore((s) => s.terminalLog);
  const runTerminal = useStore((s) => s.runTerminal);
  const clearTerminal = useStore((s) => s.clearTerminal);
  const net = useStore((s) => s.network);
  const selectedId = useStore((s) => s.selectedDeviceId);
  const terminalDeviceId = useStore((s) => s.terminalDeviceId);

  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Shell identity: the selected device if any, else the store's default.
  const shellId = selectedId ?? terminalDeviceId;
  const shellDev = shellId ? getDevice(net, shellId) : undefined;
  const prompt = shellDev ? `${shellDev.label.toLowerCase()}@geekednet:~$` : 'guest@geekednet:~$';

  const typed = useMemo(
    () => log.filter((l) => l.cls === 'prompt').map((l) => l.text),
    [log],
  );

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [log]);

  function submit() {
    const value = input;
    if (value.trim() === '') return;
    // If a device is selected, run its shell; otherwise the store default is used.
    if (selectedId) useStore.setState({ terminalDeviceId: selectedId });
    runTerminal(value);
    setInput('');
    setHistIdx(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      submit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (typed.length === 0) return;
      const idx = histIdx === null ? typed.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setInput(stripPrompt(typed[idx]));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === null) return;
      const idx = histIdx + 1;
      if (idx >= typed.length) {
        setHistIdx(null);
        setInput('');
      } else {
        setHistIdx(idx);
        setInput(stripPrompt(typed[idx]));
      }
    }
  }

  return (
    <div className="term-panel">
      <div className="term-head">
        <div className="dots">
          <i style={{ background: 'var(--status-down)' }} />
          <i style={{ background: 'var(--status-warn)' }} />
          <i style={{ background: 'var(--status-up)' }} />
        </div>
        <span className="term-title">Terminal · {shellDev?.label ?? 'no device'}</span>
        <div className="spacer" />
        <button className="btn" style={{ padding: '4px 9px', fontSize: 11 }} onClick={clearTerminal}>
          clear
        </button>
      </div>
      <div className="term-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {log.map((line, i) => (
          <div key={i} className={`term-line ${line.cls ?? 'plain'}`}>
            {line.text}
          </div>
        ))}
      </div>
      <div className="term-input-row">
        <span className="term-prompt-label">{prompt}</span>
        <input
          ref={inputRef}
          className="term-input"
          value={input}
          spellCheck={false}
          autoComplete="off"
          placeholder="ping <ip>"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}

function stripPrompt(line: string): string {
  const idx = line.indexOf('$ ');
  return idx >= 0 ? line.slice(idx + 2) : line;
}
