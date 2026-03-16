import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState, useEffect, useRef, useCallback } from "react";

function useDebouncedCallback<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  const timer = useRef<ReturnType<typeof window.setTimeout>>();
  return useCallback((...args: any[]) => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => fn(...args), ms);
  }, [fn, ms]) as any;
}

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
    body: "All providers online, 0% failure. We race all capable providers simultaneously. First to accept wins.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: ALL_ON,
  },
  {
    title: "Printful always rejects",
    body: "Printful at 100% failure. Both Printful and Printify get the request, but Printful rejects. Printify wins by default.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: {
      printful: { online: true, rate: 100, timeout: 5000 },
      printify: { online: true, rate: 0, timeout: 5000 },
      gooten:   { online: true, rate: 0, timeout: 5000 },
    },
  },
  {
    title: "Full catalog",
    body: "Shirt + mug + poster. No single provider makes all three. All providers are raced per item. First to accept each item wins. The whole cart completes atomically.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: ALL_ON,
  },
  {
    title: "Printful offline",
    body: "Printful completely offline. Shirts can only come from Printify, mugs only from Gooten.",
    action: { type: "order" as const, items: ["shirt", "mug"] },
    setup: {
      printful: { online: false, rate: 0, timeout: 5000 },
      printify: { online: true, rate: 0, timeout: 5000 },
      gooten:   { online: true, rate: 0, timeout: 5000 },
    },
  },
  {
    title: "Chaos mode",
    body: "All providers: 60% failure. We race them all, but most reject. Watch the providers light up as they accept items one by one.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: {
      printful: { online: true, rate: 60, timeout: 5000 },
      printify: { online: true, rate: 60, timeout: 5000 },
      gooten:   { online: true, rate: 60, timeout: 5000 },
    },
  },
  {
    title: "The code",
    body: "Race all providers, first to accept wins. Atomic winner selection via one TVar write. Idempotent on retry. No double-ordering.",
    action: null,
    setup: ALL_ON,
  },
];

// ── Walkthrough ───────────────────────────────────────────────────────

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

  useEffect(() => {
    if (!applied) { applySetup(STEPS[0]); setApplied(true); }
  }, [applied]);

  const goTo = (i: number) => { applySetup(STEPS[i]); setStep(i); };

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
          <button className="walk-btn primary" onClick={() => onOrder(current.action!.items!)}>
            Order {current.action.items!.join(" + ")}
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

// ── Provider cards with emoji pop ─────────────────────────────────────

function ProviderCard({ name, info, onToggle, onSetRate, onSetTimeout }: {
  name: string;
  info: { available: boolean; products: string[]; failRate: number; timeout: number };
  onToggle: () => void;
  onSetRate: (rate: number) => void;
  onSetTimeout: (timeout: number) => void;
}) {
  const orders = useQuery(api.example.listOrders) ?? [];
  const [pops, setPops] = useState<{ id: number; emoji: string }[]>([]);
  const prevAttemptsRef = useRef<number>(0);

  // Local slider state for instant feedback
  const [localRate, setLocalRate] = useState(info.failRate);
  const [localMaxDelay, setLocalMaxDelay] = useState(info.maxDelay);
  useEffect(() => { setLocalRate(info.failRate); }, [info.failRate]);
  useEffect(() => { setLocalMaxDelay(info.maxDelay); }, [info.maxDelay]);

  const debouncedSetRate = useDebouncedCallback(onSetRate, 300);
  const debouncedSetTimeout = useDebouncedCallback(onSetTimeout, 300);

  // Watch for new "accepted" attempts → pop emoji
  useEffect(() => {
    const allAttempts = orders.flatMap((o) =>
      (o.attempts as any[]).filter(
        (a) => a.provider === name && a.result === "accepted",
      ),
    );
    if (allAttempts.length > prevAttemptsRef.current) {
      const newOnes = allAttempts.slice(prevAttemptsRef.current);
      for (const a of newOnes) {
        const emoji = PRODUCTS.find((p) => p.key === a.item)?.emoji ?? "?";
        const id = Date.now() + Math.random();
        setPops((prev) => [...prev, { id, emoji }]);
        window.setTimeout(() => setPops((prev) => prev.filter((p) => p.id !== id)), 1500);
      }
    }
    prevAttemptsRef.current = allAttempts.length;
  }, [orders, name]);

  return (
    <div className={`provider-card ${info.available ? "online" : "offline"}`} style={{ borderColor: info.available ? PROVIDER_COLORS[name] : "#333" }}>
      <div className="provider-top" onClick={onToggle}>
        <span className="provider-dot" style={{ background: info.available ? PROVIDER_COLORS[name] : "#555" }} />
        <span className="provider-name">{name}</span>
        <span className="provider-products">
          {info.products.map((pr) => PRODUCTS.find((x) => x.key === pr)?.emoji).join(" ")}
        </span>
        <span className="provider-status">{info.available ? "online" : "offline"}</span>
      </div>
      {info.available && (
        <div className="sliders">
          <div className="slider-row">
            <span className="slider-label">Fail</span>
            <input type="range" min={0} max={100} value={localRate}
              onChange={(e) => { const v = Number(e.target.value); setLocalRate(v); debouncedSetRate(v); }}
              style={{ accentColor: PROVIDER_COLORS[name] }} />
            <span className="slider-value">{localRate}%</span>
          </div>
          <div className="slider-row">
            <span className="slider-label">Max wait</span>
            <input type="range" min={500} max={10000} step={500} value={localMaxDelay}
              onChange={(e) => { const v = Number(e.target.value); setLocalMaxDelay(v); debouncedSetTimeout(v); }}
              style={{ accentColor: PROVIDER_COLORS[name] }} />
            <span className="slider-value">{(localMaxDelay / 1000).toFixed(1)}s</span>
          </div>
        </div>
      )}
      <div className="pop-container">
        {pops.map((p) => (
          <span key={p.id} className="pop-emoji">{p.emoji}</span>
        ))}
      </div>
    </div>
  );
}

function ProviderStatus() {
  const providers = useQuery(api.example.readProviders) ?? {};
  const toggle = useMutation(api.example.toggleProvider);
  const setSettings = useMutation(api.mockProviders.settings.set);

  return (
    <div className="providers">
      {Object.entries(providers).map(([name, info]) => (
        <ProviderCard
          key={name}
          name={name}
          info={info as any}
          onToggle={() => toggle({ provider: name })}
          onSetRate={(rate) => setSettings({ provider: name, failRate: rate })}
          onSetTimeout={(maxDelay) => setSettings({ provider: name, maxDelay })}
        />
      ))}
    </div>
  );
}

// ── Order form + feed ─────────────────────────────────────────────────

function OrderForm() {
  const placeOrder = useMutation(api.example.placeOrder);
  const [cart, setCart] = useState<Set<string>>(new Set(["shirt"]));
  const [timeout, setTimeout] = useState(false);
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
      <div className="timeout-row">
        <label className="timeout-toggle">
          <input type="checkbox" checked={timeout} onChange={(e) => setTimeout(e.target.checked)} />
          <span>3s order timeout</span>
        </label>
        <span className="timeout-hint">
          {timeout ? "Cancel entire order if not fulfilled in 3s" : "No deadline"}
        </span>
      </div>
      <button onClick={() => placeOrder({ items: [...cart], timeoutMs: timeout ? 3000 : undefined })} disabled={cart.size === 0}>
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
      {orders.map((o) => {
        const assignments = (o.assignments ?? {}) as Record<string, string>;
        const attempts = o.attempts as { item: string; provider: string; result: string }[];

        return (
          <div key={o._id} className={`order ${o.status}`}>
            <div className="order-header">
              <span className="order-dot" />
              <span className="order-status">{o.status}</span>
            </div>
            <div className="order-items">
              {o.items.map((item: string) => {
                const emoji = PRODUCTS.find((p) => p.key === item)?.emoji ?? "?";
                const winner = assignments[item];
                const itemAttempts = attempts.filter((a) => a.item === item);

                return (
                  <div key={item} className="order-item-row">
                    <span className="item-emoji">{emoji}</span>
                    <span className="item-name">{item}</span>
                    {winner ? (
                      <span className="item-winner" style={{ color: PROVIDER_COLORS[winner] }}>
                        {winner}
                      </span>
                    ) : (
                      <span className="item-waiting">waiting...</span>
                    )}
                    <span className="item-attempts">
                      {itemAttempts.map((a, i) => (
                        <span
                          key={i}
                          className={`attempt-dot ${a.result}`}
                          title={`${a.provider}: ${a.result}`}
                          style={{
                            background:
                              a.result === "confirmed" ? PROVIDER_COLORS[a.provider]
                              : a.result === "ready" ? PROVIDER_COLORS[a.provider] + "88"
                              : a.result === "accepted" ? PROVIDER_COLORS[a.provider]
                              : a.result === "canceled" ? "#555"
                              : "#ef4444",
                          }}
                        />
                      ))}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── App layout ────────────────────────────────────────────────────────

function App() {
  const setup = useMutation(api.example.setup);
  const placeOrder = useMutation(api.example.placeOrder);
  const setAvail = useMutation(api.example.setAvailable);
  const setSettings = useMutation(api.mockProviders.settings.set);

  return (
    <div className="app">
      <h1>Convex STM</h1>
      <p className="subtitle">Multi-item fulfillment &mdash; race providers, first to accept wins</p>

      <Walkthrough
        onOrder={(items) => placeOrder({ items })}
        onSetRate={(p, r) => setSettings({ provider: p, failRate: r })}
        onSetTimeout={(p, t) => setSettings({ provider: p, maxDelay: t })}
        onSetAvailable={(p, a) => setAvail({ provider: p, available: a })}
      />

      <div className="two-col">
        <div className="col-left">
          <OrderForm />
          <button className="reset-btn" onClick={() => setup({})}>Reset</button>
          <div className="panel code">
            <h2>The code</h2>
            <pre>{`// Readable helpers hide the plumbing
async function isProviderOnline(tx, provider) { ... }
async function getWinner(tx, orderId, item) { ... }
async function setWinner(tx, orderId, item, provider) { ... }
async function getProviderStatus(tx, orderId, item, provider) { ... }

// Fulfill a cart — submit all items to all providers at once
await stm.atomic(ctx, async (tx) => {
  for (const item of order.items) {
    if (await getWinner(tx, orderId, item)) continue;

    for (const p of providersFor(item)) {
      if (!await isProviderOnline(tx, p)) continue;
      if (!await getProviderStatus(tx, orderId, item, p))
        markSubmitted(tx, orderId, item, p);
    }
  }
});
// Each provider gets a fetch() call → processes → webhooks back.

// Provider says "I'm ready" — atomically pick a winner
async function confirmOrCancel(tx, orderId, item, provider) {
  const winner = await getWinner(tx, orderId, item);
  if (winner === provider) return "CONFIRM";  // you already won
  if (winner) return "CANCEL";                // too late
  await setWinner(tx, orderId, item, provider);
  return "CONFIRM";                           // you're first!
}
// Idempotent. Call it 10 times, same answer every time.`}</pre>
          </div>
        </div>
        <div className="col-right">
          <ProviderStatus />
          <OrderFeed />
        </div>
      </div>
    </div>
  );
}

export default App;
