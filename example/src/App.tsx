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

// ── Guided walkthrough steps ──────────────────────────────────────────

const STEPS = [
  {
    title: "The catalog",
    body: "Three providers, each making different products. No single provider makes everything.",
    action: null,
    highlight: "providers",
  },
  {
    title: "Order one item",
    body: "Order a shirt. The STM transaction tries Printful first (it makes shirts). Printful's simulated API takes 1-3 seconds to respond. Watch the order go from pending \u2192 submitted \u2192 fulfilled.",
    action: { type: "order", items: ["shirt"] },
    highlight: "orders",
  },
  {
    title: "Order all three",
    body: "Now order shirt + mug + poster. No single provider makes all three, so STM splits the order: shirt from one provider, mug from another, poster from a third. All three must succeed \u2014 or the whole order waits.",
    action: { type: "order", items: ["shirt", "mug", "poster"] },
    highlight: "orders",
  },
  {
    title: "Take Printful offline",
    body: "Click Printful to take it offline. Shirts can now only come from Printify. Mugs can only come from Gooten. Try ordering shirt + mug and watch it route around the outage.",
    action: { type: "toggle", provider: "printful" },
    highlight: "providers",
  },
  {
    title: "Order during outage",
    body: "With Printful offline, order shirt + mug. The STM transaction skips Printful automatically \u2014 shirt goes to Printify, mug to Gooten.",
    action: { type: "order", items: ["shirt", "mug"] },
    highlight: "orders",
  },
  {
    title: "Bring Printful back",
    body: "Click Printful to bring it back online. Any pending orders that were stuck waiting for Printful will automatically retry and complete.",
    action: { type: "toggle", provider: "printful" },
    highlight: "providers",
  },
  {
    title: "The code",
    body: "That's it. Each item gets a select() across its capable providers. The whole cart is one atomic transaction. Blocking, retrying, and waking are handled by STM \u2014 not by you.",
    action: null,
    highlight: "code",
  },
];

function Walkthrough({
  onOrder,
  onToggle,
}: {
  onOrder: (items: string[]) => void;
  onToggle: (provider: string) => void;
}) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];

  const doAction = () => {
    if (!current.action) return;
    if (current.action.type === "order") onOrder(current.action.items!);
    if (current.action.type === "toggle") onToggle(current.action.provider!);
  };

  return (
    <div className="walkthrough">
      <div className="walk-header">
        <span className="walk-step">
          Step {step + 1} of {STEPS.length}
        </span>
        <span className="walk-title">{current.title}</span>
      </div>
      <p className="walk-body">{current.body}</p>
      <div className="walk-actions">
        <button
          className="walk-btn secondary"
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0}
        >
          Back
        </button>
        {current.action && (
          <button className="walk-btn primary" onClick={doAction}>
            {current.action.type === "order"
              ? `Order ${(current.action as any).items.join(" + ")}`
              : `Toggle ${(current.action as any).provider}`}
          </button>
        )}
        <button
          className="walk-btn secondary"
          onClick={() => setStep(Math.min(STEPS.length - 1, step + 1))}
          disabled={step === STEPS.length - 1}
        >
          Next
        </button>
      </div>
      <div className="walk-dots">
        {STEPS.map((_, i) => (
          <span
            key={i}
            className={`walk-dot ${i === step ? "active" : ""}`}
            onClick={() => setStep(i)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────

function ProviderStatus() {
  const providers = useQuery(api.example.readProviders) ?? {};
  const toggle = useMutation(api.example.toggleProvider);

  return (
    <div className="providers" id="providers">
      {Object.entries(providers).map(([name, info]) => {
        const p = info as { available: boolean; products: string[] };
        return (
          <button
            key={name}
            className={`provider-card ${p.available ? "online" : "offline"}`}
            style={{ borderColor: p.available ? PROVIDER_COLORS[name] : "#333" }}
            onClick={() => toggle({ provider: name })}
          >
            <span
              className="provider-dot"
              style={{
                background: p.available ? PROVIDER_COLORS[name] : "#555",
              }}
            />
            <span className="provider-name">{name}</span>
            <span className="provider-products">
              {p.products
                .map((pr) => PRODUCTS.find((x) => x.key === pr)?.emoji)
                .join(" ")}
            </span>
            <span className="provider-status">
              {p.available ? "online" : "offline"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function OrderForm() {
  const placeOrder = useMutation(api.example.placeOrder);
  const [cart, setCart] = useState<Set<string>>(new Set(["shirt"]));

  const toggleItem = (item: string) => {
    setCart((prev) => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  };

  return (
    <div className="panel">
      <h2>Build Your Order</h2>
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
      <button
        onClick={() => placeOrder({ items: [...cart] })}
        disabled={cart.size === 0}
      >
        Order {[...cart].join(" + ")}
      </button>
    </div>
  );
}

function OrderFeed() {
  const orders = useQuery(api.example.listOrders) ?? [];
  if (orders.length === 0) return null;

  return (
    <div className="orders" id="orders">
      <h2>Orders</h2>
      {orders.map((o) => (
        <div key={o._id} className={`order ${o.status}`}>
          <div className="order-header">
            <span className="order-dot" />
            <span className="order-item">
              {o.items
                .map((i: string) => PRODUCTS.find((p) => p.key === i)?.emoji)
                .join(" + ")}{" "}
              {o.items.join(" + ")}
            </span>
            <span className="order-status">{o.status}</span>
          </div>
          {o.assignments && (
            <div className="assignments">
              {Object.entries(
                o.assignments as Record<string, string>,
              ).map(([item, provider]) => (
                <span
                  key={item}
                  className="assignment"
                  style={{ borderColor: PROVIDER_COLORS[provider] }}
                >
                  {PRODUCTS.find((p) => p.key === item)?.emoji} {item} via{" "}
                  {provider}
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
  const placeOrder = useMutation(api.example.placeOrder);
  const toggle = useMutation(api.example.toggleProvider);

  return (
    <div className="app">
      <h1>Convex STM</h1>
      <p className="subtitle">Multi-item fulfillment across providers</p>

      <Walkthrough
        onOrder={(items) => placeOrder({ items })}
        onToggle={(provider) => toggle({ provider })}
      />

      <ProviderStatus />

      <button className="reset-btn" onClick={() => setup({})}>
        Reset
      </button>

      <OrderForm />
      <OrderFeed />

      <div className="panel code" id="code">
        <h2>The code</h2>
        <pre>{`// Each item selects from its capable providers.
// All items must succeed — or the whole cart waits.

await stm.atomic(ctx, async (tx) => {
  for (const item of cart) {
    await tx.select(
      ...providersFor(item).map(p => async () =>
        await tryProvider(tx, orderId, item, p)
      ),
    );
  }
});

// tryProvider reads provider health + order state.
// If offline → retry (skip, watch for change).
// If rejected → retry (try next provider).
// If accepted → done!
// If not tried yet → submit to provider API.

// Printful makes:  shirt, mug
// Printify makes:  shirt, poster
// Gooten makes:    mug, poster`}</pre>
      </div>
    </div>
  );
}

export default App;
