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

// ── Walkthrough ───────────────────────────────────────────────────────

const STEPS = [
  {
    title: "Meet the providers",
    body: "Three print providers, each making different products. Click any provider card to toggle it on/off. The slider controls how often it rejects orders.",
    action: null,
    setup: { printful: { rate: 0 }, printify: { rate: 0 }, gooten: { rate: 0 } },
  },
  {
    title: "Order a shirt",
    body: "With 0% failure, every provider accepts. Watch the order go pending \u2192 submitted \u2192 fulfilled in ~1 second.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: null,
  },
  {
    title: "Make Printful unreliable",
    body: "Set Printful to 100% failure. Now order a shirt \u2014 Printful rejects it, and STM automatically falls through to Printify.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: { printful: { rate: 100 } },
  },
  {
    title: "Order all three items",
    body: "Shirt + mug + poster. No single provider makes all three. STM splits the order across providers. With Printful failing, shirts go to Printify, mugs to Gooten.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: null,
  },
  {
    title: "Make everything unreliable",
    body: "Set all providers to 80% failure. Orders will bounce between providers, retrying until one accepts each item. Watch the attempt badges pile up.",
    action: { type: "order" as const, items: ["shirt", "mug"] },
    setup: { printful: { rate: 80 }, printify: { rate: 80 }, gooten: { rate: 80 } },
  },
  {
    title: "Take a provider offline",
    body: "Toggle Printful offline entirely. It won't even be tried. Orders route around it. Turn it back on and pending orders auto-retry.",
    action: { type: "toggle" as const, provider: "printful" },
    setup: null,
  },
  {
    title: "The code",
    body: "Each item gets a select() across its capable providers. The whole cart is one atomic transaction. 6 lines of code handle all the routing, retrying, and waiting.",
    action: null,
    setup: { printful: { rate: 0 }, printify: { rate: 0 }, gooten: { rate: 0 } },
  },
];

function Walkthrough({
  onOrder,
  onToggle,
  onSetRate,
}: {
  onOrder: (items: string[]) => void;
  onToggle: (provider: string) => void;
  onSetRate: (provider: string, rate: number) => void;
}) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];

  const goTo = (i: number) => {
    const s = STEPS[i];
    if (s.setup) {
      for (const [p, cfg] of Object.entries(s.setup)) {
        if ("rate" in cfg) onSetRate(p, cfg.rate);
      }
    }
    setStep(i);
  };

  const doAction = () => {
    if (!current.action) return;
    if (current.action.type === "order") onOrder(current.action.items!);
    if (current.action.type === "toggle") onToggle(current.action.provider!);
  };

  return (
    <div className="walkthrough">
      <div className="walk-header">
        <span className="walk-step">
          {step + 1}/{STEPS.length}
        </span>
        <span className="walk-title">{current.title}</span>
      </div>
      <p className="walk-body">{current.body}</p>
      <div className="walk-actions">
        <button className="walk-btn secondary" onClick={() => goTo(Math.max(0, step - 1))} disabled={step === 0}>
          Back
        </button>
        {current.action && (
          <button className="walk-btn primary" onClick={doAction}>
            {current.action.type === "order"
              ? `Order ${current.action.items!.join(" + ")}`
              : `Toggle ${current.action.provider}`}
          </button>
        )}
        <button className="walk-btn secondary" onClick={() => goTo(Math.min(STEPS.length - 1, step + 1))} disabled={step === STEPS.length - 1}>
          Next
        </button>
      </div>
      <div className="walk-dots">
        {STEPS.map((_, i) => (
          <span key={i} className={`walk-dot ${i === step ? "active" : ""}`} onClick={() => goTo(i)} />
        ))}
      </div>
    </div>
  );
}

// ── Provider cards with failure rate ──────────────────────────────────

function ProviderStatus() {
  const providers = useQuery(api.example.readProviders) ?? {};
  const toggle = useMutation(api.example.toggleProvider);
  const setRate = useMutation(api.example.setFailRate);

  return (
    <div className="providers">
      {Object.entries(providers).map(([name, info]) => {
        const p = info as { available: boolean; products: string[]; failRate: number };
        return (
          <div key={name} className={`provider-card ${p.available ? "online" : "offline"}`} style={{ borderColor: p.available ? PROVIDER_COLORS[name] : "#333" }}>
            <div className="provider-top" onClick={() => toggle({ provider: name })}>
              <span className="provider-dot" style={{ background: p.available ? PROVIDER_COLORS[name] : "#555" }} />
              <span className="provider-name">{name}</span>
              <span className="provider-products">
                {p.products.map((pr) => PRODUCTS.find((x) => x.key === pr)?.emoji).join(" ")}
              </span>
              <span className="provider-status">{p.available ? "online" : "offline"}</span>
            </div>
            {p.available && (
              <div className="fail-rate">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={p.failRate}
                  onChange={(e) => setRate({ provider: name, rate: Number(e.target.value) })}
                  className="slider"
                  style={{ accentColor: PROVIDER_COLORS[name] }}
                />
                <span className="fail-label">{p.failRate}% fail</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Order form ────────────────────────────────────────────────────────

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
          <button key={p.key} className={`cart-item ${cart.has(p.key) ? "selected" : ""}`} onClick={() => toggleItem(p.key)}>
            <span className="cart-emoji">{p.emoji}</span>
            <span>{p.key}</span>
          </button>
        ))}
      </div>
      <button onClick={() => placeOrder({ items: [...cart] })} disabled={cart.size === 0}>
        Order {[...cart].join(" + ")}
      </button>
    </div>
  );
}

// ── Order feed ────────────────────────────────────────────────────────

function OrderFeed() {
  const orders = useQuery(api.example.listOrders) ?? [];
  if (orders.length === 0) return <div className="orders empty">No orders yet. Use the walkthrough or place one.</div>;

  return (
    <div className="orders">
      <h2>Orders</h2>
      {orders.map((o) => (
        <div key={o._id} className={`order ${o.status}`}>
          <div className="order-header">
            <span className="order-dot" />
            <span className="order-item">
              {o.items.map((i: string) => PRODUCTS.find((p) => p.key === i)?.emoji).join("+")}
            </span>
            <span className="order-status">{o.status}</span>
          </div>
          {o.assignments && (
            <div className="assignments">
              {Object.entries(o.assignments as Record<string, string>).map(([item, provider]) => (
                <span key={item} className="assignment" style={{ borderColor: PROVIDER_COLORS[provider] }}>
                  {PRODUCTS.find((p) => p.key === item)?.emoji} via {provider}
                </span>
              ))}
            </div>
          )}
          {o.attempts.length > 0 && (
            <div className="attempts">
              {o.attempts.map((a: any, i: number) => (
                <span key={i} className={`attempt ${a.result}`}>
                  {PRODUCTS.find((p) => p.key === a.item)?.emoji}{a.provider.slice(0, 4)}: {a.result === "accepted" ? "\u2713" : "\u2717"}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── App layout ────────────────────────────────────────────────────────

function App() {
  const setup = useMutation(api.example.setup);
  const placeOrder = useMutation(api.example.placeOrder);
  const toggle = useMutation(api.example.toggleProvider);
  const setRate = useMutation(api.example.setFailRate);

  return (
    <div className="app">
      <h1>Convex STM</h1>
      <p className="subtitle">Multi-item fulfillment across providers</p>

      <Walkthrough
        onOrder={(items) => placeOrder({ items })}
        onToggle={(provider) => toggle({ provider })}
        onSetRate={(provider, rate) => setRate({ provider, rate })}
      />

      <div className="two-col">
        <div className="col-left">
          <ProviderStatus />
          <OrderForm />
          <button className="reset-btn" onClick={() => setup({})}>
            Reset everything
          </button>
          <div className="panel code">
            <h2>The code</h2>
            <pre>{`await stm.atomic(ctx, async (tx) => {
  for (const item of cart) {
    await tx.select(
      ...providersFor(item).map(p =>
        async () => {
          await tryProvider(tx, id, item, p);
          return p;
        }
      ),
    );
  }
});`}</pre>
          </div>
        </div>
        <div className="col-right">
          <OrderFeed />
        </div>
      </div>
    </div>
  );
}

export default App;
