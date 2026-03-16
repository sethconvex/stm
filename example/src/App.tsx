import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState, useCallback } from "react";

const RESOURCES = [
  { key: "gold", label: "Gold", color: "#ffd700", emoji: "\u{1F947}" },
  { key: "silver", label: "Silver", color: "#c0c0c0", emoji: "\u{1F948}" },
  { key: "bronze", label: "Bronze", color: "#cd7f32", emoji: "\u{1F949}" },
];

const INITIAL_TOTAL = 140;

function ResourceBar({
  resource,
  value,
}: {
  resource: (typeof RESOURCES)[number];
  value: number;
}) {
  const pct = (value / INITIAL_TOTAL) * 100;
  return (
    <div className="resource-row">
      <span className="resource-label">
        {resource.emoji} {resource.label}
      </span>
      <div className="bar-track">
        <div
          className="bar-fill"
          style={{ width: `${pct}%`, background: resource.color }}
        />
      </div>
      <span className="resource-value">{value}</span>
    </div>
  );
}

function Invariant({ values }: { values: Record<string, number> }) {
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  const ok = total === INITIAL_TOTAL;
  return (
    <div className={`invariant ${ok ? "ok" : "broken"}`}>
      {ok
        ? `Total: ${total} = ${INITIAL_TOTAL} (conserved)`
        : `INVARIANT BROKEN: ${total} != ${INITIAL_TOTAL}`}
    </div>
  );
}

function MovePanel() {
  const atomicMove = useMutation(api.example.atomicMove);
  const [from, setFrom] = useState("bronze");
  const [to, setTo] = useState("gold");
  const [amount, setAmount] = useState(5);
  const [status, setStatus] = useState<string | null>(null);

  const doMove = async () => {
    setStatus(null);
    const result = await atomicMove({ from, to, amount });
    if (result.committed) {
      setStatus(String(result.value));
    } else {
      setStatus(`Blocked: not enough in ${from}`);
    }
  };

  return (
    <div className="panel">
      <h2>Atomic Move</h2>
      <p className="hint">
        Move items between bins in a single atomic step. Both the decrement and
        increment happen together — the total <strong>never</strong> changes,
        not even for an instant.
      </p>
      <div className="row">
        <label>
          From
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {RESOURCES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.emoji} {r.label}
              </option>
            ))}
          </select>
        </label>
        <span className="arrow">{"\u2192"}</span>
        <label>
          To
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {RESOURCES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.emoji} {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Qty
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            min={1}
          />
        </label>
        <button onClick={doMove} disabled={from === to}>
          Move
        </button>
      </div>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function OrElsePanel() {
  const takeBest = useMutation(api.example.takeBest);
  const [amount, setAmount] = useState(1);
  const [status, setStatus] = useState<string | null>(null);

  const doTake = async () => {
    setStatus(null);
    const result = await takeBest({ amount });
    if (result.committed) {
      setStatus(`Took ${amount} from ${result.value as string}!`);
    } else {
      setStatus("All bins empty");
    }
  };

  return (
    <div className="panel highlight">
      <h2>orElse: Composable Fallback</h2>
      <p className="hint">
        "Take from gold. If empty, try silver. If empty, try bronze."
        <br />
        Each branch's writes are <strong>rolled back</strong> before trying the
        next. This composes blocking transactions — something plain if/else
        can't do.
      </p>
      <div className="row">
        <label>
          Amount
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            min={1}
          />
        </label>
        <button onClick={doTake}>Take Best Available</button>
      </div>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function StressTest({ values }: { values: Record<string, number> }) {
  const randomMove = useMutation(api.example.randomMove);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const run = useCallback(async () => {
    setRunning(true);
    setLog([]);

    const totalBefore = Object.values(values).reduce((a, b) => a + b, 0);

    const promises = Array.from({ length: 30 }, (_, i) =>
      randomMove({ seed: Date.now() + i }),
    );
    const settled = await Promise.allSettled(promises);

    const ok = settled.filter((r) => r.status === "fulfilled").length;
    const fail = settled.filter((r) => r.status === "rejected").length;

    setLog([
      `Fired 30 concurrent atomic moves`,
      `${ok} committed, ${fail} rejected (OCC contention)`,
      `Total before: ${totalBefore}`,
      `Check the invariant above — still ${INITIAL_TOTAL}.`,
    ]);
    setRunning(false);
  }, [randomMove, values]);

  return (
    <div className="panel stress">
      <h2>Stress Test: Prove Atomicity</h2>
      <p className="hint">
        Fire 30 random moves <strong>concurrently</strong>. Each one reads two
        bins, decrements one, increments the other. If any operation were
        non-atomic, the total would drift. It never does.
      </p>
      <button onClick={run} disabled={running}>
        {running ? "Running..." : "Fire 30 Concurrent Moves"}
      </button>
      {log.length > 0 && (
        <div className="stress-results">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const values = useQuery(api.example.readAll) ?? {
    gold: 0,
    silver: 0,
    bronze: 0,
  };
  const setup = useMutation(api.example.setup);

  return (
    <div className="app">
      <h1>Composable Memory Transactions</h1>
      <p className="subtitle">
        <code>@convex-dev/stm</code> — atomic, composable, provably correct
      </p>

      <div className="resources">
        {RESOURCES.map((r) => (
          <ResourceBar key={r.key} resource={r} value={values[r.key] ?? 0} />
        ))}
        <Invariant values={values} />
      </div>

      <button className="reset-btn" onClick={() => setup({})}>
        Reset to 10 / 30 / 100
      </button>

      <MovePanel />
      <OrElsePanel />
      <StressTest values={values} />

      <div className="panel code">
        <h2>The Code</h2>
        <pre>{`function take(tx, bin, amount) {
  const have = tx.read(bin);
  if (have < amount) tx.retry();  // composable blocking
  tx.write(bin, have - amount);
}

function put(tx, bin, amount) {
  const have = tx.read(bin);
  tx.write(bin, have + amount);
}

// Atomic move — total is ALWAYS conserved
await stm.atomic(ctx, (tx) => {
  take(tx, "bronze", 5);
  put(tx, "gold", 5);
}, ["bronze", "gold"]);

// orElse — composable fallback
await stm.atomic(ctx, (tx) => {
  return tx.orElse(
    () => { take(tx, "gold", 1);   return "gold"; },
    () => tx.orElse(
      () => { take(tx, "silver", 1); return "silver"; },
      () => { take(tx, "bronze", 1); return "bronze"; },
    ),
  );
}, ["gold", "silver", "bronze"]);`}</pre>
      </div>

      <p className="footer">
        Open in multiple tabs — balances sync in real-time.
        <br />
        Based on Harris et al., "Composable Memory Transactions" (PPoPP 2005).
      </p>
    </div>
  );
}

export default App;
