import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

const PROVIDERS = [
  { key: "printful", label: "Printful", color: "#2563eb" },
  { key: "printify", label: "Printify", color: "#16a34a" },
  { key: "gooten", label: "Gooten", color: "#9333ea" },
];

const DESIGNS = ["Convex Logo Tee", "STM All-Stars", "Retry Until I Die"];
const SIZES = ["S", "M", "L", "XL"];

function ProviderStatus() {
  const providers = useQuery(api.example.readProviders) ?? {};
  const toggle = useMutation(api.example.toggleProvider);

  return (
    <div className="providers">
      {PROVIDERS.map((p) => {
        const online = providers[p.key] ?? false;
        return (
          <button
            key={p.key}
            className={`provider-card ${online ? "online" : "offline"}`}
            style={{ borderColor: online ? p.color : "#333" }}
            onClick={() => toggle({ provider: p.key })}
          >
            <span className="provider-dot" style={{ background: online ? p.color : "#555" }} />
            <span className="provider-name">{p.label}</span>
            <span className="provider-status">{online ? "online" : "offline"}</span>
          </button>
        );
      })}
    </div>
  );
}

function OrderForm() {
  const orderShirt = useMutation(api.example.orderShirt);
  const [design, setDesign] = useState(DESIGNS[0]);
  const [size, setSize] = useState("L");
  const [status, setStatus] = useState<string | null>(null);

  const doOrder = async () => {
    setStatus(null);
    await orderShirt({ design, size });
    setStatus("Order placed! Watch it get fulfilled below.");
  };

  return (
    <div className="panel">
      <h2>Order a T-Shirt</h2>
      <div className="row">
        <label>
          Design
          <select value={design} onChange={(e) => setDesign(e.target.value)}>
            {DESIGNS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label>
          Size
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button onClick={doOrder}>Order</button>
      </div>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function OrderFeed() {
  const orders = useQuery(api.example.listOrders) ?? [];
  if (orders.length === 0) return null;

  return (
    <div className="orders">
      <h2>Orders</h2>
      {orders.map((o) => (
        <div key={o._id} className={`order ${o.status}`}>
          <div className="order-header">
            <span className="order-dot" />
            <span className="order-item">
              {o.design} ({o.size})
            </span>
            <span className="order-status">{o.status}</span>
            {o.provider && (
              <span className="order-provider">via {o.provider}</span>
            )}
          </div>
          {o.attempts.length > 0 && (
            <div className="attempts">
              {o.attempts.map((a, i) => (
                <span
                  key={i}
                  className={`attempt ${a.result}`}
                  title={`${a.provider}: ${a.result}`}
                >
                  {a.provider}: {a.result}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function App() {
  const setup = useMutation(api.example.setup);

  return (
    <div className="app">
      <h1>T-Shirt Fulfillment</h1>
      <p className="subtitle">
        Orders try Printful first. If rejected, Printify. Then Gooten.
        <br />
        Toggle providers offline to see orders cascade to the next one.
      </p>

      <ProviderStatus />

      <button className="reset-btn" onClick={() => setup({})}>
        Reset
      </button>

      <OrderForm />
      <OrderFeed />

      <div className="panel code">
        <h2>What's happening</h2>
        <pre>{`// The building block. Pure logic, no IO.
async function tryProvider(tx, orderId, provider) {
  if (!await tx.read(\`provider:\${provider}:available\`))
    tx.retry();  // offline — skip to next

  const result = await tx.read(\`order:\${orderId}:\${provider}\`);
  if (result === null)      { tx.write(..., "submitted"); return provider; }
  if (result === "submitted") tx.retry();  // waiting for webhook
  if (result === "accepted")  return provider; // done!
  tx.retry();  // rejected — skip to next
}

// Try each provider in order. First available wins.
// If all fail, wait for ANY provider to change state.
await stm.atomic(ctx, async (tx) => {
  return await tx.select(
    async () => tryProvider(tx, orderId, "printful"),
    async () => tryProvider(tx, orderId, "printify"),
    async () => tryProvider(tx, orderId, "gooten"),
  );
});

// Provider API responds via webhook → writes the TVar
// → wakes the blocked order → re-runs select()
// → sees "rejected" → tries next provider automatically`}</pre>
      </div>
    </div>
  );
}

export default App;
