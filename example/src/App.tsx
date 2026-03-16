import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState, useRef, useCallback, useEffect } from "react";

function useDebouncedCallback<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return useCallback((...args: any[]) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), ms);
  }, [fn, ms]) as unknown as T;
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

const PROVIDER_NAMES: Record<string, string> = {
  printful: "ThreadCraft",
  printify: "InkDrop",
  gooten: "PixelPress",
};

type ProviderCfg = { online: boolean; rate: number; maxDelay: number };
type SetupCfg = Record<string, ProviderCfg>;

const ALL_ON: SetupCfg = {
  printful: { online: true, rate: 0, maxDelay: 5000 },
  printify: { online: true, rate: 0, maxDelay: 5000 },
  gooten:   { online: true, rate: 0, maxDelay: 5000 },
};

const STEPS = [
  {
    title: "The setup",
    body: "Three print providers, each making different products. No single provider makes everything. The STM transaction figures out who makes what and races them all.",
    action: null,
    setup: ALL_ON,
  },
  {
    title: "retry \u2014 wait for what you need",
    body: "Order a shirt. The transaction reads each provider's status. If a provider hasn't responded yet, it calls retry() \u2014 \"I can't proceed, wake me when something changes.\" When the provider webhooks back, the TVar updates and the transaction re-runs automatically.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: ALL_ON,
  },
  {
    title: "select \u2014 try alternatives",
    body: "Printful now rejects everything. select() tries Printful, sees the rejection (retry), rolls back, tries Printify. First provider to accept wins. The caller doesn't need to know which provider worked.",
    action: { type: "order" as const, items: ["shirt"] },
    setup: {
      printful: { online: true, rate: 100, maxDelay: 5000 },
      printify: { online: true, rate: 0, maxDelay: 5000 },
      gooten:   { online: true, rate: 0, maxDelay: 5000 },
    },
  },
  {
    title: "Atomic composition \u2014 all or nothing",
    body: "All providers back to 0% failure. Shirt + mug + poster \u2014 no single provider makes all three. The transaction sources each item independently, but the whole cart is atomic. If one item can't be sourced, nothing ships.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: ALL_ON,
  },
  {
    title: "afterCommit \u2014 IO after the transaction",
    body: "The transaction can't call fetch() (Convex enforces this). Instead, afterCommit() schedules the provider API calls to run after the transaction commits. If the transaction retries, the callbacks are discarded \u2014 no wasted API calls.",
    action: { type: "order" as const, items: ["shirt", "mug"] },
    setup: {
      printful: { online: false, rate: 0, maxDelay: 5000 },
      printify: { online: true, rate: 0, maxDelay: 5000 },
      gooten:   { online: true, rate: 0, maxDelay: 5000 },
    },
  },
  {
    title: "Timeout \u2014 composable deadlines",
    body: "All providers at 100% failure \u2014 nothing will be accepted. The order has a 3s timeout. Watch it go pending \u2192 submitted \u2192 expired. The timeout composes with select and retry \u2014 it's not a separate mechanism.",
    action: { type: "order-with-timeout" as const, items: ["shirt"], timeoutMs: 3000 },
    setup: {
      printful: { online: true, rate: 100, maxDelay: 5000 },
      printify: { online: true, rate: 100, maxDelay: 5000 },
      gooten:   { online: true, rate: 100, maxDelay: 5000 },
    },
  },
  {
    title: "Chaos \u2014 it all composes",
    body: "60% failure across all providers. Orders bounce between providers, retrying and falling back. Despite the chaos, every order eventually ships \u2014 retry waits, select tries alternatives, afterCommit dispatches IO, timeout catches stragglers. All from the same composable primitives.",
    action: { type: "order" as const, items: ["shirt", "mug", "poster"] },
    setup: {
      printful: { online: true, rate: 60, maxDelay: 5000 },
      printify: { online: true, rate: 60, maxDelay: 5000 },
      gooten:   { online: true, rate: 60, maxDelay: 5000 },
    },
  },
];

// ── Walkthrough ───────────────────────────────────────────────────────

function Walkthrough({
  onOrder,
  onSetRate,
  onSetMaxDelay,
  onSetAvailable,
  onReset,
}: {
  onOrder: (items: string[], timeoutMs?: number) => void;
  onSetRate: (provider: string, rate: number) => void;
  onSetMaxDelay: (provider: string, maxDelay: number) => void;
  onSetAvailable: (provider: string, available: boolean) => void;
  onReset: () => void;
}) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];

  const applySetup = useCallback((s: (typeof STEPS)[number]) => {
    if (!s.setup) return;
    for (const [p, cfg] of Object.entries(s.setup)) {
      onSetAvailable(p, cfg.online);
      onSetRate(p, cfg.rate);
      onSetMaxDelay(p, cfg.maxDelay);
    }
  }, [onSetAvailable, onSetRate, onSetMaxDelay]);

  // Apply setup on mount (once) — using null ref pattern for lint
  const initializedRef = useRef<boolean | null>(null);
  if (initializedRef.current == null) {
    initializedRef.current = true;
    applySetup(STEPS[0]);
  }

  const goTo = (i: number) => {
    onReset(); // clear stuck orders from previous step
    applySetup(STEPS[i]);
    setStep(i);
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
          <button className="walk-btn primary" onClick={() => onOrder(
            current.action!.items!,
            "timeoutMs" in current.action! ? (current.action as any).timeoutMs : undefined,
          )}>
            Order {current.action.items!.join(" + ")}
            {"timeoutMs" in current.action ? " (3s timeout)" : ""}
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

// ── Provider cards ────────────────────────────────────────────────────

function ProviderCard({ name, info, onToggle, onSetRate, onSetMaxDelay }: {
  name: string;
  info: { online: boolean; products: string[]; failRate: number; maxDelay: number };
  onToggle: () => void;
  onSetRate: (rate: number) => void;
  onSetMaxDelay: (maxDelay: number) => void;
}) {
  const [localRate, setLocalRate] = useState(info.failRate);
  const [localMaxDelay, setLocalMaxDelay] = useState(info.maxDelay);
  // Sync from server when props change
  if (localRate !== info.failRate && !document.activeElement?.closest('.sliders')) {
    setLocalRate(info.failRate);
  }
  if (localMaxDelay !== info.maxDelay && !document.activeElement?.closest('.sliders')) {
    setLocalMaxDelay(info.maxDelay);
  }

  const debouncedSetRate = useDebouncedCallback(onSetRate, 300);
  const debouncedSetMaxDelay = useDebouncedCallback(onSetMaxDelay, 300);

  return (
    <div className={`provider-card ${info.online ? "online" : "offline"}`} style={{ borderColor: info.online ? PROVIDER_COLORS[name] : "#333" }}>
      <div className="provider-top" onClick={onToggle}>
        <span className="provider-dot" style={{ background: info.online ? PROVIDER_COLORS[name] : "#555" }} />
        <span className="provider-name">{PROVIDER_NAMES[name] ?? name}</span>
        <span className="provider-products">
          {info.products.map((pr) => PRODUCTS.find((x) => x.key === pr)?.emoji).join(" ")}
        </span>
        <span className="provider-status">{info.online ? "online" : "offline"}</span>
      </div>
      {info.online && (
        <div className="sliders">
          <div className="slider-group">
            <div className="slider-header">
              <span className="slider-label">Fail rate</span>
              <span className="slider-value">{localRate}%</span>
            </div>
            <input type="range" min={0} max={100} value={localRate}
              onChange={(e) => { const v = Number(e.target.value); setLocalRate(v); debouncedSetRate(v); }}
              style={{ accentColor: PROVIDER_COLORS[name] }} />
          </div>
          <div className="slider-group">
            <div className="slider-header">
              <span className="slider-label">Max wait</span>
              <span className="slider-value">{(localMaxDelay / 1000).toFixed(1)}s</span>
            </div>
            <input type="range" min={500} max={10000} step={500} value={localMaxDelay}
              onChange={(e) => { const v = Number(e.target.value); setLocalMaxDelay(v); debouncedSetMaxDelay(v); }}
              style={{ accentColor: PROVIDER_COLORS[name] }} />
          </div>
        </div>
      )}
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
          info={info as { online: boolean; products: string[]; failRate: number; maxDelay: number }}
          onToggle={() => toggle({ provider: name })}
          onSetRate={(rate) => setSettings({ provider: name, failRate: rate })}
          onSetMaxDelay={(maxDelay) => setSettings({ provider: name, maxDelay })}
        />
      ))}
    </div>
  );
}

// ── Order form + feed ─────────────────────────────────────────────────

function OrderForm() {
  const placeOrder = useMutation(api.example.placeOrder);
  const [cart, setCart] = useState<Set<string>>(new Set(["shirt"]));
  const [timeout, setTimeoutOn] = useState(false);
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
          <input type="checkbox" checked={timeout} onChange={(e) => setTimeoutOn(e.target.checked)} />
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
                        {PROVIDER_NAMES[winner] ?? winner}
                      </span>
                    ) : (
                      <span className="item-waiting">waiting...</span>
                    )}
                    <span className="item-attempts">
                      {itemAttempts.map((a, i) => (
                        <span
                          key={i}
                          className={`attempt-tag ${a.result}`}
                          title={
                            a.result === "accepted" ? `${PROVIDER_NAMES[a.provider] ?? a.provider}: accepted`
                            : a.result === "rejected" ? `${PROVIDER_NAMES[a.provider] ?? a.provider}: rejected`
                            : `${PROVIDER_NAMES[a.provider] ?? a.provider}: ${a.result}`
                          }
                        >
                          {PROVIDER_NAMES[a.provider] ?? a.provider}
                          {a.result === "accepted" ? " \u2713"
                           : a.result === "rejected" ? " \u2717"
                           : ""}
                        </span>
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

// ── Code block with syntax highlighting ───────────────────────────────

declare const Prism: { highlightAll: () => void } | undefined;

const CODE = `// ── CATALOG ─────────────────────────────────────
// Each provider makes different products.
// No single provider makes everything.
const CATALOG = {
  threadcraft: ["shirt", "mug"],
  inkdrop:     ["shirt", "poster"],
  pixelpress:  ["mug", "poster"],
};

// ── PHASE 1: SUBMIT ALL ────────────────────────
// One atomic transaction submits every item to
// every capable provider simultaneously.
// No IO here — just reads and writes to TVars.

await stm.atomic(ctx, async (tx) => {
  for (const item of order.items) {
    for (const provider of providersFor(item)) {

      // Read a TVar: is this provider online?
      const online = await tx.read(
        \`provider:\${provider}:online\`
      );
      if (!online) continue; // skip offline

      // Write a TVar: mark "submitted"
      tx.write(
        \`\${orderId}:\${item}:\${provider}\`,
        "submitted"
      );

      // afterCommit: schedule the fetch() call.
      // Only fires if the transaction commits.
      // Discarded on retry — no wasted API calls.
      tx.afterCommit(async (ctx) => {
        await ctx.scheduler.runAfter(
          0, submitToProvider,
          { orderId, item, provider }
        );
      });
    }
  }
});

// ── IO (outside the transaction) ───────────────
// Each action calls fetch() to a provider's API.
// The provider processes and webhooks us back.

const submitToProvider = action(async (ctx, args) => {
  await fetch(\`https://api.\${args.provider}.com/order\`, {
    method: "POST",
    body: JSON.stringify({
      item: args.item,
      callbackUrl: WEBHOOK_URL,
    }),
  });
});

// ── WEBHOOK ────────────────────────────────────
// Provider calls our webhook with the result.
// We write it to a TVar — this wakes the
// waiting transaction automatically.

http.route("/webhook/provider", async (ctx, req) => {
  const { orderId, item, provider, result } = await req.json();
  // One TVar write → wakes the blocked transaction
  await stm.atomic(ctx, async (tx) => {
    tx.write(\`\${orderId}:\${item}:\${provider}\`, result);
  });
});

// ── PHASE 2: WAIT FOR RESULTS ──────────────────
// Second transaction checks each item.
// select() tries providers in order per item.
// timeout: give up on slow providers.
// If ANY item has no winner, the whole transaction
// retries — re-runs when a TVar changes.

const result = await stm.atomic(ctx, async (tx) => {
  const winners = {};

  for (const item of order.items) {
    // select: try each provider for this item
    winners[item] = await tx.select(
      ...providersFor(item).map(provider => ({
        fn: async () => {
          // Read the TVar: did this provider respond?
          const status = await tx.read(
            \`\${orderId}:\${item}:\${provider}\`
          );
          if (status === "accepted") return provider;
          tx.retry(); // not yet — wait
        },
        timeout: 3000, // skip after 3s
      })),
    );
  }
  return winners;
}, {
  // Re-run when any watched TVar changes
  callbackHandle: retryFn,
  txId: \`order:\${orderId}\`, // stable across retries
});

// committed  → every item has a winner → ship it
// timedOut   → deadline passed → order expired
// All items or nothing. No partial fulfillment.`;

function CodeBlock() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ref.current && typeof Prism !== "undefined") {
      Prism.highlightAll();
    }
  }, []);

  return (
    <div className="panel code">
      <h2>The code</h2>
      <pre><code ref={ref} className="language-typescript">{CODE}</code></pre>
    </div>
  );
}

// ── Priority Queue Demo ───────────────────────────────────────────────

const QUEUE_COLORS: Record<string, string> = {
  critical: "#ef4444",
  normal: "#3b82f6",
  bulk: "#888",
};

const QUEUE_LABELS: Record<string, string> = {
  critical: "\uD83D\uDD34 Critical",
  normal: "\uD83D\uDD35 Normal",
  bulk: "\u26AA Bulk",
};

const JOB_NAMES = ["deploy", "backup", "report", "sync", "migrate", "audit", "notify", "index", "compress", "validate"];

function QueueDemo() {
  const queues = useQuery(api.queue.readQueues) ?? { critical: [], normal: [], bulk: [] };
  const processed = useQuery(api.queue.readProcessed) ?? [];
  const enqueueBatch = useMutation(api.queue.enqueueBatch);
  const dequeueBatch = useMutation(api.queue.dequeueBatch);
  const setupQ = useMutation(api.queue.setupQueues);

  const [producerRate, setProducerRate] = useState(5);
  const [consumerCount, setConsumerCount] = useState(1);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  const randomJob = () => JOB_NAMES[Math.floor(Math.random() * JOB_NAMES.length)];
  const randomQueue = () => ["critical", "normal", "normal", "bulk", "bulk", "bulk"][Math.floor(Math.random() * 6)];

  const schedule = (fn: () => void, ms: number) => {
    const id: number = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== id);
      fn();
    }, ms);
    timersRef.current.push(id);
  };

  const start = () => {
    setRunning(true);
    runningRef.current = true;

    // Producer: batch jobs per tick (~4 ticks/sec, batch size scales with rate)
    const producerTick = () => {
      if (!runningRef.current) return;
      const batchSize = Math.max(1, Math.ceil(producerRate / 4));
      const jobs = Array.from({ length: batchSize }, () => ({
        queue: randomQueue(), job: randomJob(),
      }));
      enqueueBatch({ jobs });
      schedule(producerTick, 250);
    };
    producerTick();

    // Consumer: batch dequeue per tick
    const consumerTick = () => {
      if (!runningRef.current) return;
      dequeueBatch({ count: consumerCount });
      schedule(consumerTick, 300);
    };
    consumerTick();
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    for (const id of timersRef.current) clearTimeout(id);
    timersRef.current = [];
  };

  const totalQueued = (queues.critical?.length ?? 0) + (queues.normal?.length ?? 0) + (queues.bulk?.length ?? 0);

  return (
    <div>
      <div className="queue-settings">
        <label>
          <span className="qs-label">Producers</span>
          <input type="range" min={1} max={50} value={producerRate}
            onChange={(e) => setProducerRate(Number(e.target.value))} />
          <span className="qs-value">{producerRate}/s</span>
        </label>
        <label>
          <span className="qs-label">Consumers</span>
          <input type="range" min={1} max={10} value={consumerCount}
            onChange={(e) => setConsumerCount(Number(e.target.value))} />
          <span className="qs-value">{consumerCount}</span>
        </label>
        <div className="queue-buttons">
          {running
            ? <button className="stop-btn" onClick={stop}>Stop</button>
            : <button onClick={start}>Start</button>
          }
          <button onClick={() => { stop(); setupQ({}); }}>Reset</button>
        </div>
      </div>

      <div className="queue-stats">
        <span>Queued: <strong>{totalQueued}</strong></span>
        <span>Processed: <strong>{processed.length}</strong></span>
      </div>

      <div className="queue-pipes">
        {(["critical", "normal", "bulk"] as const).map((q) => {
          const items = queues[q] ?? [];
          return (
            <div key={q} className="queue-pipe" style={{ borderColor: QUEUE_COLORS[q] }}>
              <div className="pipe-header">
                <span>{QUEUE_LABELS[q]}</span>
                <span className="pipe-count">{items.length}</span>
              </div>
              <div className="pipe-bar-track">
                <div className="pipe-bar-fill" style={{
                  width: `${Math.min(100, items.length * 2)}%`,
                  background: QUEUE_COLORS[q],
                }} />
              </div>
              <div className="pipe-items">
                {items.slice(0, 8).map((job, i) => (
                  <span key={i} className="pipe-item" style={{ background: QUEUE_COLORS[q] + "22", borderColor: QUEUE_COLORS[q] }}>
                    {job}
                  </span>
                ))}
                {items.length > 8 && <span className="pipe-overflow">+{items.length - 8} more</span>}
                {items.length === 0 && <span className="pipe-empty">empty</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="pipe-arrow">
        {"\u2193"} select(critical, normal, bulk) {"\u00D7"} {consumerCount} consumer{consumerCount > 1 ? "s" : ""}
      </div>

      <div className="processed">
        <h3>Recently processed</h3>
        <div className="processed-items">
          {processed.map((j: any) => (
            <span key={j._id} className="processed-item" style={{ borderColor: QUEUE_COLORS[j.queue] }}>
              {j.job}
              <span className="processed-queue" style={{ color: QUEUE_COLORS[j.queue] }}>{j.queue}</span>
            </span>
          ))}
          {processed.length === 0 && <span className="pipe-empty">none yet</span>}
        </div>
      </div>

      <div className="panel code">
        <h2>The code</h2>
        <pre><code className="language-typescript">{`// ── TVars as queues ─────────────────────────────
// Each queue is a TVar holding string[].
// Producers push, consumers shift. All transactional.

async function queuePush(tx, queue, job) {
  const items = await tx.read(\`queue:\${queue}\`) ?? [];
  tx.write(\`queue:\${queue}\`, [...items, job]);
}

async function queueShift(tx, queue) {
  const items = await tx.read(\`queue:\${queue}\`) ?? [];
  if (items.length === 0) tx.retry(); // ← blocks!
  tx.write(\`queue:\${queue}\`, items.slice(1));
  return items[0];
}

// ── Producer: push to any queue ─────────────────
await stm.atomic(ctx, async (tx) => {
  await queuePush(tx, "critical", "deploy-prod");
});

// ── Consumer: priority select ───────────────────
// Tries critical first. If empty, normal. Then bulk.
// If ALL empty, blocks until any queue gets a job.
// Multiple consumers can run this simultaneously —
// each dequeue is atomic, no double-processing.

await stm.atomic(ctx, async (tx) => {
  return await tx.select(
    async () => ({
      queue: "critical",
      job: await queueShift(tx, "critical"),
    }),
    async () => ({
      queue: "normal",
      job: await queueShift(tx, "normal"),
    }),
    async () => ({
      queue: "bulk",
      job: await queueShift(tx, "bulk"),
    }),
  );
});

// How it works:
// 1. select tries queueShift("critical")
// 2. queueShift reads the TVar → empty → retry()
// 3. select catches the retry, tries "normal"
// 4. queueShift reads → has items → returns first
// 5. Transaction commits: item removed atomically
//
// If all queues empty: retry() propagates up.
// The transaction suspends until ANY queue TVar
// changes — then re-runs from the top.`}</code></pre>
      </div>
    </div>
  );
}

// ── App layout ────────────────────────────────────────────────────────

function App() {
  const setup = useMutation(api.example.setup);
  const placeOrder = useMutation(api.example.placeOrder);
  const setAvail = useMutation(api.example.setAvailable);
  const setSettings = useMutation(api.mockProviders.settings.set);
  const [tab, setTab] = useState<"fulfillment" | "queue">("fulfillment");

  return (
    <div className="app">
      <h1>Convex STM</h1>

      <div className="tabs">
        <button className={`tab ${tab === "fulfillment" ? "active" : ""}`} onClick={() => setTab("fulfillment")}>
          Fulfillment
        </button>
        <button className={`tab ${tab === "queue" ? "active" : ""}`} onClick={() => setTab("queue")}>
          Priority Queue
        </button>
      </div>

      {tab === "fulfillment" ? (
        <>
          <div className="explainer">
            <h2>Multi-Provider Fulfillment</h2>
            <p>Order shirts, mugs, and posters from multiple print providers. No single provider makes everything.</p>
            <div className="primitive-cards">
              <div className="prim-card">
                <strong>retry</strong>
                <span>Each provider call waits for a webhook response. <code>retry()</code> suspends the transaction until the response TVar changes. No polling.</span>
              </div>
              <div className="prim-card">
                <strong>select</strong>
                <span>Multiple providers race per item. <code>select()</code> tries each — first to accept wins. Rejected providers are skipped automatically.</span>
              </div>
              <div className="prim-card">
                <strong>atomic</strong>
                <span>The whole cart is one transaction. If the poster can't be sourced, the shirt and mug don't ship either. All or nothing.</span>
              </div>
              <div className="prim-card">
                <strong>afterCommit</strong>
                <span>Provider API calls (fetch) are scheduled via <code>afterCommit()</code> — they only fire if the transaction commits. No wasted calls on retry.</span>
              </div>
              <div className="prim-card">
                <strong>timeout</strong>
                <span>Each <code>select()</code> branch can have a deadline. If a provider is too slow, it's skipped. If all time out, the order expires.</span>
              </div>
            </div>
          </div>
          <Walkthrough
            onOrder={(items, timeoutMs) => placeOrder({ items, timeoutMs })}
            onSetRate={(p, r) => setSettings({ provider: p, failRate: r })}
            onSetMaxDelay={(p, t) => setSettings({ provider: p, maxDelay: t })}
            onSetAvailable={(p, a) => setAvail({ provider: p, available: a })}
            onReset={() => setup({})}
          />
          <div className="two-col">
            <div className="col-left">
              <OrderForm />
              <button className="reset-btn" onClick={() => setup({})}>Reset</button>
              <CodeBlock />
            </div>
            <div className="col-right">
              <ProviderStatus />
              <OrderFeed />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="explainer">
            <h2>Priority Queue with TVars</h2>
            <p>Each queue is a <strong>TVar</strong> — a transactional variable holding an array. Producers push, consumers shift. The STM transaction coordinates everything.</p>
            <div className="primitive-cards">
              <div className="prim-card">
                <strong>TVar</strong>
                <span>Each queue is a TVar holding <code>string[]</code>. Reads and writes are transactional — no race conditions between concurrent producers and consumers.</span>
              </div>
              <div className="prim-card">
                <strong>retry</strong>
                <span><code>queueShift()</code> reads the TVar. If the array is empty, <code>retry()</code> blocks until a producer pushes something. No polling.</span>
              </div>
              <div className="prim-card">
                <strong>select</strong>
                <span><code>select(critical, normal, bulk)</code> tries each queue TVar in priority order. First non-empty wins. All empty? Blocks on all three TVars at once.</span>
              </div>
              <div className="prim-card">
                <strong>atomic</strong>
                <span>Each dequeue is one atomic transaction — only one consumer gets each job, even with 10 running concurrently. No double-processing.</span>
              </div>
            </div>
          </div>
          <QueueDemo />
        </>
      )}
    </div>
  );
}

export default App;
