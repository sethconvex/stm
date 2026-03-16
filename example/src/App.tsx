import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

function Stock() {
  const stock = useQuery(api.example.readStock) ?? { widgets: 0, gadgets: 0 };
  return (
    <div className="stock">
      <div className="stock-item">
        <span className="stock-label">Widgets</span>
        <span className={`stock-value ${stock.widgets === 0 ? "empty" : ""}`}>
          {stock.widgets}
        </span>
      </div>
      <div className="stock-item">
        <span className="stock-label">Gadgets</span>
        <span className={`stock-value ${stock.gadgets === 0 ? "empty" : ""}`}>
          {stock.gadgets}
        </span>
      </div>
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

  const doBuy = async (item: string) => {
    setStatus(null);
    const r = await placeOrder({ item, amount: 1 });
    setStatus(
      r.immediate
        ? `Order completed immediately`
        : `Order pending — will auto-complete when ${item} restocked`,
    );
  };

  return (
    <div className="panel">
      <h2>Buy (retry)</h2>
      <p className="hint">
        Places an order. If stock is 0, the order goes <strong>pending</strong>{" "}
        and <strong>automatically completes</strong> when restocked. No polling.
        No subscriptions. The STM retry{"\u2192"}wake loop handles it.
      </p>
      <div className="row">
        <button onClick={() => doBuy("widgets")}>Buy 1 Widget</button>
        <button onClick={() => doBuy("gadgets")}>Buy 1 Gadget</button>
      </div>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function OrElsePanel() {
  const buyFromEither = useMutation(api.example.buyFromEither);
  const [status, setStatus] = useState<string | null>(null);

  const doBuy = async () => {
    setStatus(null);
    const r = await buyFromEither({ a: "widgets", b: "gadgets", amount: 1 });
    setStatus(
      r.immediate
        ? `Order completed immediately`
        : `Order pending — will auto-complete when EITHER is restocked`,
    );
  };

  return (
    <div className="panel highlight">
      <h2>Buy from Either (orElse)</h2>
      <p className="hint">
        "Buy a widget. If out of stock, buy a gadget instead." Each branch can
        block independently. <strong>orElse</strong> composes them — tries
        widgets first, rolls back, tries gadgets. If both are empty, blocks on
        the <strong>union</strong> of both watch sets. Restocking either one
        wakes the order.
      </p>
      <button onClick={doBuy}>Buy Widget orElse Gadget</button>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function RestockPanel() {
  const restock = useMutation(api.example.restock);
  const [status, setStatus] = useState<string | null>(null);

  const doRestock = async (item: string, amount: number) => {
    setStatus(null);
    await restock({ item, amount });
    setStatus(`Restocked ${amount} ${item} — pending orders will auto-complete`);
  };

  return (
    <div className="panel restock">
      <h2>Restock (this wakes blocked orders)</h2>
      <p className="hint">
        Adding stock writes to TVars. The STM commit finds waiters and fires
        their callbacks. Pending orders re-run their transactions and complete.
        Watch the orders above go from pending {"\u2192"} completed.
      </p>
      <div className="row">
        <button onClick={() => doRestock("widgets", 3)}>
          +3 Widgets
        </button>
        <button onClick={() => doRestock("gadgets", 3)}>
          +3 Gadgets
        </button>
        <button onClick={() => doRestock("widgets", 1)}>
          +1 Widget
        </button>
        <button onClick={() => doRestock("gadgets", 1)}>
          +1 Gadget
        </button>
      </div>
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function App() {
  const setup = useMutation(api.example.setup);

  return (
    <div className="app">
      <h1>STM: retry {"\u2192"} wake</h1>
      <p className="subtitle">
        Orders block when out of stock and <strong>auto-complete</strong> when
        restocked. No polling. That's what mutations can't do.
      </p>

      <Stock />

      <button className="reset-btn" onClick={() => setup({})}>
        Reset (stock to 0, clear orders)
      </button>

      <Orders />

      <BuyPanel />
      <OrElsePanel />
      <RestockPanel />

      <div className="panel code">
        <h2>How It Works</h2>
        <pre>{`// The building block. A plain function.
async function buy(tx, item, amount) {
  const stock = await tx.read(item);
  if (stock < amount) tx.retry();  // ← blocks until stock changes
  tx.write(item, stock - amount);
}

// Place an order. If stock=0, the order goes "pending".
// The onRetry callback is stored in the DB as a waiter.
await stm.atomic(ctx, async (tx) => {
  await buy(tx, "widgets", 1);
}, { callbackHandle: retryOrder, callbackArgs: { orderId } });

// Restock. commit() writes the TVar, finds waiters, fires callbacks.
// retryOrder re-runs the transaction. This time stock > 0 → commits.
await stm.atomic(ctx, async (tx) => {
  const stock = await tx.read("widgets");
  tx.write("widgets", stock + 5);
});

// orElse: buy widget, else gadget. Blocks on BOTH watch sets.
// Restocking EITHER one wakes the order.
await stm.atomic(ctx, async (tx) => {
  return await tx.orElse(
    async () => { await buy(tx, "widgets", 1); return "widgets"; },
    async () => { await buy(tx, "gadgets", 1); return "gadgets"; },
  );
}, { callbackHandle, callbackArgs });`}</pre>
      </div>
    </div>
  );
}

export default App;
