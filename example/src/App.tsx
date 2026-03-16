import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

const WAREHOUSES = [
  { key: "us-west", label: "US West", flag: "\uD83C\uDDFA\uD83C\uDDF8" },
  { key: "eu-central", label: "EU Central", flag: "\uD83C\uDDEA\uD83C\uDDFA" },
  { key: "asia-east", label: "Asia East", flag: "\uD83C\uDDEF\uD83C\uDDF5" },
];

function Stock() {
  const stock = useQuery(api.example.readStock) ?? {};
  return (
    <div className="stock">
      {WAREHOUSES.map((wh) => (
        <div key={wh.key} className="stock-item">
          <span className="stock-flag">{wh.flag}</span>
          <span className="stock-label">{wh.label}</span>
          <span
            className={`stock-value ${(stock[wh.key] ?? 0) === 0 ? "empty" : ""}`}
          >
            {stock[wh.key] ?? 0}
          </span>
        </div>
      ))}
    </div>
  );
}

function Orders() {
  const orders = useQuery(api.example.listOrders) ?? [];
  if (orders.length === 0) return null;
  return (
    <div className="orders">
      <h2>Orders</h2>
      {orders.map((o) => (
        <div key={o._id} className={`order ${o.status}`}>
          <span className="order-dot" />
          <span className="order-item">
            {o.amount}x {o.item}
          </span>
          <span className="order-status">{o.status}</span>
          {o.result && <span className="order-result">{o.result}</span>}
        </div>
      ))}
    </div>
  );
}

function BuyPanel() {
  const placeOrder = useMutation(api.example.placeOrder);
  const [status, setStatus] = useState<string | null>(null);

  const doBuy = async (warehouse: string) => {
    setStatus(null);
    const r = await placeOrder({ warehouse, amount: 1 });
    setStatus(
      r.immediate
        ? "Completed immediately"
        : `Waiting for ${warehouse} to restock...`,
    );
  };

  return (
    <div className="panel">
      <h2>Order from a specific warehouse</h2>
      <p className="hint">
        If the warehouse is empty, the order waits. When someone restocks it,
        the order completes automatically. No polling.
      </p>
      <div className="row">
        {WAREHOUSES.map((wh) => (
          <button key={wh.key} onClick={() => doBuy(wh.key)}>
            {wh.flag} Buy from {wh.label}
          </button>
        ))}
      </div>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function SelectPanel() {
  const buyFromAny = useMutation(api.example.buyFromAny);
  const [status, setStatus] = useState<string | null>(null);

  const doBuy = async () => {
    setStatus(null);
    const r = await buyFromAny({ amount: 1 });
    setStatus(
      r.immediate
        ? "Completed immediately"
        : "Waiting for ANY warehouse to restock...",
    );
  };

  return (
    <div className="panel highlight">
      <h2>Order from any warehouse</h2>
      <p className="hint">
        Tries US West first. If empty, tries EU Central. If empty, tries Asia
        East. If all are empty, the order waits and auto-completes when{" "}
        <strong>any</strong> of them gets restocked.
      </p>
      <div className="row">
        <button onClick={doBuy}>
          Buy from US {"\u2192"} EU {"\u2192"} Asia (first available)
        </button>
      </div>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function RestockPanel() {
  const restock = useMutation(api.example.restock);
  const [status, setStatus] = useState<string | null>(null);

  const doRestock = async (warehouse: string, amount: number) => {
    setStatus(null);
    await restock({ warehouse, amount });
    setStatus(`+${amount} to ${warehouse}. Waiting orders will auto-complete.`);
  };

  return (
    <div className="panel restock">
      <h2>Restock a warehouse</h2>
      <p className="hint">
        Adding stock wakes up any orders waiting for that warehouse.
        Watch the orders go from yellow to green.
      </p>
      <div className="row">
        {WAREHOUSES.map((wh) => (
          <button key={wh.key} onClick={() => doRestock(wh.key, 3)}>
            {wh.flag} +3
          </button>
        ))}
      </div>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function App() {
  const setup = useMutation(api.example.setup);

  return (
    <div className="app">
      <h1>Convex STM</h1>
      <p className="subtitle">
        Orders that wait for stock and auto-complete when it arrives.
        <br />
        No polling. No subscriptions. No plumbing.
      </p>

      <Stock />

      <button className="reset-btn" onClick={() => setup({})}>
        Reset everything
      </button>

      <Orders />

      <BuyPanel />
      <SelectPanel />
      <RestockPanel />

      <div className="panel code">
        <h2>The code</h2>
        <pre>{`// A reusable building block. Just a function.
async function buyFrom(tx, warehouse, amount) {
  const stock = await tx.read(warehouse);
  if (stock < amount) tx.retry();   // wait until restocked
  tx.write(warehouse, stock - amount);
}

// Order from a specific warehouse.
// If empty, the order waits and auto-completes on restock.
await stm.atomic(ctx, async (tx) => {
  await buyFrom(tx, "us-west", 1);
});

// Order from any warehouse. Tries each in order.
// If all empty, waits for ANY of them to restock.
await stm.atomic(ctx, async (tx) => {
  return await tx.select(
    async () => { await buyFrom(tx, "us-west", 1);    return "us-west"; },
    async () => { await buyFrom(tx, "eu-central", 1); return "eu-central"; },
    async () => { await buyFrom(tx, "asia-east", 1);  return "asia-east"; },
  );
});`}</pre>
      </div>
    </div>
  );
}

export default App;
