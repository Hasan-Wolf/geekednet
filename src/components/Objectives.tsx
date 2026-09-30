/** Objectives + brief for the active lab. Objective state comes from the engine's
 *  `evaluateObjectives` (via the store) and re-checks on every edit. */
import { getDevice, verifyTargetIp } from '../../engine/index.js';
import { useStore } from '../store.js';

export function Objectives() {
  const labId = useStore((s) => s.activeLabId);
  const lab = useStore((s) => s.labs.find((l) => l.id === labId)!);
  const results = useStore((s) => s.objectiveResults);
  const completed = useStore((s) => s.completedLabs.includes(labId));

  return (
    <section className="panel">
      <h3>{lab.title}</h3>
      <p className="brief">{lab.brief}</p>

      {results.length === 0 ? (
        <p className="cfg-empty">Free-build sandbox — no objectives. Experiment freely.</p>
      ) : (
        <ul className="obj-list">
          {results.map((o) => (
            <li key={o.id} className={`obj-item${o.complete ? ' done' : ''}`}>
              <span className="obj-check">{o.complete ? '✓' : ''}</span>
              <span className="obj-text">{o.description}</span>
            </li>
          ))}
        </ul>
      )}

      <VerifyPrompt />

      {completed && lab.rewards && (
        <div className="lab-complete">
          Lab complete · +{lab.rewards.xp} XP
          {lab.rewards.badges && lab.rewards.badges.length > 0 && (
            <div className="badges">
              {lab.rewards.badges.map((b) => (
                <span className="badge" key={b}>
                  ★ {b.replace(/-/g, ' ')}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The "ready to verify" state (see `VerifyStatus` in the store).
 *
 * Green objectives mean the config is right on paper. For a lab that names a
 * verifying ping, this is what stands between that and the win cut-in: it tells
 * the student, in as many words, which ping to run and from where. Labs that
 * name no such ping never reach this state, so nothing renders for them.
 */
function VerifyPrompt() {
  const labId = useStore((s) => s.activeLabId);
  const lab = useStore((s) => s.labs.find((l) => l.id === labId)!);
  const status = useStore((s) => s.verifyStatus);
  const net = useStore((s) => s.network);

  const verify = lab.verify;
  if (status === 'none' || !verify) return null;

  const from = getDevice(net, verify.from)?.label ?? verify.from;
  // Resolved live rather than read off the lab: when the student chose the
  // target's address, this prints the address they actually typed. The label
  // fallback only shows if the target somehow has no address — which green
  // objectives rule out by the time this prompt is up.
  const target =
    verifyTargetIp(lab, net) ??
    (verify.toDevice ? (getDevice(net, verify.toDevice)?.label ?? verify.toDevice) : verify.toIp);

  return (
    <div className={`verify-prompt${status === 'verifying' ? ' running' : ''}`} role="status">
      {status === 'verifying' ? (
        <>
          <strong>Verifying…</strong>
          <p>Tracking the packet across the wire.</p>
        </>
      ) : (
        <>
          <strong>⚡ Every objective is green — now prove it.</strong>
          <p>
            {verify.prompt ?? (
              <>
                Click <b>{from}</b>, then run <code>ping {target}</code> in the terminal.
                The lab is done when that packet lands.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
