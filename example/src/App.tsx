import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState, useEffect } from "react";

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

type ProviderCfg = { online: boolean; rate: number; timeout: number };
type SetupCfg = Record<string, ProviderCfg>;

const ALL_ON: SetupCfg = {
  printful: { online: true, rate: 0, timeout: 5000 },
  printify: { online: true, rate: 0, timeout: 5000 },
  gooten:   { online: true, rate: 0, timeout: 5000 },
};

const STEPS = [
  {
    title: "Meet the providers",
    body: "Three print providers, each making different products. Printful makes shirts + mugs. Printify makes shirts + posters. Gooten makes mugs + posters. Click a card to toggle online/offline.",
    action: null,
    setup: ALL_ON,
  },
  {
    title: "Order a shirt",
    body: "All providers online, 0% failure. Printful is tried first (it makes shirts). Watch the order go pending \u2192 submitted \u2192 fulfilled.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: ALL_ON,
  },
  {
    title: "Printful always rejects",
    body: "Printful at 100% failure. Order a shirt \u2014 Printful rejects, STM automatically cascades to Printify.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: {
      printful: { online: true, rate: 100, timeout: 5000 },
      printify: { online: true, rate: 0, timeout: 5000 },
      gooten:   { online: true, rate: 0, timeout: 5000 },
    },
  },
  {
    title: "Split across providers",
    body: "Shirt + mug + poster. No single provider makes all three. With Printful rejecting: shirt \u2192 Printify, mug \u2192 Gooten, poster \u2192 Printify or Gooten. All atomic.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: {
      printful: { online: true, rate: 100, timeout: 5000 },
      printify: { online: true, rate: 0, timeout: 5000 },
      gooten:   { online: true, rate: 0, timeout: 5000 },
    },
  },
  {
    title: "Printful is offline",
    body: "Printful is completely offline \u2014 not even tried. Shirts can only come from Printify, mugs from Gooten. Order shirt + mug and watch it route around.",
    action: { type: "order" as const, items: ["shirt", "mug"] },
    setup: {
      printful: { online: false, rate: 0, timeout: 5000 },
      printify: { online: true, rate: 0, timeout: 5000 },
      gooten:   { online: true, rate: 0, timeout: 5000 },
    },
  },
  {
    title: "We stop waiting",
    body: "All online, but we only wait 1s for Printful. Providers take 1-5s to respond \u2014 so Printful often times out (\u23F1) and we move on to the next provider. The provider doesn't know we gave up.",
    action: { type: "order" as const, items: ["shirt", "mug"] },
    setup: {
      printful: { online: true, rate: 0, timeout: 1000 },
      printify: { online: true, rate: 0, timeout: 5000 },
      gooten:   { online: true, rate: 0, timeout: 5000 },
    },
  },
  {
    title: "Chaos mode",
    body: "All providers: 60% failure, 2s timeout. Orders bounce between providers, timing out and retrying. Watch the attempt badges pile up. Despite the chaos, every order eventually ships.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: {
      printful: { online: true, rate: 60, timeout: 2000 },
      printify: { online: true, rate: 60, timeout: 2000 },
      gooten:   { online: true, rate: 60, timeout: 2000 },
    },
  },
  {
    title: "The code",
    body: "Routing, failover, timeouts, retries, atomic multi-item carts \u2014 all handled by a select() per item inside one atomic transaction. No state machines. No event plumbing.",
    action: null,
    setup: ALL_ON,
  },
];

function Walkthrough({
  onOrder,
  onSetRate,
  onSetTimeout,
  onSetAvailable,
}: {
  onOrder: (items: string[]) => void;
  onSetRate: (provider: string, rate: number) => void;
  onSetTimeout: (provider: string, timeout: number) => void;
  onSetAvailable: (provider: string, available: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [applied, setApplied] = useState(false);
  const current = STEPS[step];

  const applySetup = (s: (typeof STEPS)[number]) => {
    if (!s.setup) return;
    for (const [p, cfg] of Object.entries(s.setup)) {
      onSetAvailable(p, cfg.online);
      onSetRate(p, cfg.rate);
      onSetTimeout(p, cfg.timeout);
    }
  };

  // Apply setup on mount for step 0
  useEffect(() => {
    if (!applied) {
      applySetup(STEPS[0]);
      setApplied(true);
    }
  }, [applied]);

  const goTo = (i: number) => {
    applySetup(STEPS[i]);
    setStep(i);
  };

  const doAction = () => {
    if (!current.action) return;
    if (current.action.type === "order") onOrder(current.action.items!);
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
                  <span className="slider-label">Wait</span>
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
  const setAvail = useMutation(api.example.setAvailable);

  return (
    <div className="app">
      <h1>Convex STM</h1>
      <p className="subtitle">Multi-item fulfillment with failover, timeouts, and retries</p>

      <Walkthrough
        onOrder={(items) => placeOrder({ items })}
        onSetRate={(p, r) => setRate({ provider: p, rate: r })}
        onSetTimeout={(p, t) => setTO({ provider: p, timeout: t })}
        onSetAvailable={(p, a) => setAvail({ provider: p, available: a })}
      />

      <div className="two-col">
        <div className="col-left">
          <ProviderStatus />
          <OrderForm />
          <button className="reset-btn" onClick={() => setup({})}>Reset</button>
          <div className="panel code">
            <h2>The code</h2>
            <pre>{`// 1. Submit to ALL providers for each item simultaneously.
async function raceProviders(tx, orderId, item) {
  // Already have a winner?
  const winner = await tx.read(\`order:\${orderId}:\${item}:winner\`);
  if (winner) return { done: true, provider: winner };

  // Submit to every available provider at once
  for (const p of providersFor(item)) {
    if (!await tx.read(\`provider:\${p}:available\`)) continue;
    if (await tx.read(\`order:\${orderId}:\${item}:\${p}\`) === null)
      tx.write(\`order:\${orderId}:\${item}:\${p}\`, "submitted");
  }
  tx.retry();  // wait for first response
}

// 2. When a provider responds "ready", we atomically confirm or cancel.
//    First to arrive wins. Idempotent — same answer on retry.
async function confirmOrCancel(tx, orderId, item, provider) {
  const winner = await tx.read(\`order:\${orderId}:\${item}:winner\`);
  if (winner === provider) return "CONFIRM";  // you already won
  if (winner)              return "CANCEL";   // someone else won
  tx.write(\`order:\${orderId}:\${item}:winner\`, provider);
  return "CONFIRM";  // you're first!
}

// 3. Fulfill the whole cart — every item races its providers.
//    All items must have a winner or the order waits.
await stm.atomic(ctx, async (tx) => {
  for (const item of cart) {
    await raceProviders(tx, orderId, item);
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
