import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

const PRODUCTS = [
  { key: "shirt", emoji: "\uD83D\uDC55" },
  { key: "mug", emoji: "\u2615" },
  { key: "poster", emoji: "\uD83D\uDDBC\uFE0F" },
];

const PROVIDER_COLORS: Record<string, string> = {
  printful: "#2563eb",
  printify: "#16a34a",
  gooten: "#9333ea",
};

function ProviderStatus() {
  const providers = useQuery(api.example.readProviders) ?? {};
  const toggle = useMutation(api.example.toggleProvider);

  return (
    <div className="providers">
      {Object.entries(providers).map(([name, info]) => {
        const p = info as { available: boolean; products: string[] };
        return (
          <button
            key={name}
            className={`provider-card ${p.available ? "online" : "offline"}`}
            style={{ borderColor: p.available ? PROVIDER_COLORS[name] : "#333" }}
            onClick={() => toggle({ provider: name })}
          >
            <span className="provider-dot" style={{ background: p.available ? PROVIDER_COLORS[name] : "#555" }} />
            <span className="provider-name">{name}</span>
            <span className="provider-products">
              {p.products.map((pr) => PRODUCTS.find((x) => x.key === pr)?.emoji).join(" ")}
            </span>
            <span className="provider-status">{p.available ? "online" : "offline"}</span>
          </button>
        );
      })}
    </div>
  );
}

function OrderForm() {
  const placeOrder = useMutation(api.example.placeOrder);
  const [cart, setCart] = useState<Set<string>>(new Set(["shirt"]));
  const [status, setStatus] = useState<string | null>(null);

  const toggleItem = (item: string) => {
    setCart((prev) => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  };

  const doOrder = async () => {
    if (cart.size === 0) return;
    setStatus(null);
    await placeOrder({ items: [...cart] });
    setStatus(`Order placed for ${[...cart].join(" + ")}!`);
  };

  return (
    <div className="panel">
      <h2>Build Your Order</h2>
      <p className="hint">
        Pick multiple items. Each item is sourced from a provider that makes it.
        The whole cart is fulfilled atomically — all items succeed or none do.
      </p>
      <div className="cart-picker">
        {PRODUCTS.map((p) => (
          <button
            key={p.key}
            className={`cart-item ${cart.has(p.key) ? "selected" : ""}`}
            onClick={() => toggleItem(p.key)}
          >
            <span className="cart-emoji">{p.emoji}</span>
            <span>{p.key}</span>
          </button>
        ))}
      </div>
      <button onClick={doOrder} disabled={cart.size === 0}>
        Order {[...cart].join(" + ")}
      </button>
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
              {o.items.map((i: string) => PRODUCTS.find((p) => p.key === i)?.emoji).join(" + ")}{" "}
              {o.items.join(" + ")}
            </span>
            <span className="order-status">{o.status}</span>
          </div>
          {o.assignments && (
            <div className="assignments">
              {Object.entries(o.assignments as Record<string, string>).map(([item, provider]) => (
                <span key={item} className="assignment" style={{ borderColor: PROVIDER_COLORS[provider] }}>
                  {PRODUCTS.find((p) => p.key === item)?.emoji} {item} via {provider}
                </span>
              ))}
            </div>
          )}
          {o.attempts.length > 0 && (
            <div className="attempts">
              {o.attempts.map((a: any, i: number) => (
                <span key={i} className={`attempt ${a.result}`}>
                  {a.item}@{a.provider}: {a.result}
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
      <h1>Multi-Item Fulfillment</h1>
      <p className="subtitle">
        Each provider makes different products. Orders are split across
        providers <strong>atomically</strong> — all items succeed or none do.
      </p>

      <ProviderStatus />

      <button className="reset-btn" onClick={() => setup({})}>
        Reset
      </button>

      <OrderForm />
      <OrderFeed />

      <div className="panel code">
        <h2>Why this needs STM</h2>
        <pre>{`// No single provider makes shirt + mug + poster.
// The STM transaction sources EACH item from a capable provider.
// If any item can't be fulfilled, the WHOLE order waits.

await stm.atomic(ctx, async (tx) => {
  for (const item of ["shirt", "mug", "poster"]) {
    // select: try each capable provider for this item
    await tx.select(
      ...providersFor(item).map(p => async () => {
        await tryProvider(tx, orderId, item, p);
      })
    );
  }
});

// Printful makes:  shirt, mug
// Printify makes:  shirt, poster
// Gooten makes:    mug, poster

// "shirt + poster" → shirt from Printful, poster from Printify ✓
// "shirt + mug + poster" → split across all three providers ✓
// Turn Printful offline → shirt falls to Printify,
//   mug falls to Gooten. Automatically. No code changes.`}</pre>
      </div>
    </div>
  );
}

export default App;
