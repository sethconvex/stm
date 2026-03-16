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

type SetupCfg = Record<string, { rate?: number; timeout?: number }>;

const STEPS = [
  {
    title: "Meet the providers",
    body: "Three print providers, each making different products. Click a card to toggle online/offline. Sliders control failure rate and response timeout.",
    action: null,
    setup: {
      printful: { rate: 0, timeout: 5000 },
      printify: { rate: 0, timeout: 5000 },
      gooten: { rate: 0, timeout: 5000 },
    } as SetupCfg,
  },
  {
    title: "Order a shirt",
    body: "0% failure, 5s timeout. Printful responds fast and accepts. Watch it go pending \u2192 submitted \u2192 fulfilled.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: null,
  },
  {
    title: "Printful always fails",
    body: "Printful at 100% failure. Order a shirt \u2014 Printful rejects, STM cascades to Printify automatically.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: { printful: { rate: 100 } } as SetupCfg,
  },
  {
    title: "Order the full catalog",
    body: "Shirt + mug + poster. No single provider makes all three. STM splits the cart. With Printful failing: shirt \u2192 Printify, mug \u2192 Gooten, poster \u2192 Printify or Gooten.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: null,
  },
  {
    title: "Slow provider \u2192 timeout",
    body: "Set Printful to 0% failure but 1s timeout. Printful is reliable but SLOW \u2014 it takes up to 2s to respond. Half the time it times out and STM cascades to the next provider.",
    action: { type: "order" as const, items: ["shirt", "mug"] },
    setup: {
      printful: { rate: 0, timeout: 1000 },
      printify: { rate: 0, timeout: 5000 },
      gooten: { rate: 0, timeout: 5000 },
    } as SetupCfg,
  },
  {
    title: "Chaos mode",
    body: "All providers: 60% failure, 2s timeout. Orders bounce between providers, timing out and retrying. Despite the chaos, every order eventually gets fulfilled.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: {
      printful: { rate: 60, timeout: 2000 },
      printify: { rate: 60, timeout: 2000 },
      gooten: { rate: 60, timeout: 2000 },
    } as SetupCfg,
  },
  {
    title: "The code",
    body: "All of this \u2014 routing, failover, timeouts, retries, atomic carts \u2014 is handled by 6 lines of STM code. No state machines. No event plumbing.",
    action: null,
    setup: {
      printful: { rate: 0, timeout: 5000 },
      printify: { rate: 0, timeout: 5000 },
      gooten: { rate: 0, timeout: 5000 },
    } as SetupCfg,
  },
];

function Walkthrough({
  onOrder,
  onToggle,
  onSetRate,
  onSetTimeout,
}: {
  onOrder: (items: string[]) => void;
  onToggle: (provider: string) => void;
  onSetRate: (provider: string, rate: number) => void;
  onSetTimeout: (provider: string, timeout: number) => void;
}) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];

  const goTo = (i: number) => {
    const s = STEPS[i];
    if (s.setup) {
      for (const [p, cfg] of Object.entries(s.setup)) {
        if (cfg.rate !== undefined) onSetRate(p, cfg.rate);
        if (cfg.timeout !== undefined) onSetTimeout(p, cfg.timeout);
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
        <span className="walk-step">{step + 1}/{STEPS.length}</span>
        <span className="walk-title">{current.title}</span>
      </div>
      <p className="walk-body">{current.body}</p>
      <div className="walk-actions">
        <button className="walk-btn secondary" onClick={() => goTo(Math.max(0, step - 1))} disabled={step === 0}>Back</button>
        {current.action && (
          <button className="walk-btn primary" onClick={doAction}>
            {current.action.type === "order"
              ? `Order ${current.action.items!.join(" + ")}`
              : `Toggle ${current.action.provider}`}
          </button>
        )}
        <button className="walk-btn secondary" onClick={() => goTo(Math.min(STEPS.length - 1, step + 1))} disabled={step === STEPS.length - 1}>Next</button>
      </div>
      <div className="walk-dots">
        {STEPS.map((_, i) => (
          <span key={i} className={`walk-dot ${i === step ? "active" : ""}`} onClick={() => goTo(i)} />
        ))}
      </div>
    </div>
  );
}

function ProviderStatus() {
  const providers = useQuery(api.example.readProviders) ?? {};
  const toggle = useMutation(api.example.toggleProvider);
  const setRate = useMutation(api.example.setFailRate);
  const setTO = useMutation(api.example.setTimeout);

  return (
    <div className="providers">
      {Object.entries(providers).map(([name, info]) => {
        const p = info as { available: boolean; products: string[]; failRate: number; timeout: number };
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
              <div className="sliders">
                <div className="slider-row">
                  <span className="slider-label">Fail</span>
                  <input type="range" min={0} max={100} value={p.failRate}
                    onChange={(e) => setRate({ provider: name, rate: Number(e.target.value) })}
                    style={{ accentColor: PROVIDER_COLORS[name] }} />
                  <span className="slider-value">{p.failRate}%</span>
                </div>
                <div className="slider-row">
                  <span className="slider-label">Timeout</span>
                  <input type="range" min={500} max={10000} step={500} value={p.timeout}
                    onChange={(e) => setTO({ provider: name, timeout: Number(e.target.value) })}
                    style={{ accentColor: PROVIDER_COLORS[name] }} />
                  <span className="slider-value">{(p.timeout / 1000).toFixed(1)}s</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OrderForm() {
  const placeOrder = useMutation(api.example.placeOrder);
  const [cart, setCart] = useState<Set<string>>(new Set(["shirt"]));

  const toggleItem = (item: string) => {
    setCart((prev) => { const n = new Set(prev); if (n.has(item)) n.delete(item); else n.add(item); return n; });
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

function OrderFeed() {
  const orders = useQuery(api.example.listOrders) ?? [];
  if (orders.length === 0) return <div className="orders empty">No orders yet</div>;

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
                  {PRODUCTS.find((p) => p.key === a.item)?.emoji}{a.provider}:{a.result === "accepted" ? "\u2713" : a.result === "timeout" ? "\u23F1" : "\u2717"}
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
  const setRate = useMutation(api.example.setFailRate);
  const setTO = useMutation(api.example.setTimeout);

  return (
    <div className="app">
      <h1>Convex STM</h1>
      <p className="subtitle">Multi-item fulfillment with failover, timeouts, and retries</p>

      <Walkthrough
        onOrder={(items) => placeOrder({ items })}
        onToggle={(p) => toggle({ provider: p })}
        onSetRate={(p, r) => setRate({ provider: p, rate: r })}
        onSetTimeout={(p, t) => setTO({ provider: p, timeout: t })}
      />

      <div className="two-col">
        <div className="col-left">
          <ProviderStatus />
          <OrderForm />
          <button className="reset-btn" onClick={() => setup({})}>Reset</button>
          <div className="panel code">
            <h2>The code</h2>
            <pre>{`// Each item selects from capable providers.
// All items must succeed atomically.
// Failures, timeouts, and retries are automatic.

await stm.atomic(ctx, async (tx) => {
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
