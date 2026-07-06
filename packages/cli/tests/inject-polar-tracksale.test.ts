import { describe, expect, it } from "vitest";
import { getRecipe } from "@affitor/recipes";
import { injectPolarTrackSale } from "../src/lib/inject";

// The canonical Polar sale snippet, sourced from the recipe registry (the same
// thing `affitor onboard` injects). Body reads `order.*`.
const SALE_SNIPPET = getRecipe("next-app", "polar", "s2s").sale!.snippet;

const IMPORT_SPECIFIER = "@/lib/affitor";
const IMPORT_LINE = `import { affitor } from '${IMPORT_SPECIFIER}';`;

// A clean @polar-sh/nextjs webhook route — the only shape we auto-edit.
const CLEAN_HELPER_ROUTE = `import { Webhooks } from '@polar-sh/nextjs';

export const POST = Webhooks({
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
  onOrderPaid: async (payload) => {
    console.log('paid', payload.data.id);
  },
});
`;

describe("injectPolarTrackSale — injected (clean helper route)", () => {
  it("binds `const order = payload.data` and inserts trackSale inside onOrderPaid", () => {
    const r = injectPolarTrackSale(CLEAN_HELPER_ROUTE, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("injected");
    expect(r.content).toContain("const order = payload.data;");
    expect(r.content).toContain("await affitor.trackSale({");
    expect(r.content).toContain("Affitor: report the sale");

    // Binding lands inside the callback, before the existing body.
    const cbIdx = r.content.indexOf("onOrderPaid:");
    const bindIdx = r.content.indexOf("const order = payload.data;");
    const saleIdx = r.content.indexOf("await affitor.trackSale({");
    const existingIdx = r.content.indexOf("console.log('paid'");
    expect(cbIdx).toBeLessThan(bindIdx);
    expect(bindIdx).toBeLessThan(saleIdx);
    expect(saleIdx).toBeLessThan(existingIdx);

    // Indented one level deeper than the `onOrderPaid:` property (2 → 4 spaces).
    expect(r.content).toMatch(/\n {4}const order = payload\.data;/);
  });

  it("uses the callback's own parameter name for the binding", () => {
    const renamed = CLEAN_HELPER_ROUTE.replace(/payload/g, "evt");
    const r = injectPolarTrackSale(renamed, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("injected");
    expect(r.content).toContain("const order = evt.data;");
  });

  it("handles a typed parameter — (payload: OrderPaidPayload) => {", () => {
    const typed = CLEAN_HELPER_ROUTE.replace(
      "async (payload) =>",
      "async (payload: WebhookOrderPaidPayload) =>",
    );
    const r = injectPolarTrackSale(typed, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("injected");
    expect(r.content).toContain("const order = payload.data;");
  });

  it("adds the affitor client import when importSpecifier is given", () => {
    const r = injectPolarTrackSale(CLEAN_HELPER_ROUTE, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    });
    expect(r.status).toBe("injected");
    expect(r.content).toContain(IMPORT_LINE);
    expect(r.content.indexOf(IMPORT_LINE)).toBeLessThan(r.content.indexOf("await affitor.trackSale({"));
    expect(r.added[0]).toBe(IMPORT_LINE);
  });

  it("does not strip the original code", () => {
    const r = injectPolarTrackSale(CLEAN_HELPER_ROUTE, { saleSnippet: SALE_SNIPPET });
    expect(r.content).toContain("webhookSecret: process.env.POLAR_WEBHOOK_SECRET!");
    expect(r.content).toContain("console.log('paid', payload.data.id);");
  });
});

describe("injectPolarTrackSale — already (idempotent)", () => {
  it("is a no-op on a second run", () => {
    const once = injectPolarTrackSale(CLEAN_HELPER_ROUTE, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    }).content;
    const twice = injectPolarTrackSale(once, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    });
    expect(twice.status).toBe("already");
    expect(twice.content).toBe(once);
    expect(twice.added).toHaveLength(0);
    // Exactly one trackSale call and one import line survived.
    expect((twice.content.match(/affitor\.trackSale\(/g) ?? []).length).toBe(1);
  });

  it("treats an @affitor/sdk/server import as already-wired", () => {
    const withImport = `import { Affitor } from '@affitor/sdk/server';\n${CLEAN_HELPER_ROUTE}`;
    expect(injectPolarTrackSale(withImport, { saleSnippet: SALE_SNIPPET }).status).toBe("already");
  });
});

describe("injectPolarTrackSale — unrecognized (conservative, prints patch)", () => {
  it("bails on a raw validateEvent handler (not the helper factory)", () => {
    const raw = `import { validateEvent } from '@polar-sh/sdk/webhooks';
export async function POST(req) {
  const event = validateEvent(await req.text(), headers, secret);
  if (event.type === 'order.paid') handle(event.data);
}
`;
    const r = injectPolarTrackSale(raw, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("unrecognized");
    expect(r.content).toBe(raw);
  });

  it("bails when there is no onOrderPaid callback", () => {
    const noPaid = `import { Webhooks } from '@polar-sh/nextjs';
export const POST = Webhooks({
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
  onSubscriptionCreated: async (payload) => {},
});
`;
    expect(injectPolarTrackSale(noPaid, { saleSnippet: SALE_SNIPPET }).status).toBe("unrecognized");
  });

  it("bails when onOrderPaid appears more than once (ambiguous)", () => {
    const dup = CLEAN_HELPER_ROUTE + "\n// see onOrderPaid above\n";
    expect(injectPolarTrackSale(dup, { saleSnippet: SALE_SNIPPET }).status).toBe("unrecognized");
  });

  it("bails on a destructured callback parameter", () => {
    const destructured = CLEAN_HELPER_ROUTE.replace("async (payload) =>", "async ({ data }) =>");
    expect(injectPolarTrackSale(destructured, { saleSnippet: SALE_SNIPPET }).status).toBe(
      "unrecognized",
    );
  });

  it("bails on an expression-bodied callback (no block to insert into)", () => {
    const expr = `import { Webhooks } from '@polar-sh/nextjs';
export const POST = Webhooks({
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
  onOrderPaid: async (payload) => console.log(payload.data.id),
});
`;
    expect(injectPolarTrackSale(expr, { saleSnippet: SALE_SNIPPET }).status).toBe("unrecognized");
  });

  it("bails when the file already binds `const order` (would collide)", () => {
    const withOrder = CLEAN_HELPER_ROUTE.replace(
      "console.log('paid', payload.data.id);",
      "const order = payload.data;\n    console.log('paid', order.id);",
    );
    expect(injectPolarTrackSale(withOrder, { saleSnippet: SALE_SNIPPET }).status).toBe(
      "unrecognized",
    );
  });

  it("bails when the provided snippet is not a trackSale call", () => {
    const r = injectPolarTrackSale(CLEAN_HELPER_ROUTE, { saleSnippet: "console.log('nope');" });
    expect(r.status).toBe("unrecognized");
  });
});
