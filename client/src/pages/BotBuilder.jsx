import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  applyNodeChanges, addEdge, ReactFlowProvider, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api';
import StepEditor from '../components/StepEditor';
import { TRIGGERS, ACTIONS, ACTION_META } from '../lib/palette';

/**
 * The bot builder canvas.
 *
 * A flow is a graph, and a list of steps is a poor way to read a graph — you
 * cannot see a dead end or a loop in a table. So the steps are boxes, the
 * arrows between them are the real `next_key` links, and dragging an arrow
 * rewrites the flow.
 *
 * Layout is saved separately from behaviour. Moving a box is presentation and
 * must never be able to change what the bot does, so a drag only ever calls
 * the layout endpoint.
 */

const META = ACTION_META;

/**
 * One box on the canvas.
 *
 * Laid out like the message it will actually send — header, body, footer, then
 * the choices — because a flow is much easier to read when each box resembles
 * what lands on the phone rather than a row in a table. Every choice carries
 * its own outlet, so the arrow leaving a button is visibly *that* button's.
 */
function StepNode({ data, selected }) {
  const meta = META[data.kind] ?? { icon: '•', label: data.kind };
  const outlets = data.outlets ?? [];

  return (
    <div className={`stepnode stepnode--${data.kind} ${selected ? 'is-selected' : ''}`}>
      {!data.isEntry ? <Handle type="target" position={Position.Left} /> : null}

      <div className="stepnode__head">
        <span className="stepnode__icon">{meta.icon}</span>
        <strong>{data.label}</strong>
        {data.isEntry ? <span className="tag">start</span> : null}
        {data.display && data.display !== 'text'
          ? <span className="tag tag--soft">{data.display}</span>
          : null}
      </div>

      {data.header ? <div className="stepnode__header">{data.header}</div> : null}
      {data.preview ? <div className="stepnode__body">{data.preview}</div> : null}
      {data.footer ? <div className="stepnode__footer">{data.footer}</div> : null}

      {outlets.map((o) => (
        <div key={o.handle}
          className={`stepnode__outlet ${o.button ? 'stepnode__outlet--button' : ''}`}>
          <span>{o.label}</span>
          <Handle type="source" position={Position.Right} id={o.handle} />
        </div>
      ))}
    </div>
  );
}

const nodeTypes = { step: StepNode };

/** What a step shows on its box, and which outlets it has. */
function toFlowNode(n, entryKey) {
  const outlets = [];

  if (n.kind === 'menu') {
    const tappable = ['buttons', 'list'].includes(n.config?.display);
    (n.options ?? []).forEach((o, i) => outlets.push({
      handle: `opt:${i}`,
      label: tappable ? o.label : `${i + 1}. ${o.label}`,
      button: tappable,
    }));
  } else if (n.kind === 'condition') {
    (n.options ?? []).forEach((r, i) => outlets.push({
      handle: `opt:${i}`,
      label: `${r.field} ${r.op.replace('_', ' ')} ${r.value}`.trim(),
    }));
    outlets.push({ handle: 'next', label: 'otherwise' });
  } else if (!['end', 'handoff'].includes(n.kind)) {
    outlets.push({ handle: 'next', label: 'then' });
  }

  const preview = n.kind === 'sheets'
    ? `${n.config?.sheetName || 'Sheet1'} — ${(n.config?.columns ?? []).length} column(s)`
    : n.kind === 'delay'
      ? `waits ${n.config?.seconds ?? 0} seconds`
      : (n.body || '').slice(0, 90);

  return {
    id: n.node_key,
    type: 'step',
    position: { x: n.pos_x ?? 0, y: n.pos_y ?? 0 },
    data: {
      kind: n.kind,
      label: n.node_key,
      preview,
      header: n.config?.header ?? '',
      footer: n.config?.footer ?? '',
      display: n.kind === 'menu' ? (n.config?.display ?? 'text') : null,
      outlets,
      isEntry: n.node_key === entryKey,
    },
  };
}

/** Every arrow, derived from the flow itself rather than stored twice. */
function toFlowEdges(nodes) {
  const edges = [];
  for (const n of nodes) {
    (n.options ?? []).forEach((o, i) => {
      if (o.next_key) {
        edges.push({
          id: `${n.node_key}-opt${i}`,
          source: n.node_key,
          sourceHandle: `opt:${i}`,
          target: o.next_key,
          label: n.kind === 'condition' ? 'if' : `${i + 1}`,
        });
      }
    });
    if (n.next_key) {
      edges.push({
        id: `${n.node_key}-next`,
        source: n.node_key,
        sourceHandle: 'next',
        target: n.next_key,
        label: n.kind === 'condition' ? 'else' : '',
      });
    }
  }
  return edges;
}

function Canvas() {
  const { id } = useParams();
  const wrap = useRef(null);
  const saveTimer = useRef(null);
  const { screenToFlowPosition } = useReactFlow();

  const [bot, setBot] = useState(null);
  const [steps, setSteps] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [check, setCheck] = useState(null);
  const [editing, setEditing] = useState(null);
  const [chat, setChat] = useState([]);
  const [saying, setSaying] = useState('');
  const [showTest, setShowTest] = useState(true);
  const [tab, setTab] = useState('Actions');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const b = await api.bot(id);
      setBot(b);
      setSteps(b.nodes ?? []);
      setNodes((b.nodes ?? []).map((n) => toFlowNode(n, b.entry_key)));
      setCheck(await api.botCheck(id));
      setError(null);
    } catch (e) { setError(e.message); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const edges = useMemo(() => toFlowEdges(steps), [steps]);

  /*
   * Dragging saves position only, and only once the dust settles — a drag
   * fires dozens of change events and each one is a network round trip.
   */
  const onNodesChange = useCallback((changes) => {
    setNodes((current) => applyNodeChanges(changes, current));

    if (!changes.some((c) => c.type === 'position' && c.dragging === false)) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setNodes((current) => {
        api.botLayout(id, current.map((n) => ({ key: n.id, x: n.position.x, y: n.position.y })))
          .catch((e) => setError(e.message));
        return current;
      });
    }, 400);
  }, [id]);

  const onConnect = useCallback(async (params) => {
    try {
      await api.botConnect(id, {
        from: params.source,
        handle: params.sourceHandle ?? 'next',
        to: params.target,
      });
      await load();
    } catch (e) { setError(e.message); }
  }, [id, load]);

  const onEdgesDelete = useCallback(async (removed) => {
    try {
      for (const e of removed) {
        await api.botConnect(id, { from: e.source, handle: e.sourceHandle ?? 'next', to: null });
      }
      await load();
    } catch (e) { setError(e.message); }
  }, [id, load]);

  /* Drop a new step from the palette wherever it was let go. */
  const onDrop = useCallback((event) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData('application/step-kind');
    if (!kind) return;

    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const used = new Set(steps.map((s) => s.node_key));
    let key = kind;
    for (let i = 2; used.has(key); i += 1) key = `${kind}_${i}`;

    setEditing({
      key, kind, body: '', options: [], config: {}, saveAs: '', nextKey: '',
      x: position.x, y: position.y, isNew: true,
    });
  }, [screenToFlowPosition, steps]);

  const openStep = useCallback((_, node) => {
    const s = steps.find((x) => x.node_key === node.id);
    if (!s) return;
    setEditing({
      key: s.node_key, kind: s.kind, body: s.body, options: s.options ?? [],
      config: s.config ?? {}, saveAs: s.save_as ?? '', nextKey: s.next_key ?? '',
      x: s.pos_x, y: s.pos_y, isNew: false,
    });
  }, [steps]);

  /** Switch what starts the bot, keeping everything else about it. */
  const setTrigger = async (event) => {
    setBusy(true);
    try {
      await api.botUpdate(id, {
        name: bot.name,
        session: bot.session,
        triggerEvent: event,
        triggerType: bot.trigger_type,
        triggerText: bot.trigger_text,
        entryKey: bot.entry_key,
        fallback: bot.fallback,
        maxRetries: bot.max_retries,
        timeoutMinutes: bot.timeout_minutes,
        allowGroups: bot.allow_groups,
        enabled: bot.enabled,
      });
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const saveStep = async (step) => {
    setBusy(true);
    try {
      await api.botSaveNode(id, step.key, step);
      setEditing(null);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const deleteStep = async (key) => {
    setBusy(true);
    try {
      await api.botDeleteNode(id, key);
      setEditing(null);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  /* -------------------------------- test it ------------------------------ */

  const say = async (text, reset = false) => {
    setBusy(true);
    try {
      const res = await api.botTry(id, { text, reset });
      setChat((c) => [
        ...(reset ? [] : c),
        { who: 'them', text },
        ...(res.started ? res.replies.map((r) => ({ who: 'bot', text: r })) : [{ who: 'note', text: res.note }]),
        ...(res.notes ?? []).map((n) => ({ who: 'note', text: n })),
        ...(res.delaySeconds ? [{ who: 'note', text: `Sent ${res.delaySeconds}s later than usual.` }] : []),
        ...(res.looped ? [{ who: 'note', text: 'This flow loops — it was stopped after 12 steps.' }] : []),
      ]);
      setSaying('');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!bot) return <div className="page"><p className="muted">{error ?? 'Loading…'}</p></div>;

  return (
    <div className="builder">
      <header className="builder__bar">
        <div className="row">
          <Link to="/bots" className="muted">←</Link>
          <strong>{bot.name}</strong>
          <span className={`pill ${bot.enabled ? 'pill--on' : ''}`}>
            {bot.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <span className="muted">
            {bot.trigger_event === 'no_match'
              ? 'starts when nothing else answers'
              : bot.trigger_event === 'first_daily'
                ? 'starts on their first message of the day'
                : `starts on ${bot.trigger_type === 'any' ? 'any message' : `"${bot.trigger_text}"`}`}
          </span>
        </div>
        <div className="row">
          {check && !check.ok
            ? <span className="error">{check.problems.length} gap(s) in this flow</span>
            : <span className="muted">flow is complete</span>}
          <button onClick={() => setShowTest(!showTest)}>{showTest ? 'Hide test' : 'Test it'}</button>
          <button onClick={() => api.botToggle(id, !bot.enabled).then(load)}>
            {bot.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </header>

      {error ? <p className="error builder__error" onClick={() => setError(null)}>{error} (click to dismiss)</p> : null}

      <div className="builder__body">
        <aside className="builder__palette">
          <div className="tabs">
            {['Triggers', 'Actions'].map((t) => (
              <button key={t} className={tab === t ? 'tabs__tab is-active' : 'tabs__tab'}
                onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>

          {tab === 'Triggers' ? (
            <>
              {/*
                * A trigger is a property of the bot, not a step on the canvas —
                * there is exactly one way in, and a flow with two entry points
                * would have nowhere to draw the second one.
                */}
              <p className="muted">
                What starts this bot. Choose one — it is a setting, not something to drag.
              </p>
              {TRIGGERS.map((group) => (
                <div key={group.group}>
                  <h4 className="palette__group">{group.group}</h4>
                  {group.items.map((t) => (
                    <button key={t.kind} type="button"
                      className={`palette__item palette__item--trigger ${
                        bot.trigger_event === t.kind ? 'is-selected' : ''
                      } ${t.unavailable ? 'is-off' : ''}`}
                      disabled={Boolean(t.unavailable) || busy}
                      title={t.unavailable ?? t.hint}
                      onClick={() => setTrigger(t.kind)}>
                      <span className="palette__icon">{t.unavailable ? '🔒' : t.icon}</span>
                      <div>
                        <strong>{t.label}</strong>
                        <div className="muted">{t.unavailable ?? t.hint}</div>
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </>
          ) : (
            <>
              <p className="muted">Drag one onto the canvas.</p>
              {ACTIONS.map((group) => (
                <div key={group.group}>
                  <h4 className="palette__group">{group.group}</h4>
                  {group.items.map((a) => (
                    <div key={a.kind}
                      className={`palette__item palette__item--${a.kind} ${a.unavailable ? 'is-off' : ''}`}
                      draggable={!a.unavailable}
                      title={a.unavailable ?? a.hint}
                      onDragStart={(e) => {
                        if (a.unavailable) { e.preventDefault(); return; }
                        e.dataTransfer.setData('application/step-kind', a.kind);
                        e.dataTransfer.effectAllowed = 'move';
                      }}>
                      <span className="palette__icon">{a.unavailable ? '🔒' : a.icon}</span>
                      <div>
                        <strong>{a.label}</strong>
                        <div className="muted">{a.unavailable ?? a.hint}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          {check && !check.ok ? (
            <div className="card card--warn">
              <strong>Gaps</strong>
              <ul>{check.problems.map((p, i) => <li key={i}><code>{p.where}</code> — {p.error}</li>)}</ul>
            </div>
          ) : null}
        </aside>

        <div className="builder__canvas" ref={wrap}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeDoubleClick={openStep}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
          <p className="builder__hint muted">
            Double-click a step to edit it · drag from an outlet to connect · select an arrow and press
            Delete to cut it
          </p>
        </div>

        {showTest ? (
          <aside className="builder__test">
            <div className="row row--between">
              <h3>Try it</h3>
              <button onClick={() => { setChat([]); api.botTry(id, { text: '', reset: true }).catch(() => {}); }}>
                Restart
              </button>
            </div>
            <p className="muted">
              The real engine, with nothing sent and nothing written to a spreadsheet.
            </p>

            <div className="botchat">
              {chat.length === 0 ? (
                <p className="muted">
                  Say {bot.trigger_type === 'any' ? 'anything' : `"${bot.trigger_text}"`} to begin.
                </p>
              ) : chat.map((m, i) => (
                <div key={i} className={`botchat__line botchat__line--${m.who}`}>
                  {m.text.split('\n').map((line, j) => <div key={j}>{line || ' '}</div>)}
                </div>
              ))}
            </div>

            <form className="row" onSubmit={(e) => { e.preventDefault(); if (saying.trim()) say(saying); }}>
              <input value={saying} onChange={(e) => setSaying(e.target.value)}
                placeholder="Type as if you were them…" disabled={busy} />
              <button className="primary" disabled={busy || !saying.trim()}>Send</button>
            </form>
          </aside>
        ) : null}
      </div>

      {editing ? (
        <StepEditor
          step={editing}
          steps={steps}
          busy={busy}
          isEntry={editing.key === bot.entry_key}
          onChange={setEditing}
          onSave={saveStep}
          onDelete={deleteStep}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

export default function BotBuilder() {
  return <ReactFlowProvider><Canvas /></ReactFlowProvider>;
}
